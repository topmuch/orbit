// POST /api/ai/analyze — Analyse un email et extrait un événement potentiel
// ───────────────────────────────────────────────────────────────────────────
// Chaîne complète : auth → email en base → appel du micro-service IA
// (src/lib/ai-provider.ts : Ollama → fallback SDK) → bornes de cohérence →
// suggestion sauvegardée sur l'email jusqu'à confirmation/refus.
import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { toEmailDto } from "@/lib/dto"
import { analyzeSchema } from "@/lib/validators"
import { extractEvent, getLastAiProvider, type ExtractedEvent } from "@/lib/ai-provider"
import type { EventSuggestion } from "@/lib/types"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"

export const runtime = "nodejs"
export const maxDuration = 60

/**
 * Applique les bornes métier au JSON extrait par l'IA :
 * dates valides, horizon -1 an / +2 ans, endTime cohérent, confiance 0..1.
 */
function suggestionFromExtracted(extracted: ExtractedEvent, now: Date): EventSuggestion | null {
  if (extracted.isEvent === false) return null
  const title = extracted.title?.trim() ?? ""
  if (!title) return null

  const startTimeMs = Date.parse(extracted.startTime ?? "")
  if (Number.isNaN(startTimeMs)) return null

  let endTimeMs: number
  const endTimeParsed = Date.parse(extracted.endTime ?? "")
  if (!Number.isNaN(endTimeParsed) && endTimeParsed > startTimeMs) {
    endTimeMs = endTimeParsed
  } else {
    const duration = extracted.durationMinutes || 60
    endTimeMs = startTimeMs + duration * 60_000
  }

  // Bornes de cohérence : entre 1 an dans le passé et 2 ans dans le futur
  const horizon = new Date(now.getTime() + 2 * 365 * 24 * 3600 * 1000).getTime()
  const past = new Date(now.getTime() - 365 * 24 * 3600 * 1000).getTime()
  if (startTimeMs > horizon || startTimeMs < past) return null

  const confidence = Math.min(1, Math.max(0, Number(extracted.confidence) || 0.5))

  return {
    title: title.slice(0, 120),
    description: (extracted.description ?? "").slice(0, 500),
    startTime: new Date(startTimeMs).toISOString(),
    endTime: new Date(endTimeMs).toISOString(),
    confidence,
    // Enrichi IA locale : lieu + participants détectés (le micro-service ne
    // renvoie que des adresses réellement citées dans l'email source).
    ...(extracted.location ? { location: extracted.location.slice(0, 200) } : {}),
    ...(Array.isArray(extracted.attendees) && extracted.attendees.length
      ? { attendees: extracted.attendees.slice(0, 10) }
      : {}),
  }
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  // Rate limit : 10 analyses d'email par minute et par utilisateur.
  const rl = rateLimit(`ai:analyze:${user.id}`, 10, 60_000)
  if (!rl.ok) return tooManyRequests(rl)

  const parsed = analyzeSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: "Données invalides" }, { status: 400 })
  }

  const email = await db.emailLog.findFirst({
    where: { id: parsed.data.emailId, userId: user.id },
  })
  if (!email) return NextResponse.json({ error: "Email introuvable" }, { status: 404 })

  const now = new Date()
  const extracted = await extractEvent({
    subject: email.subject,
    from: email.fromName
      ? `${email.fromName} <${email.fromAddress}>`
      : email.fromAddress,
    bodyText: email.bodyText,
    now,
    timezone: "Africa/Dakar",
  })

  const suggestion = extracted ? suggestionFromExtracted(extracted, now) : null
  console.log(`[orbit:ai-analyze] provider=${getLastAiProvider()} → ${suggestion ? "événement détecté" : "aucun événement"}`)

  if (!suggestion) {
    return NextResponse.json({
      suggestion: null,
      message: "Aucun événement détecté dans cet email.",
    })
  }

  const updated = await db.emailLog.update({
    where: { id: email.id },
    data: { suggestedEvent: suggestion },
  })

  return NextResponse.json({ suggestion, email: toEmailDto(updated) })
}
