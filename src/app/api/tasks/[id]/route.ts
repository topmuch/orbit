// PATCH/DELETE /api/tasks/[id]
import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { toTaskDto } from "@/lib/dto"
import { taskUpdateSchema } from "@/lib/validators"

type Params = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  const { id } = await params

  const existing = await db.task.findFirst({ where: { id, userId: user.id } })
  if (!existing) return NextResponse.json({ error: "Tâche introuvable" }, { status: 404 })

  const parsed = taskUpdateSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }
  const data = parsed.data

  const task = await db.task.update({
    where: { id },
    data: {
      ...(data.title !== undefined ? { title: data.title } : {}),
      ...(data.description !== undefined ? { description: data.description } : {}),
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.priority !== undefined ? { priority: data.priority } : {}),
      ...(data.dueDate !== undefined
        ? { dueDate: data.dueDate ? new Date(data.dueDate) : null }
        : {}),
    },
  })

  return NextResponse.json({ task: toTaskDto(task) })
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  const { id } = await params

  const existing = await db.task.findFirst({ where: { id, userId: user.id } })
  if (!existing) return NextResponse.json({ error: "Tâche introuvable" }, { status: 404 })

  await db.task.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
