// DELETE /api/keys/[id] — Révocation d'une clé d'API (session auth)
// ─────────────────────────────────────────────────────────────────────────────
// Révocation (soft) : isActive=false + revokedAt=now — la clé cesse
// immédiatement d'être acceptée par /api/v1/* (verifyApiKey). La ligne est
// conservée pour l'historique de l'UI. Ownership vérifié (404 sinon).

import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"

type Params = { params: Promise<{ id: string }> }

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  const { id } = await params

  const rl = rateLimit(`keys:revoke:${user.id}`, 30)
  if (!rl.ok) return tooManyRequests(rl)

  const existing = await db.apiKey.findFirst({
    where: { id, userId: user.id },
    select: { id: true },
  })
  if (!existing) return NextResponse.json({ error: "Clé introuvable" }, { status: 404 })

  await db.apiKey.update({
    where: { id },
    data: { isActive: false, revokedAt: new Date() },
  })

  return NextResponse.json({ ok: true })
}
