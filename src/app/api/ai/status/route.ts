// GET /api/ai/status — État du micro-service IA (observabilité Prompt 5)
// Renvoie l'état du routeur d'inférence : micro-service joignable, provider
// actif (ollama | zai-fallback), modèle chargé. Sert la carte « IA locale »
// de la vue Réglages.
import { NextResponse } from "next/server"
import { getSessionUser } from "@/lib/auth"

export const runtime = "nodejs"

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const AI_SERVICE_URL = (process.env.AI_SERVICE_URL ?? "http://localhost:3031").replace(/\/+$/, "")
  try {
    const res = await fetch(`${AI_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) {
      const health = (await res.json()) as {
        provider?: string
        model?: string
        ollamaConfigured?: boolean
        ollamaReachable?: boolean
      }
      return NextResponse.json({
        serviceUp: true,
        provider: health.provider ?? "unknown",
        model: health.model ?? "llama3",
        ollamaConfigured: health.ollamaConfigured ?? false,
        ollamaReachable: health.ollamaReachable ?? false,
      })
    }
  } catch {
    // service injoignable — réponse dégradée ci-dessous
  }
  return NextResponse.json({
    serviceUp: false,
    provider: "nextjs-fallback",
    model: process.env.OLLAMA_MODEL ?? "llama3",
    ollamaConfigured: Boolean(process.env.OLLAMA_URL),
    ollamaReachable: false,
  })
}
