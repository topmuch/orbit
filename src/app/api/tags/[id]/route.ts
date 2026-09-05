// PATCH/DELETE /api/tags/[id] — Édition / suppression d'un tag
// ─────────────────────────────────────────────────────────────────────────────
// PATCH   : { name?, color? } — 409 si le nouveau nom est déjà pris.
// DELETE  : supprime le tag ; les tâches associées sont simplement DÉTACHÉES
//           (relation implicite m:n — aucune tâche n'est modifiée ou supprimée).

import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { tagUpdateSchema } from "@/lib/validators"

type Params = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  const { id } = await params

  const limit = rateLimit(`tags:update:${user.id}`, 30)
  if (!limit.ok) return tooManyRequests(limit)

  const existing = await db.tag.findFirst({ where: { id, userId: user.id } })
  if (!existing) return NextResponse.json({ error: "Tag introuvable" }, { status: 404 })

  const parsed = tagUpdateSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }

  // Renommage → conflit si le nouveau nom existe déjà chez cet utilisateur
  if (parsed.data.name && parsed.data.name !== existing.name) {
    const clash = await db.tag.findFirst({
      where: { userId: user.id, name: parsed.data.name },
      select: { id: true },
    })
    if (clash) return NextResponse.json({ error: "Ce nom de tag est déjà utilisé" }, { status: 409 })
  }

  const tag = await db.tag.update({
    where: { id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.color !== undefined ? { color: parsed.data.color } : {}),
    },
  })
  return NextResponse.json({ tag })
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  const { id } = await params

  const limit = rateLimit(`tags:delete:${user.id}`, 30)
  if (!limit.ok) return tooManyRequests(limit)

  const existing = await db.tag.findFirst({ where: { id, userId: user.id } })
  if (!existing) return NextResponse.json({ error: "Tag introuvable" }, { status: 404 })

  await db.tag.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
