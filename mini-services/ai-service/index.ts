// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Micro-service IA (ai-service) · port 3031
// ───────────────────────────────────────────────────────────────────────────
// Équivalent sandbox du micro-service FastAPI décrit dans l'architecture
// cible (voir docker/ai-service/main.py pour la version production Docker).
//
// Contrat REST exposé (identique dans les deux déploiements) :
//   GET  /health        → { ok, provider, model, ollamaConfigured, uptimeSec }
//   POST /analyze-email → extraction d'événement depuis un email (JSON)
//   POST /chat          → assistant en streaming (text/plain)
//
// Routeur de providers :
//   1. Ollama (http://localhost:11434) si OLLAMA_URL est défini → IA 100 %
//      locale, aucune donnée ne quitte la machine (objectif Orbit).
//   2. Fallback z-ai-web-dev-sdk (fourni par la sandbox de développement).
//
// ⚠️ Le prompt d'extraction ci-dessous est dupliqué dans
//    src/lib/ai-prompts.ts (fallback côté Next.js) : les garder synchrones.
// ═══════════════════════════════════════════════════════════════════════════

import ZAI from "z-ai-web-dev-sdk"

const PORT = 3031
const startedAt = Date.now()

// ── Configuration (surchargeable via variables d'environnement) ────────────
const OLLAMA_URL = (process.env.OLLAMA_URL ?? "").replace(/\/+$/, "")
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3"
const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 90_000)

// Charge le .env du projet parent (Bun ne lit que le .env du dossier courant)
async function loadParentEnv() {
  const raw = await Bun.file("../../.env").text().catch(() => "")
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
    if (!m) continue
    const [, key, value] = m
    if (!(key in process.env)) process.env[key] = value.replace(/^["']|["']$/g, "")
  }
}
await loadParentEnv()

// ── Utilitaires ─────────────────────────────────────────────────────────────

/** Extraction tolérante d'un objet JSON dans une réponse LLM (fencing markdown, texte autour…). */
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

/** Date/heure lisible en français (le mini-service n'embarque pas date-fns). */
function formatFrLong(d: Date): string {
  const jours = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"]
  const mois = [
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre",
  ]
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${jours[d.getUTCDay()]} ${d.getUTCDate()} ${mois[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

// ── Provider 1 : Ollama (IA locale, prioritaire) ───────────────────────────

interface OllamaGenOptions {
  system: string
  prompt: string
  json?: boolean // force une sortie JSON valide côté Ollama (format: "json")
  stream?: boolean
}

/** Appelle POST {OLLAMA_URL}/api/generate. Retourne null si Ollama est absent/indisponible. */
async function ollamaGenerate(opts: OllamaGenOptions): Promise<Response | null> {
  if (!OLLAMA_URL) return null
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        system: opts.system,
        prompt: opts.prompt,
        format: opts.json ? "json" : undefined,
        stream: opts.stream ?? false,
        options: { temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    })
    return res.ok ? res : null
  } catch {
    // Ollama éteint, timeout, modèle absent… → on bascule sur le fallback.
    return null
  }
}

// ── Provider 2 : z-ai-web-dev-sdk (fallback sandbox) ───────────────────────

async function zaiComplete(system: string, user: string): Promise<string | null> {
  const zai = await ZAI.create()
  const completion = await zai.chat.completions.create({
    messages: [
      { role: "assistant", content: system },
      { role: "user", content: user },
    ],
    thinking: { type: "disabled" },
  })
  return completion?.choices?.[0]?.message?.content ?? null
}

async function zaiStream(system: string, messages: { role: string; content: string }[]) {
  const zai = await ZAI.create()
  return (await zai.chat.completions.create({
    messages: [{ role: "assistant", content: system }, ...messages],
    stream: true,
    thinking: { type: "disabled" },
  })) as ReadableStream<Uint8Array> | null
}

// ── Prompts (duplicata synchronisé de src/lib/ai-prompts.ts) ────────────────

function extractionSystemPrompt(now: Date, timezone: string): string {
  return [
    "Tu es le moteur d'extraction d'Orbit : tu analyses des emails pour y détecter des rendez-vous, événements, échéances ou réservations.",
    "Réponds STRICTEMENT en JSON valide, sans aucun texte autour, au format :",
    '{"isEvent": true|false, "title": "titre court", "description": "résumé 1-2 phrases", "startTime": "ISO 8601", "endTime": "ISO 8601", "durationMinutes": 60, "confidence": 0.9}',
    "Règles :",
    "- isEvent = true uniquement si l'email mentionne une date/heure concrète d'un événement à mettre à l'agenda.",
    "- startTime/endTime en ISO 8601 avec décalage horaire, résolus à partir de la date actuelle fournie.",
    "- Si l'heure n'est pas précisée, utilise 09:00.",
    "- confidence entre 0 et 1 selon ta certitude.",
    `- Date et heure actuelles : ${formatFrLong(now)} (ISO : ${now.toISOString()}). Fuseau de l'utilisateur : ${timezone} (UTC+0).`,
  ].join("\n")
}

// ── POST /analyze-email ─────────────────────────────────────────────────────

interface AnalyzeBody {
  subject?: string
  from?: string
  bodyText?: string
  now?: string // ISO — fourni par Next.js (horloge applicative cohérente)
  timezone?: string
}

async function handleAnalyzeEmail(body: AnalyzeBody): Promise<Response> {
  const subject = typeof body.subject === "string" ? body.subject : ""
  const from = typeof body.from === "string" ? body.from : ""
  const bodyText = typeof body.bodyText === "string" ? body.bodyText : ""
  if (!subject && !bodyText) {
    return Response.json({ error: "subject ou bodyText requis" }, { status: 400 })
  }
  const now = body.now && !Number.isNaN(Date.parse(body.now)) ? new Date(body.now) : new Date()
  const timezone = body.timezone ?? "Africa/Dakar"

  const system = extractionSystemPrompt(now, timezone)
  const user = [
    `Objet : ${subject}`,
    `De : ${from}`,
    "",
    "Corps de l'email :",
    bodyText.slice(0, 4000),
  ].join("\n")

  // 1) Ollama (mode JSON forcé) → 2) fallback SDK
  let content: string | null = null
  let provider = "ollama"
  const ollamaRes = await ollamaGenerate({ system, prompt: user, json: true })
  if (ollamaRes) {
    try {
      const data = (await ollamaRes.json()) as { response?: string }
      content = data.response ?? null
    } catch {
      content = null
    }
  }
  if (!content) {
    provider = "zai-fallback"
    content = await zaiComplete(system, user).catch(() => null)
  }
  if (!content) {
    return Response.json({ error: "Aucune réponse du moteur IA" }, { status: 502 })
  }

  const json = parseJsonLoose(content)
  if (!json) {
    return Response.json({ result: null, provider, message: "Réponse non exploitable" })
  }

  // Normalisation douce des champs (les bornes métier restent côté Next.js)
  const result = {
    isEvent: json.isEvent !== false,
    title: typeof json.title === "string" ? json.title.trim().slice(0, 120) : "",
    description: typeof json.description === "string" ? json.description.slice(0, 500) : "",
    startTime: typeof json.startTime === "string" ? json.startTime : "",
    endTime: typeof json.endTime === "string" ? json.endTime : "",
    durationMinutes: Number(json.durationMinutes) || 60,
    confidence: Number(json.confidence) || 0.5,
  }
  return Response.json({ result, provider })
}

// ── POST /chat (streaming text/plain) ──────────────────────────────────────

interface ChatBody {
  system?: string
  messages?: { role: string; content: string }[]
}

async function handleChat(body: ChatBody): Promise<Response> {
  const system =
    typeof body.system === "string" && body.system.trim()
      ? body.system
      : "Tu es Orbit, l'assistant personnel intelligent. Réponds en français, de façon concise et actionnable."
  const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : []
  if (messages.length === 0) {
    return Response.json({ error: "messages requis" }, { status: 400 })
  }

  const encoder = new TextEncoder()

  // 1) Ollama en streaming NDJSON ({"response": "token"} par ligne)
  const ollamaRes = await ollamaGenerate({
    system,
    prompt: messages.map((m) => m.content).join("\n\n"),
    stream: true,
  })
  if (ollamaRes?.body) {
    const upstream = ollamaRes.body
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const reader = upstream.getReader()
        const decoder = new TextDecoder()
        let buffer = ""
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split("\n")
            buffer = lines.pop() ?? ""
            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed) continue
              try {
                const data = JSON.parse(trimmed)
                if (typeof data.response === "string" && data.response) {
                  controller.enqueue(encoder.encode(data.response))
                }
              } catch {
                // ligne NDJSON incomplète — ignorée
              }
            }
          }
        } finally {
          controller.close()
          reader.releaseLock()
        }
      },
    })
    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Orbit-Provider": "ollama",
      },
    })
  }

  // 2) Fallback SDK (SSE amont → texte brut)
  const upstream = await zaiStream(system, messages).catch(() => null)
  if (!upstream) {
    return Response.json({ error: "Assistant indisponible" }, { status: 502 })
  }
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
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
  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "X-Orbit-Provider": "zai-fallback",
    },
  })
}

// ── Serveur (Bun.serve, hot-reload via `bun --hot`) ─────────────────────────

const server = Bun.serve({
  port: PORT,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname.replace(/\/+$/, "") || "/"

    // CORS permissif : ce service n'est appelé que côté serveur (Next.js),
    // mais on autorise le diagnostic direct depuis un navigateur local.
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    }
    if (req.method === "OPTIONS") return new Response(null, { headers: cors })

    if (path === "/health" && req.method === "GET") {
      let ollamaReachable = false
      if (OLLAMA_URL) {
        try {
          const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) })
          ollamaReachable = res.ok
        } catch {
          ollamaReachable = false
        }
      }
      return Response.json(
        {
          ok: true,
          service: "orbit-ai-service",
          provider: ollamaReachable ? "ollama" : "zai-fallback",
          model: OLLAMA_MODEL,
          ollamaConfigured: Boolean(OLLAMA_URL),
          ollamaReachable,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        },
        { headers: cors }
      )
    }

    if (path === "/analyze-email" && req.method === "POST") {
      let body: AnalyzeBody
      try {
        body = (await req.json()) as AnalyzeBody
      } catch {
        return Response.json({ error: "JSON invalide" }, { status: 400, headers: cors })
      }
      return handleAnalyzeEmail(body)
    }

    if (path === "/chat" && req.method === "POST") {
      let body: ChatBody
      try {
        body = (await req.json()) as ChatBody
      } catch {
        return Response.json({ error: "JSON invalide" }, { status: 400, headers: cors })
      }
      return handleChat(body)
    }

    return Response.json({ error: "Route inconnue", routes: ["/health", "/analyze-email", "/chat"] }, { status: 404, headers: cors })
  },
})

console.log(`[orbit:ai-service] démarré sur http://localhost:${server.port}`)
console.log(
  `[orbit:ai-service] Ollama ${OLLAMA_URL ? `configuré (${OLLAMA_URL}, modèle ${OLLAMA_MODEL})` : "non configuré → fallback z-ai-web-dev-sdk"}`
)
