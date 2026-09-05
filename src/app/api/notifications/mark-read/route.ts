// POST /api/notifications/mark-read — Marquer des notifications comme lues
// ───────────────────────────────────────────────────────────────────────────
// Corps : { notificationId } | { ids: [...] } | { all: true }
// Appelé par le centre de notifications in-app ET par le Service Worker
// (event « notificationclose » — fetch same-origin avec les cookies de
// session). Idempotent : marquer une notification déjà lue est un no-op.
import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { notificationMarkReadSchema } from "@/lib/validators"

export const runtime = "nodejs"

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const parsed = notificationMarkReadSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: "Données invalides" }, { status: 400 })
  }
  const { notificationId, ids, all } = parsed.data

  if (all) {
    const res = await db.notification.updateMany({
      where: { userId: user.id, isRead: false },
      data: { isRead: true },
    })
    return NextResponse.json({ ok: true, updated: res.count })
  }

  const targetIds = [...(ids ?? []), ...(notificationId ? [notificationId] : [])]
  if (!targetIds.length) {
    return NextResponse.json({ error: "notificationId, ids ou all requis" }, { status: 400 })
  }

  // Ownership garantie par le where userId.
  const res = await db.notification.updateMany({
    where: { userId: user.id, id: { in: targetIds }, isRead: false },
    data: { isRead: true },
  })
  return NextResponse.json({ ok: true, updated: res.count })
}
