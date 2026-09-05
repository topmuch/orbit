// GET /api/events/export — Export iCalendar (.ics)
// ─────────────────────────────────────────────────────────────────────────────
// ?start=ISO&end=ISO (optionnel) : n'exporte que les événements ayant au moins
// une occurrence dans la plage. Sans plage : tout l'agenda.
// Les séries récurrentes sont exportées AVEC leur RRULE (+ EXDATE des
// exceptions) — le calendrier destinataire régénère les occurrences lui-même.
// Réponse : text/calendar, pièce jointe « orbit-YYYYMMDD.ics ».

import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { parseRecurrence, parseAttendees, parseReminders, parseStringArray } from "@/lib/dto"
import { buildIcs, type IcsExportEvent } from "@/lib/ical"
import { clampRange, expandEvent } from "@/lib/calendar"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"

export const runtime = "nodejs"

function toIcsExportEvent(e: {
  id: string
  externalId: string | null
  title: string
  description: string | null
  location: string | null
  startTime: Date
  endTime: Date
  allDay: boolean
  timezone: string
  color: string | null
  recurrence: unknown
  recurrenceExceptions: unknown
  attendees: unknown
  reminders: unknown
  updatedAt: Date
}): IcsExportEvent {
  return {
    id: e.id,
    uid: e.externalId ?? `orbit-${e.id}@orbit.local`,
    title: e.title,
    description: e.description,
    location: e.location,
    start: e.startTime,
    end: e.endTime,
    allDay: e.allDay,
    timezone: e.timezone || "UTC",
    color: e.color,
    recurrence: parseRecurrence(e.recurrence),
    exceptions: parseStringArray(e.recurrenceExceptions) ?? [],
    attendees: parseAttendees(e.attendees),
    reminders: parseReminders(e.reminders),
    updatedAt: e.updatedAt,
  }
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const rl = rateLimit(`events:export:${user.id}`, 30)
  if (!rl.ok) return tooManyRequests(rl)

  const { searchParams } = new URL(req.url)
  const startParam = searchParams.get("start")
  const endParam = searchParams.get("end")

  let masters = await db.event.findMany({
    where: { userId: user.id },
    orderBy: { startTime: "asc" },
    take: 2000,
  })

  // Filtre par plage : au moins une occurrence dans la fenêtre
  if (startParam && endParam) {
    const start = new Date(startParam)
    const end = new Date(endParam)
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end > start) {
      const range = clampRange(start, end)
      masters = masters.filter((e) =>
        expandEvent(
          {
            startTime: e.startTime,
            endTime: e.endTime,
            allDay: e.allDay,
            timezone: e.timezone,
            recurrence: parseRecurrence(e.recurrence),
            recurrenceExceptions: e.recurrenceExceptions,
          },
          range.start,
          range.end,
          1 // existence suffit
        ).length > 0
      )
    }
  }

  const ics = buildIcs(masters.map(toIcsExportEvent), "Orbit")

  const today = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  return new NextResponse(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="orbit-${today}.ics"`,
      "Cache-Control": "no-store",
    },
  })
}
