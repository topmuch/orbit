// POST /api/ai/summarize — Synthèse IA d'un contenu long
// ───────────────────────────────────────────────────────────────────────────
// Chaîne complète : auth → rate limit (10/min) → Zod → contenu (email de la
// base avec ownership OU texte libre) → micro-service IA (cache 10 min) →
// bornes → réponse { summary, originalLength, summaryLength, style }.
//
// Styles : bullet_points (défaut) | paragraph | key_points.
import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { summarizeSchema } from "@/lib/validators"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { summarizeContent, getLastAiProvider } from "@/lib/ai-provider"

export const runtime = "nodejs"
export const maxDuration = 60

/** Limite anti-abus : 10 synthèses par minute et par utilisateur. */
const RATE_LIMIT_MAX = 10

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const rl = rateLimit(`ai:summarize:${user.id}`, RATE_LIMIT_MAX, 60_000)
  if (!rl.ok) return tooManyRequests(rl)

  const parsed = summarizeSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: "Données invalides" }, { status: 400 })
  }
  const { emailId, content, style, maxLength } = parsed.data

  // ── Contenu : email de la base (ownership) OU texte libre ────────────────
  let text = content?.trim() ?? ""
  let sourceEmailId: string | undefined
  if (emailId) {
    const email = await db.emailLog.findFirst({ where: { id: emailId, userId: user.id } })
    if (!email) return NextResponse.json({ error: "Email introuvable" }, { status: 404 })
    // Objet + corps : l'objet porte souvent l'information essentielle.
    text = [email.subject, email.bodyText].filter(Boolean).join("\n\n")
    sourceEmailId = email.id
  }
  if (text.length < 200) {
    return NextResponse.json(
      { error: "Contenu trop court pour une synthèse (200 caractères minimum)" },
      { status: 400 }
    )
  }

  // ── Inférence (micro-service IA, cache 10 min → fallback SDK) ───────────
  const result = await summarizeContent({ content: text, style, maxLength })
  if (!result) {
    console.error(`[orbit:ai-summarize] provider=${getLastAiProvider()} → échec`)
    return NextResponse.json({ error: "La synthèse IA est momentanément indisponible" }, { status: 502 })
  }

  console.log(
    `[orbit:ai-summarize] provider=${getLastAiProvider()} → ${result.summaryLength}/${result.originalLength} mots (${result.style})`
  )

  return NextResponse.json({
    summary: {
      summary: result.summary,
      originalLength: result.originalLength,
      summaryLength: result.summaryLength,
      style: result.style,
    },
    ...(sourceEmailId ? { emailId: sourceEmailId } : {}),
  })
}
