// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Client du micro-service IA + fallbacks directs
// ───────────────────────────────────────────────────────────────────────────
// Architecture IA locale :
//
//   [navigateur] ── /api/ai/* (Next.js : auth + contexte DB + rate limit)
//                     └── ai-provider.ts
//                           ├── 1) POST http://localhost:3031  (micro-service)
//                           │       └── Ollama (llama3.1:8b) → fallback SDK
//                           │           (cache mémoire, JSON robuste)
//                           └── 2) si service injoignable → SDK direct
//                               (filet de sécurité, prompts identiques)
//
// Ce module est le SEUL point de sortie vers l'IA : le remplacement du
// micro-service (ex. conteneur FastAPI dockerisé) ne demande aucun autre
// changement dans l'application.
// ═══════════════════════════════════════════════════════════════════════════

import ZAI from "z-ai-web-dev-sdk"
import {
  buildExtractionUserPrompt,
  buildPriorityUserPrompt,
  buildSummarizeUserPrompt,
  extractionSystemPrompt,
  prioritySuggestionSystemPrompt,
  summarizationSystemPrompt,
} from "@/lib/ai-prompts"

const AI_SERVICE_URL = (process.env.AI_SERVICE_URL ?? "http://localhost:3031").replace(/\/+$/, "")
const SERVICE_TIMEOUT_MS = Number(process.env.AI_SERVICE_TIMEOUT_MS ?? 120_000)

const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const
type Priority = (typeof PRIORITIES)[number]

const STYLES = ["bullet_points", "paragraph", "key_points"] as const
type SummaryStyle = (typeof STYLES)[number]

// ── Types de résultats normalisés ──────────────────────────────────────────

/** Résultat normalisé de l'extraction (bornes métier appliquées ensuite par la route). */
export interface ExtractedEvent {
  isEvent: boolean
  title: string
  description: string
  startTime: string
  endTime: string
  durationMinutes: number
  location: string | null
  attendees: string[]
  confidence: number
}

/** Suggestion de priorité normalisée. */
export interface PrioritySuggestion {
  priority: Priority
  confidence: number
  reasoning: string
}

/** Synthèse de contenu normalisée. */
export interface ContentSummary {
  summary: string
  originalLength: number
  summaryLength: number
  style: SummaryStyle
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
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Nombre de mots (comptage simple). */
function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length
}

/** Complétion SDK directe (fallback Next.js) — rôle system pour la discipline de format. */
async function zaiComplete(system: string, user: string): Promise<string | null> {
  const zai = await ZAI.create()
  const completion = await zai.chat.completions.create({
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    thinking: { type: "disabled" },
  })
  return completion?.choices?.[0]?.message?.content ?? null
}

/** Appel générique au micro-service IA (POST JSON). Retourne null si injoignable. */
async function callService<T>(path: string, body: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await fetch(`${AI_SERVICE_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SERVICE_TIMEOUT_MS),
    })
    if (res.ok) {
      const data = (await res.json()) as { provider?: string } & T
      lastProvider = data.provider ?? "ai-service"
      return data
    }
  } catch {
    // Service injoignable / timeout → fallback ci-dessous.
  }
  return null
}

// ── Extraction d'événement (emails) ────────────────────────────────────────

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
  const data = await callService<{ result: ExtractedEvent | null }>("/analyze-email", {
    subject: input.subject,
    from: input.from,
    bodyText: input.bodyText,
    now: input.now.toISOString(),
    timezone,
  })
  if (data && data.result !== undefined) return data.result ?? null

  // 2) Fallback direct (prompt identique au micro-service)
  lastProvider = "nextjs-fallback"
  try {
    const system = extractionSystemPrompt(input.now, timezone)
    const user = buildExtractionUserPrompt(input.subject, input.from, input.bodyText)
    const content = await zaiComplete(system, user)
    if (!content) return null
    const json = parseJsonLoose(content)
    if (!json) return null
    const attendees = (Array.isArray(json.attendees) ? json.attendees : [])
      .filter((a): a is string => typeof a === "string")
      .map((a) => a.trim().slice(0, 254))
      .filter((a) => a.includes("@"))
      .slice(0, 10)
    return {
      isEvent: json.isEvent !== false,
      title: typeof json.title === "string" ? json.title.trim().slice(0, 120) : "",
      description: typeof json.description === "string" ? json.description.slice(0, 500) : "",
      startTime: typeof json.startTime === "string" ? json.startTime : "",
      endTime: typeof json.endTime === "string" ? json.endTime : "",
      durationMinutes: Number(json.durationMinutes) || 60,
      location:
        typeof json.location === "string" && json.location.trim()
          ? json.location.trim().slice(0, 200)
          : null,
      attendees,
      confidence: Math.min(1, Math.max(0, Number(json.confidence) || 0.5)),
    }
  } catch (error) {
    console.error("[orbit:ai-provider:extract]", error)
    return null
  }
}

// ── Suggestion de priorité (tâches) ────────────────────────────────────────

export interface SuggestPriorityInput {
  title: string
  description?: string | null
  dueDate?: string | null
  userContext: { totalTasks: number; urgentTasks: number; overdueTasks: number }
}

/** Normalise/valide une priorité renvoyée par l'IA (null si invalide). */
function normalizePriority(raw: unknown): Priority | null {
  const p = typeof raw === "string" ? raw.toUpperCase() : ""
  return (PRIORITIES as readonly string[]).includes(p) ? (p as Priority) : null
}

/**
 * Suggère une priorité pour une tâche. Passe par le micro-service
 * (/suggest-priority), avec fallback SDK direct. La persistance sur la tâche
 * (aiSuggestedPriority/aiConfidence) est faite par la route, pas ici.
 */
export async function suggestTaskPriority(input: SuggestPriorityInput): Promise<PrioritySuggestion | null> {
  const now = new Date()

  // 1) Micro-service IA — réponse brute : { result: { suggestedPriority,
  //    confidence, reasoning } | null, provider } (cf. mini-service/FastAPI).
  const data = await callService<{
    result: { suggestedPriority: string; confidence: number; reasoning: string } | null
  }>("/suggest-priority", {
    taskTitle: input.title,
    taskDescription: input.description ?? "",
    dueDate: input.dueDate ?? null,
    userContext: input.userContext,
    now: now.toISOString(),
    timezone: "Africa/Dakar",
  })
  if (data && data.result) {
    const priority = normalizePriority(data.result.suggestedPriority)
    if (priority) {
      return {
        priority,
        confidence: Math.min(1, Math.max(0, Number(data.result.confidence) || 0.5)),
        reasoning: String(data.result.reasoning ?? "").slice(0, 200),
      }
    }
    return null
  }

  // 2) Fallback direct
  lastProvider = "nextjs-fallback"
  try {
    const system = prioritySuggestionSystemPrompt(now, "Africa/Dakar")
    const user = buildPriorityUserPrompt({
      title: input.title,
      description: input.description,
      dueDate: input.dueDate,
      userContext: input.userContext,
    })
    const content = await zaiComplete(system, user)
    if (!content) return null
    const json = parseJsonLoose(content)
    const priority = normalizePriority(json?.suggestedPriority)
    if (!json || !priority) return null
    return {
      priority,
      confidence: Math.min(1, Math.max(0, Number(json.confidence) || 0.5)),
      reasoning: typeof json.reasoning === "string" ? json.reasoning.trim().slice(0, 200) : "",
    }
  } catch (error) {
    console.error("[orbit:ai-provider:priority]", error)
    return null
  }
}

// ── Synthèse de contenu ────────────────────────────────────────────────────

export interface SummarizeInput {
  content: string
  style?: SummaryStyle
  maxLength?: number
}

/**
 * Synthétise un contenu long (email, description de tâche…). Passe par le
 * micro-service (/summarize), avec fallback SDK direct.
 */
export async function summarizeContent(input: SummarizeInput): Promise<ContentSummary | null> {
  const now = new Date()
  const style: SummaryStyle = (STYLES as readonly string[]).includes(input.style ?? "")
    ? (input.style as SummaryStyle)
    : "bullet_points"
  const maxLength = Math.min(600, Math.max(30, Math.round(input.maxLength ?? 150)))
  const content = input.content.trim().slice(0, 12_000)

  // 1) Micro-service IA
  const data = await callService<{ result: ContentSummary | null }>("/summarize", {
    content,
    style,
    maxLength,
    now: now.toISOString(),
  })
  if (data && data.result?.summary) {
    return {
      summary: String(data.result.summary),
      originalLength: Number(data.result.originalLength) || countWords(content),
      summaryLength: Number(data.result.summaryLength) || countWords(data.result.summary),
      style,
    }
  }

  // 2) Fallback direct
  lastProvider = "nextjs-fallback"
  try {
    const system = summarizationSystemPrompt(style, maxLength, now)
    const user = buildSummarizeUserPrompt(content, now)
    const raw = await zaiComplete(system, user)
    if (!raw) return null
    // JSON strict attendu ; en cas de prose, le texte EST le résumé.
    const json = parseJsonLoose(raw)
    const summary = (
      typeof json?.summary === "string" && json.summary.trim()
        ? json.summary.trim()
        : raw
            .replace(/^```(?:json|text)?\s*/i, "")
            .replace(/```\s*$/, "")
            .trim()
    ).slice(0, maxLength * 8)
    if (!summary) return null
    return { summary, originalLength: countWords(content), summaryLength: countWords(summary), style }
  } catch (error) {
    console.error("[orbit:ai-provider:summarize]", error)
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
      messages: [{ role: "system", content: system }, ...messages],
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
