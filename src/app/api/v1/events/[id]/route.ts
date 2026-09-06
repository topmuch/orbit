// GET/DELETE /api/v1/events/[id] — API publique (clé API, sans session)
// ─────────────────────────────────────────────────────────────────────────────
// GET    : ownership + DTO (masters uniquement — les occurrences virtuelles se
//          lisent via /api/v1/events?start&end).
// DELETE : même logique que /api/events/[id] (scope single/series, tombstones)
//          + webhook « event.deleted ».
//   ?scope=single&occurrenceStart=ISO → exception de série (le master survit) ;
//   sinon suppression de l'événement/de la série entière.

import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { toEventDto } from "@/lib/dto"
import { appendException, isOccurrenceOfSeries } from "@/lib/events-service"
import { recordTombstone } from "@/lib/sync-tombstones"
import { rateLimit } from "@/lib/rate-limit"
import { verifyApiKey, v1Unauthorized, v1TooMany, V1_RATE_LIMIT } from "@/lib/api/auth"
import { triggerWebhooks } from "@/lib/api/webhooks"

type Params = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: Params) {
  const auth = await verifyApiKey(req)
  if (!auth) return v1Unauthorized()
  const { id } = await params

  const rl = rateLimit(`v1:${auth.keyId}`, V1_RATE_LIMIT)
  if (!rl.ok) return v1TooMany(rl.retryAfterSec)

  const event = await db.event.findFirst({ where: { id, userId: auth.userId } })
  if (!event) return NextResponse.json({ error: "Event not found" }, { status: 404 })

  return NextResponse.json({ event: toEventDto(event) })
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await verifyApiKey(req)
  if (!auth) return v1Unauthorized()
  const { id } = await params

  const rl = rateLimit(`v1:${auth.keyId}`, V1_RATE_LIMIT)
  if (!rl.ok) return v1TooMany(rl.retryAfterSec)

  const existing = await db.event.findFirst({ where: { id, userId: auth.userId } })
  if (!existing) return NextResponse.json({ error: "Event not found" }, { status: 404 })

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
        { error: "occurrenceStart is required to delete a single occurrence" },
        { status: 400 }
      )
    }
    const occurrenceStart = new Date(occurrenceStartParam)
    if (!isOccurrenceOfSeries(existing, occurrenceStart)) {
      return NextResponse.json({ error: "Occurrence not found in this series" }, { status: 400 })
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

    // L'occurrence supprimée est identifiée par le master + son début ISO.
    void triggerWebhooks(auth.userId, "event.deleted", {
      id: existing.id,
      occurrenceStart: occurrenceStart.toISOString(),
    }).catch(() => {})

    return NextResponse.json({ ok: true, master: toEventDto(master) })
  }

  // ── Suppression de l'événement / de la série entière ───────────────────────
  await db.event.delete({ where: { id: existing.id } })
  // Tombstone : propagation de la suppression aux caches offline
  await recordTombstone(auth.userId, "event", existing.id)

  void triggerWebhooks(auth.userId, "event.deleted", { id: existing.id }).catch(() => {})

  return NextResponse.json({ ok: true })
}
