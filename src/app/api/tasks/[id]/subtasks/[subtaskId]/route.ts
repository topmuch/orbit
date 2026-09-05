// PATCH/DELETE /api/tasks/[id]/subtasks/[subtaskId] — Édition/suppression
// ─────────────────────────────────────────────────────────────────────────────
// PATCH : { title?, completed?, position? } — position = indice cible dans la
// liste (renormalisation complète : 1000, 2000…).
// DELETE : suppression simple (positions suivantes inchangées).

import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { subtaskUpdateSchema } from "@/lib/validators"
import { loadOwnedTask, taskDto, TASK_INCLUDE } from "@/lib/tasks-service"
import { normalizePositions } from "@/lib/tasks"

type Params = { params: Promise<{ id: string; subtaskId: string }> }

/** Charge la sous-tâche en vérifiant l'appartenance à la tâche possédée. */
async function loadOwnedSubtask(userId: string, taskId: string, subtaskId: string) {
  const task = await loadOwnedTask(userId, taskId)
  if (!task) return { error: "Tâche introuvable" as const }
  const subtask = task.subtasks.find((s) => s.id === subtaskId)
  if (!subtask) return { error: "Sous-tâche introuvable" as const }
  return { task, subtask }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  const { id, subtaskId } = await params

  const limit = rateLimit(`tasks:subtasks:${user.id}`, 120)
  if (!limit.ok) return tooManyRequests(limit)

  const loaded = await loadOwnedSubtask(user.id, id, subtaskId)
  if ("error" in loaded) return NextResponse.json({ error: loaded.error }, { status: 404 })
  const { task } = loaded

  const parsed = subtaskUpdateSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }

  const data = parsed.data

  if (data.position !== undefined) {
    // Réordonnancement : renormalisation transactionnelle de toute la liste
    const ordered = [...task.subtasks].sort((a, b) => a.position - b.position)
    const ids = ordered.filter((s) => s.id !== subtaskId).map((s) => s.id)
    const index = Math.max(0, Math.min(data.position, ids.length))
    ids.splice(index, 0, subtaskId)

    await db.$transaction([
      ...normalizePositions(ids).map(({ id: sid, position }) =>
        db.subTask.update({
          where: { id: sid },
          data: {
            position,
            ...(sid === subtaskId
              ? {
                  ...(data.title !== undefined ? { title: data.title } : {}),
                  ...(data.completed !== undefined ? { completed: data.completed } : {}),
                }
              : {}),
          },
        })
      ),
    ])
  } else {
    await db.subTask.update({
      where: { id: subtaskId },
      data: {
        ...(data.title !== undefined ? { title: data.title } : {}),
        ...(data.completed !== undefined ? { completed: data.completed } : {}),
      },
    })
  }

  const updated = await db.task.findUniqueOrThrow({
    where: { id: task.id },
    include: TASK_INCLUDE,
  })
  return NextResponse.json({ task: taskDto(updated) })
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  const { id, subtaskId } = await params

  const limit = rateLimit(`tasks:subtasks:${user.id}`, 120)
  if (!limit.ok) return tooManyRequests(limit)

  const loaded = await loadOwnedSubtask(user.id, id, subtaskId)
  if ("error" in loaded) return NextResponse.json({ error: loaded.error }, { status: 404 })

  await db.subTask.delete({ where: { id: subtaskId } })

  const updated = await db.task.findUniqueOrThrow({
    where: { id: loaded.task.id },
    include: TASK_INCLUDE,
  })
  return NextResponse.json({ task: taskDto(updated) })
}
