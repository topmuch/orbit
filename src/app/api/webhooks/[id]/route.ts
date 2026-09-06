// PATCH/DELETE /api/webhooks/[id] — Gestion d'un webhook (session auth)
// ─────────────────────────────────────────────────────────────────────────────
// PATCH   { isActive?: boolean } : pause/reprise des livraisons (ownership).
// DELETE  : suppression du webhook + cascade des logs. Ownership vérifié.

import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"

const webhookPatchSchema = z.object({
  isActive: z.boolean().optional(),
})

type Params = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  const { id } = await params

  const rl = rateLimit(`webhooks:patch:${user.id}`, 30)
  if (!rl.ok) return tooManyRequests(rl)

  const existing = await db.webhook.findFirst({
    where: { id, userId: user.id },
    select: { id: true },
  })
  if (!existing) return NextResponse.json({ error: "Webhook introuvable" }, { status: 404 })

  const parsed = webhookPatchSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }
  if (parsed.data.isActive === undefined) {
    return NextResponse.json({ error: "Rien à mettre à jour" }, { status: 400 })
  }

  const webhook = await db.webhook.update({
    where: { id },
    data: { isActive: parsed.data.isActive },
  })

  return NextResponse.json({
    webhook: {
      id: webhook.id,
      url: webhook.url,
      description: webhook.description,
      events: Array.isArray(webhook.events) ? (webhook.events as string[]) : [],
      isActive: webhook.isActive,
      lastStatus: webhook.lastStatus,
      lastDeliveryAt: webhook.lastDeliveryAt?.toISOString() ?? null,
      lastError: webhook.lastError,
      createdAt: webhook.createdAt.toISOString(),
      logs: [],
    },
  })
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  const { id } = await params

  const rl = rateLimit(`webhooks:delete:${user.id}`, 30)
  if (!rl.ok) return tooManyRequests(rl)

  const existing = await db.webhook.findFirst({
    where: { id, userId: user.id },
    select: { id: true },
  })
  if (!existing) return NextResponse.json({ error: "Webhook introuvable" }, { status: 404 })

  // Logs supprimés en cascade (onDelete: Cascade dans le schéma)
  await db.webhook.delete({ where: { id } })

  return NextResponse.json({ ok: true })
}
