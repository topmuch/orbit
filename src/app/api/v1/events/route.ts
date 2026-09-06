// GET/POST /api/v1/events — API publique (clé API, sans session)
// ─────────────────────────────────────────────────────────────────────────────
// GET  : ?start=ISO&end=ISO → plage + expansion des récurrences (séries incluses)
//        ; sans plage → masters uniquement (take 500). Réponse { events }.
// POST : même contrat que /api/events (eventCreateSchema, conflits = avertissement)
//        → 201 { event, conflicts } + webhook « event.created ».

import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { toEventDto } from "@/lib/dto"
import { eventCreateSchema } from "@/lib/validators"
import { clampRange } from "@/lib/calendar"
import { loadExpandedEvents, computeConflicts, sanitizeText, toJsonInput } from "@/lib/events-service"
import { rateLimit } from "@/lib/rate-limit"
import { verifyApiKey, v1Unauthorized, v1TooMany, V1_RATE_LIMIT } from "@/lib/api/auth"
import { triggerWebhooks } from "@/lib/api/webhooks"

export async function GET(req: NextRequest) {
  const auth = await verifyApiKey(req)
  if (!auth) return v1Unauthorized()

  const rl = rateLimit(`v1:${auth.keyId}`, V1_RATE_LIMIT)
  if (!rl.ok) return v1TooMany(rl.retryAfterSec)

  const { searchParams } = new URL(req.url)
  const startParam = searchParams.get("start")
  const endParam = searchParams.get("end")

  // Mode plage : expansion des récurrences
  if (startParam || endParam) {
    const start = startParam ? new Date(startParam) : new Date()
    const end = endParam ? new Date(endParam) : new Date(start.getTime() + 86_400_000)
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return NextResponse.json({ error: "Invalid range parameters" }, { status: 400 })
    }
    if (end <= start) {
      return NextResponse.json({ error: "Range end must be after range start" }, { status: 400 })
    }
    const range = clampRange(start, end)
    const events = await loadExpandedEvents(auth.userId, range.start, range.end)
    return NextResponse.json({ events })
  }

  // Mode liste : masters uniquement (plafond de garde)
  const events = await db.event.findMany({
    where: { userId: auth.userId },
    orderBy: { startTime: "asc" },
    take: 500,
  })
  return NextResponse.json({ events: events.map(toEventDto) })
}

export async function POST(req: NextRequest) {
  const auth = await verifyApiKey(req)
  if (!auth) return v1Unauthorized()

  const rl = rateLimit(`v1:${auth.keyId}`, V1_RATE_LIMIT)
  if (!rl.ok) return v1TooMany(rl.retryAfterSec)

  const parsed = eventCreateSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid payload" },
      { status: 400 }
    )
  }
  const data = parsed.data

  const startTime = new Date(data.startTime)
  const endTime = new Date(data.endTime)
  if (endTime <= startTime) {
    return NextResponse.json(
      { error: "End time must be after start time" },
      { status: 400 }
    )
  }

  // Rappel « 0 min » sur événement toute la journée → minimum début de journée
  // (même garde anti-spam push que /api/events).
  const reminders =
    data.reminders && data.allDay
      ? data.reminders.filter((r) => r.minutes >= 60 || r.type === "email")
      : (data.reminders ?? null)

  // Conflits horaires : AVERTISSEMENT, jamais un blocage
  const conflicts = await computeConflicts(auth.userId, { start: startTime, end: endTime })

  const event = await db.event.create({
    data: {
      userId: auth.userId,
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

  // Webhook « event.created » — non bloquant.
  void triggerWebhooks(auth.userId, "event.created", toEventDto(event)).catch(() => {})

  return NextResponse.json({ event: toEventDto(event), conflicts }, { status: 201 })
}
