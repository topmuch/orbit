// POST /api/events/import — Import iCalendar (.ics)
// ─────────────────────────────────────────────────────────────────────────────
// Accepte : multipart/form-data (champ « file » ou « ics ») OU JSON { ics: "…" }.
// Import IDEMPOTENT : les UID déjà connus (Event.externalId) sont ignorés.
// Cap : 1 Mo de fichier, 500 événements créés par import.

import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { toEventDto } from "@/lib/dto"
import { icsJsonSchema } from "@/lib/validators"
import { parseIcs } from "@/lib/ical"
import { sanitizeText, toJsonInput } from "@/lib/events-service"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"

export const runtime = "nodejs"

const MAX_BYTES = 1_000_000
const MAX_EVENTS = 500

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const rl = rateLimit(`events:import:${user.id}`, 20)
  if (!rl.ok) return tooManyRequests(rl)

  // ── Lecture du contenu .ics (multipart ou JSON) ────────────────────────────
  let icsText: string | null = null
  const contentType = req.headers.get("content-type") ?? ""

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null)
    const file = (form?.get("file") ?? form?.get("ics")) as File | null
    if (file) {
      if (file.size > MAX_BYTES) {
        return NextResponse.json({ error: "Fichier trop volumineux (1 Mo max)" }, { status: 413 })
      }
      icsText = await file.text()
    }
  } else {
    const parsed = icsJsonSchema.safeParse(await req.json().catch(() => null))
    if (parsed.success) icsText = parsed.data.ics
  }

  if (!icsText || !icsText.trim()) {
    return NextResponse.json({ error: "Aucun contenu iCal fourni" }, { status: 400 })
  }
  if (icsText.length > MAX_BYTES) {
    return NextResponse.json({ error: "Contenu trop volumineux (1 Mo max)" }, { status: 413 })
  }

  // ── Parse ──────────────────────────────────────────────────────────────────
  const { events: parsedEvents, warnings } = parseIcs(icsText)
  if (!parsedEvents.length) {
    return NextResponse.json(
      { error: "Aucun VEVENT valide trouvé dans ce fichier", warnings },
      { status: 400 }
    )
  }

  // ── Idempotence : UID déjà connus → ignorés ─────────────────────────────
  // Deux sources de correspondance :
  //   1. Event.externalId = UID (import précédent d'un fichier externe) ;
  //   2. UID « orbit-<id>@orbit.local » → l'id d'un événement existant
  //      (round-trip de notre propre export : aucune duplication).
  const uids = parsedEvents.map((e) => e.uid)
  const derivedIds = uids
    .map((u) => u.match(/^orbit-([a-z0-9]{20,})@orbit\.local$/)?.[1])
    .filter((x): x is string => Boolean(x))
  const known = await db.event.findMany({
    where: {
      userId: user.id,
      OR: [{ externalId: { in: uids } }, { id: { in: derivedIds } }],
    },
    select: { externalId: true, id: true },
  })
  const knownKeys = new Set<string>()
  for (const k of known) {
    if (k.externalId) knownKeys.add(k.externalId)
    knownKeys.add(`orbit-${k.id}@orbit.local`)
  }

  const toCreate = parsedEvents.filter((e) => !knownKeys.has(e.uid)).slice(0, MAX_EVENTS)
  const skipped = parsedEvents.length - toCreate.length

  // ── Création ───────────────────────────────────────────────────────────────
  const events: ReturnType<typeof toEventDto>[] = []
  for (const e of toCreate) {
    const created = await db.event.create({
      data: {
        userId: user.id,
        title: sanitizeText(e.title) || "Événement importé",
        description: e.description ? sanitizeText(e.description) || null : null,
        location: e.location ? sanitizeText(e.location) || null : null,
        startTime: e.start,
        endTime: e.end,
        allDay: e.allDay,
        timezone: e.timezone,
        color: e.color,
        recurrence: toJsonInput(e.recurrence),
        attendees: toJsonInput(e.attendees.length ? e.attendees : null),
        reminders: toJsonInput(e.reminders.length ? e.reminders : null),
        recurrenceExceptions: toJsonInput(e.exceptions.length ? e.exceptions : null),
        source: "import",
        externalId: e.uid,
        reminderLog: [],
      },
    })
    events.push(toEventDto(created))
  }

  return NextResponse.json({ imported: events.length, skipped, events, warnings }, { status: 201 })
}
