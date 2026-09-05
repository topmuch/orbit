// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Micro-service IA (ai-service) · port 3031
// ───────────────────────────────────────────────────────────────────────────
// Équivalent sandbox du micro-service FastAPI de production
// (docker/ai-service) — même contrat REST, mêmes prompts (prompts/*.txt).
//
// Contrat exposé :
//   GET  /health           → { ok, provider, model, ollama*, cache, uptimeSec }
//   POST /analyze-email    → extraction de rendez-vous depuis un email (JSON)
//   POST /suggest-priority → suggestion LOW/MEDIUM/HIGH/URGENT (JSON)
//   POST /summarize        → synthèse de contenu long (JSON)
//   POST /chat             → assistant conversationnel (streaming text/plain)
//
// Routeur de providers (src/services/llm.ts) :
//   1. Ollama (OLLAMA_URL) → IA 100 % locale, aucune donnée ne quitte la
//      machine (objectif Orbit). Cache mémoire 10 min pour les requêtes
//      identiques (src/cache.ts).
//   2. Fallback z-ai-web-dev-sdk (fourni par la sandbox de développement).
// ═══════════════════════════════════════════════════════════════════════════

// ⚠️ src/config.ts DOIT être le premier import : il charge le .env du projet
// parent avant que les constantes d'environnement ne soient figées.
import { OLLAMA_MODEL, OLLAMA_URL, PORT } from "./src/config"
import { cacheStats } from "./src/cache"
import { ollamaReachable } from "./src/services/llm"
import { handleAnalyzeEmail } from "./src/routers/analyze-email"
import { handleSuggestPriority } from "./src/routers/suggest-priority"
import { handleSummarize } from "./src/routers/summarize"
import { handleChat, type ChatBody } from "./src/routers/chat"
import type { AnalyzeEmailBody, SuggestPriorityBody, SummarizeBody } from "./src/models/schemas"

const startedAt = Date.now()

// CORS permissif : ce service n'est appelé que côté serveur (Next.js), mais
// on autorise le diagnostic direct depuis un navigateur local.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
} as const

/** Lit le corps JSON de la requête, 400 lisible si invalide. */
async function readJson<T>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T
  } catch {
    return null
  }
}

const server = Bun.serve({
  port: PORT,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname.replace(/\/+$/, "") || "/"

    if (req.method === "OPTIONS") return new Response(null, { headers: CORS })

    // ── GET /health ─────────────────────────────────────────────────────────
    if (path === "/health" && req.method === "GET") {
      const reachable = await ollamaReachable()
      return Response.json(
        {
          ok: true,
          service: "orbit-ai-service",
          provider: reachable ? "ollama" : "zai-fallback",
          model: OLLAMA_MODEL,
          ollamaConfigured: Boolean(OLLAMA_URL),
          ollamaReachable: reachable,
          cache: cacheStats(),
          endpoints: ["/health", "/analyze-email", "/suggest-priority", "/summarize", "/chat"],
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        },
        { headers: CORS }
      )
    }

    // ── POST /analyze-email ─────────────────────────────────────────────────
    if (path === "/analyze-email" && req.method === "POST") {
      const body = await readJson<AnalyzeEmailBody>(req)
      if (!body) return Response.json({ error: "JSON invalide" }, { status: 400, headers: CORS })
      return handleAnalyzeEmail(body)
    }

    // ── POST /suggest-priority ──────────────────────────────────────────────
    if (path === "/suggest-priority" && req.method === "POST") {
      const body = await readJson<SuggestPriorityBody>(req)
      if (!body) return Response.json({ error: "JSON invalide" }, { status: 400, headers: CORS })
      return handleSuggestPriority(body)
    }

    // ── POST /summarize ─────────────────────────────────────────────────────
    if (path === "/summarize" && req.method === "POST") {
      const body = await readJson<SummarizeBody>(req)
      if (!body) return Response.json({ error: "JSON invalide" }, { status: 400, headers: CORS })
      return handleSummarize(body)
    }

    // ── POST /chat (streaming) ──────────────────────────────────────────────
    if (path === "/chat" && req.method === "POST") {
      const body = await readJson<ChatBody>(req)
      if (!body) return Response.json({ error: "JSON invalide" }, { status: 400, headers: CORS })
      return handleChat(body)
    }

    return Response.json(
      {
        error: "Route inconnue",
        routes: ["/health", "/analyze-email", "/suggest-priority", "/summarize", "/chat"],
      },
      { status: 404, headers: CORS }
    )
  },
})

console.log(`[orbit:ai-service] démarré sur http://localhost:${server.port}`)
console.log(
  `[orbit:ai-service] Ollama ${OLLAMA_URL ? `configuré (${OLLAMA_URL}, modèle ${OLLAMA_MODEL})` : "non configuré → fallback z-ai-web-dev-sdk"}`
)
console.log(
  "[orbit:ai-service] endpoints : /health · /analyze-email · /suggest-priority · /summarize · /chat"
)
