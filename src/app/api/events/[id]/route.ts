// PATCH/DELETE /api/events/[id]
import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { toEventDto } from "@/lib/dto"
import { eventUpdateSchema } from "@/lib/validators"

type Params = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  const { id } = await params

  const existing = await db.event.findFirst({ where: { id, userId: user.id } })
  if (!existing) return NextResponse.json({ error: "Événement introuvable" }, { status: 404 })

  const parsed = eventUpdateSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }
  const data = parsed.data

  const startTime = data.startTime ? new Date(data.startTime) : existing.startTime
  const endTime = data.endTime ? new Date(data.endTime) : existing.endTime
  if (endTime <= startTime) {
    return NextResponse.json(
      { error: "L'heure de fin doit être après l'heure de début" },
      { status: 400 }
    )
  }

  const event = await db.event.update({
    where: { id },
    data: {
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      startTime,
      endTime,
    },
  })

  return NextResponse.json({ event: toEventDto(event) })
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  const { id } = await params

  const existing = await db.event.findFirst({ where: { id, userId: user.id } })
  if (!existing) return NextResponse.json({ error: "Événement introuvable" }, { status: 404 })

  await db.event.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
