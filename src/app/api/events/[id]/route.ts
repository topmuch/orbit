// PATCH/DELETE /api/events/[id] — Édition/suppression, série ou occurrence
// ─────────────────────────────────────────────────────────────────────────────
// PATCH  body EventUpdateInput + { scope?: "single" | "series", occurrenceStart? }
//        • scope "series" (défaut) : met à jour le master (toute la série).
//          Toute modification d'heure/rappels réinitialise les rappels déjà envoyés.
//        • scope "single" (séries récurrentes uniquement) : détache l'occurrence —
//          l'occurrence d'origine devient une EXCEPTION de la série et un nouvel
//          événement indépendant est créé avec les valeurs soumises.
//        Réponse : { event, master?, conflicts? }
// DELETE ?scope=single&occurrenceStart=ISO → ajoute une exception à la série
//         (le master survit) ; sinon supprime l'événement/la série entière.
//         Réponse : { ok: true, master? }

import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { toEventDto } from "@/lib/dto"
import { eventUpdateSchema } from "@/lib/validators"
import { computeConflicts, sanitizeText, appendException, isOccurrenceOfSeries, toJsonInput } from "@/lib/events-service"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { recordTombstone } from "@/lib/sync-tombstones"
import { triggerWebhooks } from "@/lib/api/webhooks"
import type { Event } from "@prisma/client"

type Params = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  const { id } = await params

  const rl = rateLimit(`events:update:${user.id}`, 60)
  if (!rl.ok) return tooManyRequests(rl)

  const existing = await db.event.findFirst({ where: { id, userId: user.id } })
  if (!existing) return NextResponse.json({ error: "Événement introuvable" }, { status: 404 })

  const parsed = eventUpdateSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }
  const data = parsed.data

  const isSeries = existing.recurrence !== null
  const scope = data.scope ?? "series"

  // ── Scope « single » : détacher une occurrence de sa série ─────────────────
  if (scope === "single" && isSeries) {
    if (!data.occurrenceStart) {
      return NextResponse.json(
        { error: "occurrenceStart est requis pour modifier une occurrence isolée" },
        { status: 400 }
      )
    }
    const occurrenceStart = new Date(data.occurrenceStart)
    if (!isOccurrenceOfSeries(existing, occurrenceStart)) {
      return NextResponse.json({ error: "Occurrence introuvable dans cette série" }, { status: 400 })
    }

    // 1. Le master « oublie » cette occurrence (exception de série)
    const master = await db.event.update({
      where: { id: existing.id },
      data: { recurrenceExceptions: appendException(existing.recurrenceExceptions, occurrenceStart.toISOString()) },
    })

    // 2. L'occurrence vit sa vie : nouvel événement indépendant, non récurrent
    const duration = existing.endTime.getTime() - existing.startTime.getTime()
    const startTime = data.startTime ? new Date(data.startTime) : occurrenceStart
    const endTime = data.endTime
      ? new Date(data.endTime)
      : new Date(occurrenceStart.getTime() + duration)
    if (endTime <= startTime) {
      return NextResponse.json(
        { error: "L'heure de fin doit être après l'heure de début" },
        { status: 400 }
      )
    }

    const detached = await db.event.create({
      data: {
        userId: user.id,
        title: sanitizeText(data.title ?? existing.title),
        description:
          data.description !== undefined
            ? data.description
              ? sanitizeText(data.description) || null
              : null
            : existing.description,
        location:
          data.location !== undefined
            ? data.location
              ? sanitizeText(data.location) || null
              : null
            : existing.location,
        startTime,
        endTime,
        allDay: data.allDay ?? existing.allDay,
        timezone: data.timezone ?? existing.timezone,
        color: data.color !== undefined ? data.color : existing.color,
        recurrence: toJsonInput(null), // une occurrence détachée n'est jamais récurrente
        attendees: toJsonInput(data.attendees !== undefined ? data.attendees : existing.attendees),
        reminders: toJsonInput(data.reminders !== undefined ? data.reminders : existing.reminders),
        source: existing.source,
        externalId: null,
        reminderLog: [],
      },
    })

    const conflicts = await computeConflicts(
      user.id,
      { start: startTime, end: endTime },
      [detached.id]
    )

    // Webhook « event.updated » (occurrence détachée = résultat de l'édition)
    // — fire-and-forget, jamais bloquant.
    void triggerWebhooks(user.id, "event.updated", toEventDto(detached)).catch(() => {})

    return NextResponse.json({ event: toEventDto(detached), master: toEventDto(master), conflicts })
  }

  // ── Scope « series » (ou événement simple) : mise à jour directe ───────────
  const startTime = data.startTime ? new Date(data.startTime) : existing.startTime
  const endTime = data.endTime ? new Date(data.endTime) : existing.endTime
  if (endTime <= startTime) {
    return NextResponse.json(
      { error: "L'heure de fin doit être après l'heure de début" },
      { status: 400 }
    )
  }

  // L'heure (ancre de série) ou les rappels changent → les rappels déjà envoyés
  // ne sont plus valables : on repart d'une page blanche (log purgé).
  const reminderRelevantChange =
    data.startTime !== undefined ||
    data.endTime !== undefined ||
    data.reminders !== undefined ||
    data.recurrence !== undefined
  const mergedAllDay = data.allDay ?? existing.allDay

  const event = await db.event.update({
    where: { id: existing.id },
    data: {
      ...(data.title !== undefined ? { title: sanitizeText(data.title) } : {}),
      ...(data.description !== undefined
        ? { description: data.description ? sanitizeText(data.description) || null : null }
        : {}),
      ...(data.location !== undefined
        ? { location: data.location ? sanitizeText(data.location) || null : null }
        : {}),
      startTime,
      endTime,
      ...(data.allDay !== undefined ? { allDay: data.allDay } : {}),
      ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
      ...(data.color !== undefined ? { color: data.color } : {}),
      ...(data.recurrence !== undefined ? { recurrence: toJsonInput(data.recurrence) } : {}),
      ...(data.attendees !== undefined ? { attendees: toJsonInput(data.attendees) } : {}),
      ...(data.reminders !== undefined
        ? {
            reminders: toJsonInput(
              mergedAllDay && data.reminders
                ? data.reminders.filter((r) => r.minutes >= 60 || r.type === "email")
                : data.reminders
            ),
          }
        : {}),
      ...(reminderRelevantChange ? { reminderLog: [], reminderSentAt: null } : {}),
    },
  })

  const conflicts = await computeConflicts(user.id, { start: startTime, end: endTime }, [event.id])

  // Webhook « event.updated » — fire-and-forget, jamais bloquant.
  void triggerWebhooks(user.id, "event.updated", toEventDto(event)).catch(() => {})

  return NextResponse.json({ event: toEventDto(event), conflicts })
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  const { id } = await params

  const rl = rateLimit(`events:delete:${user.id}`, 60)
  if (!rl.ok) return tooManyRequests(rl)

  const existing = await db.event.findFirst({ where: { id, userId: user.id } })
  if (!existing) return NextResponse.json({ error: "Événement introuvable" }, { status: 404 })

  // scope/occurrenceStart : query string (fetch DELETE) ou body JSON
  const { searchParams } = new URL(req.url)
  const body = (await req.json().catch(() => null)) as
    | { scope?: string; occurrenceStart?: string }
    | null
  const scope = (searchParams.get("scope") ?? body?.scope) as "single" | "series" | null
  const occurrenceStartParam =
    searchParams.get("occurrenceStart") ?? body?.occurrenceStart ?? undefined

  // ── Suppression d'une seule occurrence d'une série ─────────────────────────
  if (scope === "single" && existing.recurrence !== null) {
    if (!occurrenceStartParam) {
      return NextResponse.json(
        { error: "occurrenceStart est requis pour supprimer une occurrence isolée" },
        { status: 400 }
      )
    }
    const occurrenceStart = new Date(occurrenceStartParam)
    if (!isOccurrenceOfSeries(existing, occurrenceStart)) {
      return NextResponse.json({ error: "Occurrence introuvable dans cette série" }, { status: 400 })
    }
    const master = await db.event.update({
      where: { id: existing.id },
      data: {
        recurrenceExceptions: appendException(
          existing.recurrenceExceptions,
          occurrenceStart.toISOString()
        ),
      },
    })

    // Webhook « event.deleted » (occurrence identifiée par master + début ISO)
    // — fire-and-forget, jamais bloquant.
    void triggerWebhooks(user.id, "event.deleted", {
      id: existing.id,
      occurrenceStart: occurrenceStart.toISOString(),
    }).catch(() => {})

    return NextResponse.json({ ok: true, master: toEventDto(master) })
  }

  // ── Suppression de l'événement / de la série entière ───────────────────────
  await db.event.delete({ where: { id: existing.id } })
  // Tombstone : propagation de la suppression aux caches offline (multi-appareils)
  await recordTombstone(user.id, "event", existing.id)

  // Webhook « event.deleted » — fire-and-forget, jamais bloquant.
  void triggerWebhooks(user.id, "event.deleted", { id: existing.id }).catch(() => {})

  return NextResponse.json({ ok: true })
}
