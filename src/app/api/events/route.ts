// GET/POST /api/events — Liste (plage + expansion des récurrences) + création
// ─────────────────────────────────────────────────────────────────────────────
// GET  ?start=ISO&end=ISO → événements chevauchant la plage, séries récurrentes
//      EXPANSÉES en occurrences virtuelles (id = master, isOccurrence = true).
//      Sans plage → comportement historique (masters uniquement).
//      Alias legacy : ?from=/?to= acceptés.
// POST EventCreateInput (Zod) → 201 { event, conflicts[] } — les conflits sont
//      un AVERTISSEMENT (chevauchement strict, séries incluses), pas un blocage.

import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { toEventDto } from "@/lib/dto"
import { eventCreateSchema } from "@/lib/validators"
import { clampRange } from "@/lib/calendar"
import { loadExpandedEvents, computeConflicts, sanitizeText, toJsonInput } from "@/lib/events-service"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { triggerWebhooks } from "@/lib/api/webhooks"

export async function GET(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const rl = rateLimit(`events:list:${user.id}`, 120)
  if (!rl.ok) return tooManyRequests(rl)

  const { searchParams } = new URL(req.url)
  const startParam = searchParams.get("start") ?? searchParams.get("from")
  const endParam = searchParams.get("end") ?? searchParams.get("to")

  // Mode plage : expansion des récurrences
  if (startParam || endParam) {
    const start = startParam ? new Date(startParam) : new Date()
    const end = endParam ? new Date(endParam) : new Date(start.getTime() + 86_400_000)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return NextResponse.json({ error: "Paramètres de plage invalides" }, { status: 400 })
    }
    if (end <= start) {
      return NextResponse.json({ error: "La fin de plage doit suivre le début" }, { status: 400 })
    }
    const range = clampRange(start, end)
    const events = await loadExpandedEvents(user.id, range.start, range.end)
    return NextResponse.json({ events })
  }

  // Mode historique (sans plage) : masters uniquement
  const events = await db.event.findMany({
    where: { userId: user.id },
    orderBy: { startTime: "asc" },
    take: 500,
  })
  return NextResponse.json({ events: events.map(toEventDto) })
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const rl = rateLimit(`events:create:${user.id}`, 60)
  if (!rl.ok) return tooManyRequests(rl)

  const parsed = eventCreateSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }
  const data = parsed.data

  const startTime = new Date(data.startTime)
  const endTime = new Date(data.endTime)
  if (endTime <= startTime) {
    return NextResponse.json(
      { error: "L'heure de fin doit être après l'heure de début" },
      { status: 400 }
    )
  }

  // Un rappel « 0 min » sur un événement toute la journée n'a pas de sens :
  // on force au minimum le début de journée (prévention d'un spam de push).
  const reminders =
    data.reminders && data.allDay
      ? data.reminders.filter((r) => r.minutes >= 60 || r.type === "email")
      : (data.reminders ?? null)

  // Conflits horaires (avertissement — la création n'est jamais bloquée)
  const conflicts = await computeConflicts(user.id, { start: startTime, end: endTime })

  const event = await db.event.create({
    data: {
      userId: user.id,
      title: sanitizeText(data.title),
      description: data.description ? sanitizeText(data.description) || null : null,
      location: data.location ? sanitizeText(data.location) || null : null,
      startTime,
      endTime,
      allDay: data.allDay,
      timezone: data.timezone,
      color: data.color ?? null,
      recurrence: toJsonInput(data.recurrence ?? null),
      attendees: toJsonInput(data.attendees ?? null),
      reminders: toJsonInput(reminders),
      source: data.source ?? "manual",
      externalId: data.externalId ?? null,
      reminderLog: [],
    },
  })

  // Webhook « event.created » — fire-and-forget, jamais bloquant.
  void triggerWebhooks(user.id, "event.created", toEventDto(event)).catch(() => {})

  return NextResponse.json({ event: toEventDto(event), conflicts }, { status: 201 })
}
