// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Client du micro-service IA + fallbacks directs
// ───────────────────────────────────────────────────────────────────────────
// Architecture Prompt 5 (IA locale) :
//
//   [navigateur] ── /api/ai/* (Next.js : auth + contexte DB)
//                     └── ai-provider.ts
//                           ├── 1) POST http://localhost:3031  (micro-service)
//                           │       └── Ollama (llama3) → fallback SDK
//                           └── 2) si service injoignable → SDK direct
//                               (filet de sécurité, prompt identique)
//
// Ce module est le SEUL point de sortie vers l'IA : le remplacement du
// micro-service (ex. conteneur FastAPI dockerisé) ne demande aucun autre
// changement dans l'application.
// ═══════════════════════════════════════════════════════════════════════════

import ZAI from "z-ai-web-dev-sdk"
import { buildExtractionUserPrompt, extractionSystemPrompt } from "@/lib/ai-prompts"

const AI_SERVICE_URL = (process.env.AI_SERVICE_URL ?? "http://localhost:3031").replace(/\/+$/, "")
const SERVICE_TIMEOUT_MS = Number(process.env.AI_SERVICE_TIMEOUT_MS ?? 120_000)

/** Résultat normalisé de l'extraction (bornes métier appliquées ensuite par la route). */
export interface ExtractedEvent {
  isEvent: boolean
  title: string
  description: string
  startTime: string
  endTime: string
  durationMinutes: number
  confidence: number
}

/** Provider réellement utilisé pour la dernière requête (observabilité). */
let lastProvider = "unknown"
export function getLastAiProvider(): string {
  return lastProvider
}

/** Extraction tolérante d'un objet JSON dans une réponse LLM. */
function parseJsonLoose(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1))
    return parsed && typeof parsed === "object" ? parsed : null
  } catch {
    return null
  }
}

// ── Extraction d'événement ─────────────────────────────────────────────────

export interface AnalyzeEmailInput {
  subject: string
  from: string
  bodyText: string
  now: Date
  timezone?: string
}

/**
 * Analyse un email et retourne l'événement extrait (ou null si aucun /
 * non exploitable). Passe par le micro-service, avec fallback SDK direct.
 */
export async function extractEvent(input: AnalyzeEmailInput): Promise<ExtractedEvent | null> {
  const timezone = input.timezone ?? "Africa/Dakar"

  // 1) Micro-service IA
  try {
    const res = await fetch(`${AI_SERVICE_URL}/analyze-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: input.subject,
        from: input.from,
        bodyText: input.bodyText,
        now: input.now.toISOString(),
        timezone,
      }),
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    })
    if (res.ok) {
      const data = (await res.json()) as { result: ExtractedEvent | null; provider?: string }
      lastProvider = data.provider ?? "ai-service"
      return data.result ?? null
    }
  } catch {
    // Service injoignable / timeout → fallback ci-dessous.
  }

  // 2) Fallback direct (prompt identique au micro-service)
  lastProvider = "nextjs-fallback"
  try {
    const system = extractionSystemPrompt(input.now, timezone)
    const user = buildExtractionUserPrompt(input.subject, input.from, input.bodyText)
    const zai = await ZAI.create()
    const completion = await zai.chat.completions.create({
      messages: [
        { role: "assistant", content: system },
        { role: "user", content: user },
      ],
      thinking: { type: "disabled" },
    })
    const content: string | undefined = completion?.choices?.[0]?.message?.content
    if (!content) return null
    const json = parseJsonLoose(content)
    if (!json) return null
    return {
      isEvent: json.isEvent !== false,
      title: typeof json.title === "string" ? json.title.trim().slice(0, 120) : "",
      description: typeof json.description === "string" ? json.description.slice(0, 500) : "",
      startTime: typeof json.startTime === "string" ? json.startTime : "",
      endTime: typeof json.endTime === "string" ? json.endTime : "",
      durationMinutes: Number(json.durationMinutes) || 60,
      confidence: Number(json.confidence) || 0.5,
    }
  } catch (error) {
    console.error("[orbit:ai-provider:extract]", error)
    return null
  }
}

// ── Assistant en streaming ─────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant"
  content: string
}

/**
 * Retourne un flux texte (text/plain) de l'assistant. Passe par le
 * micro-service (déjà transformé en texte), avec fallback SDK direct
 * (SSE amont → texte brut) si le service est injoignable.
 */
export async function chatCompletionStream(
  system: string,
  messages: ChatMessage[]
): Promise<ReadableStream<Uint8Array> | null> {
  // 1) Micro-service IA — renvoie déjà un flux texte
  try {
    const res = await fetch(`${AI_SERVICE_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ system, messages }),
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    })
    if (res.ok && res.body) {
      lastProvider = res.headers.get("X-Orbit-Provider") ?? "ai-service"
      return res.body
    }
  } catch {
    // Service injoignable / timeout → fallback ci-dessous.
  }

  // 2) Fallback direct : SSE amont → texte brut
  lastProvider = "nextjs-fallback"
  try {
    const zai = await ZAI.create()
    const upstream = (await zai.chat.completions.create({
      messages: [{ role: "assistant", content: system }, ...messages],
      stream: true,
      thinking: { type: "disabled" },
    })) as ReadableStream<Uint8Array> | null
    if (!upstream) return null

    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    let buffer = ""
    return new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = upstream.getReader()
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split("\n")
            buffer = lines.pop() ?? ""
            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed.startsWith("data:")) continue
              const payload = trimmed.slice(5).trim()
              if (!payload || payload === "[DONE]") continue
              try {
                const json = JSON.parse(payload)
                const delta: string | undefined = json.choices?.[0]?.delta?.content
                if (delta) controller.enqueue(encoder.encode(delta))
              } catch {
                // chunk non JSON — ignoré
              }
            }
          }
        } finally {
          controller.close()
          reader.releaseLock()
        }
      },
    })
  } catch (error) {
    console.error("[orbit:ai-provider:chat]", error)
    return null
  }
}
