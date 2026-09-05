// GET/POST /api/tags — Étiquettes de l'utilisateur
// ─────────────────────────────────────────────────────────────────────────────
// GET  : tous les tags + nombre de tâches associées.
// POST : { name, color } — 409 si le nom existe déjà (unicité userId+name).

import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { tagCreateSchema } from "@/lib/validators"

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const tags = await db.tag.findMany({
    where: { userId: user.id },
    orderBy: { name: "asc" },
    include: { _count: { select: { tasks: true } } },
  })

  return NextResponse.json({
    tags: tags.map((t) => ({ id: t.id, name: t.name, color: t.color, taskCount: t._count.tasks })),
  })
}

export async function POST(req: Request) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const limit = rateLimit(`tags:create:${user.id}`, 30)
  if (!limit.ok) return tooManyRequests(limit)

  const parsed = tagCreateSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }

  const existing = await db.tag.findFirst({
    where: { userId: user.id, name: parsed.data.name },
    select: { id: true },
  })
  if (existing) {
    return NextResponse.json({ error: "Ce tag existe déjà" }, { status: 409 })
  }

  const tag = await db.tag.create({
    data: { userId: user.id, name: parsed.data.name, color: parsed.data.color },
  })
  return NextResponse.json({ tag }, { status: 201 })
}
