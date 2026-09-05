// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Micro-service IA · routeur POST /chat (streaming)
// ───────────────────────────────────────────────────────────────────────────
// Assistant conversationnel en streaming text/plain :
//   - Ollama : flux NDJSON ({"response": "token"} par ligne) → texte brut
//   - Fallback SDK : flux SSE amont → texte brut
// Le prompt système (contexte agenda + tâches de l'utilisateur) est construit
// côté Next.js et transmis dans body.system ; chat.txt fournit le défaut.
// Pas de cache : chaque conversation est unique par nature.
// ═══════════════════════════════════════════════════════════════════════════

import { LIMITS } from "../config"
import { templates } from "../prompts"
import { ollamaGenerate, zaiStream } from "../services/llm"
import { sanitize } from "../utils"

export interface ChatBody {
  system?: string
  messages?: { role: string; content: string }[]
}

const STREAM_HEADERS = {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
} as const

export async function handleChat(body: ChatBody): Promise<Response> {
  const system =
    typeof body.system === "string" && body.system.trim()
      ? body.system.slice(0, 12_000)
      : templates.chat

  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => m && typeof m.content === "string" && m.content.trim())
    .slice(-12)
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: sanitize(m.content, LIMITS.chatMessage) }))

  if (messages.length === 0) {
    return Response.json({ error: "messages requis" }, { status: 400 })
  }

  const encoder = new TextEncoder()

  // ── 1) Ollama en streaming NDJSON → texte brut ───────────────────────────
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
      headers: { ...STREAM_HEADERS, "X-Orbit-Provider": "ollama" },
    })
  }

  // ── 2) Fallback SDK (SSE amont → texte brut) ─────────────────────────────
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
    headers: { ...STREAM_HEADERS, "X-Orbit-Provider": "zai-fallback" },
  })
}
