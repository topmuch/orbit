// POST /api/tasks/[id]/subtasks — Ajout d'une sous-tâche
// ─────────────────────────────────────────────────────────────────────────────
// Body : { title } — position = fin de liste (max + 1000).
// Garde-fou : SUBTASKS_MAX (50) sous-tâches par tâche.

import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { subtaskCreateSchema, SUBTASKS_MAX } from "@/lib/validators"
import { loadOwnedTask, taskDto, TASK_INCLUDE } from "@/lib/tasks-service"

type Params = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  const { id } = await params

  const limit = rateLimit(`tasks:subtasks:${user.id}`, 60)
  if (!limit.ok) return tooManyRequests(limit)

  const task = await loadOwnedTask(user.id, id)
  if (!task) return NextResponse.json({ error: "Tâche introuvable" }, { status: 404 })

  const parsed = subtaskCreateSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }

  if (task.subtasks.length >= SUBTASKS_MAX) {
    return NextResponse.json(
      { error: `Trop de sous-tâches (${SUBTASKS_MAX} maximum par tâche)` },
      { status: 400 }
    )
  }

  const position = task.subtasks.length
    ? Math.max(...task.subtasks.map((s) => s.position)) + 1000
    : 0

  const subtask = await db.subTask.create({
    data: { taskId: task.id, title: parsed.data.title, position },
  })

  const updated = await db.task.findUniqueOrThrow({
    where: { id: task.id },
    include: TASK_INCLUDE,
  })
  return NextResponse.json({ task: taskDto(updated), subtask }, { status: 201 })
}
