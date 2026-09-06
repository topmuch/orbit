// GET/PATCH/DELETE /api/v1/tasks/[id] — API publique (clé API, sans session)
// ─────────────────────────────────────────────────────────────────────────────
// Même logique métier que /api/tasks/[id] (ownership, taskUpdateSchema,
// updateTaskWithRelations, soft delete « archived » / hard delete + tombstones)
// + webhooks « task.updated » / « task.deleted ». Auth par clé API.

import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { rateLimit } from "@/lib/rate-limit"
import { taskUpdateSchema } from "@/lib/validators"
import { loadOwnedTask, updateTaskWithRelations, taskDto } from "@/lib/tasks-service"
import { recordTombstone } from "@/lib/sync-tombstones"
import { verifyApiKey, v1Unauthorized, v1TooMany, V1_RATE_LIMIT } from "@/lib/api/auth"
import { triggerWebhooks } from "@/lib/api/webhooks"

type Params = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: Params) {
  const auth = await verifyApiKey(req)
  if (!auth) return v1Unauthorized()
  const { id } = await params

  const rl = rateLimit(`v1:${auth.keyId}`, V1_RATE_LIMIT)
  if (!rl.ok) return v1TooMany(rl.retryAfterSec)

  const task = await loadOwnedTask(auth.userId, id)
  if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 })

  return NextResponse.json({ task: taskDto(task) })
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const auth = await verifyApiKey(req)
  if (!auth) return v1Unauthorized()
  const { id } = await params

  const rl = rateLimit(`v1:${auth.keyId}`, V1_RATE_LIMIT)
  if (!rl.ok) return v1TooMany(rl.retryAfterSec)

  const existing = await loadOwnedTask(auth.userId, id)
  if (!existing) return NextResponse.json({ error: "Task not found" }, { status: 404 })

  const parsed = taskUpdateSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid payload" },
      { status: 400 }
    )
  }

  // Lien événement : ownership explicite
  if (parsed.data.eventId) {
    const event = await db.event.findFirst({
      where: { id: parsed.data.eventId, userId: auth.userId },
      select: { id: true },
    })
    if (!event) {
      return NextResponse.json(
        { error: "Event not found — cannot link the task" },
        { status: 400 }
      )
    }
  }

  const task = await updateTaskWithRelations(existing, parsed.data)

  // Webhook « task.updated » — non bloquant.
  void triggerWebhooks(auth.userId, "task.updated", taskDto(task)).catch(() => {})

  return NextResponse.json({ task: taskDto(task) })
}

export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = await verifyApiKey(req)
  if (!auth) return v1Unauthorized()
  const { id } = await params

  const rl = rateLimit(`v1:${auth.keyId}`, V1_RATE_LIMIT)
  if (!rl.ok) return v1TooMany(rl.retryAfterSec)

  const existing = await loadOwnedTask(auth.userId, id)
  if (!existing) return NextResponse.json({ error: "Task not found" }, { status: 404 })

  const hard =
    req.nextUrl.searchParams.get("hard") === "1" ||
    req.nextUrl.searchParams.get("hard") === "true"

  if (hard || existing.status === "archived") {
    // Suppression définitive : sous-tâches en cascade, tags détachés (m:n)
    await db.task.delete({ where: { id } })
    // Tombstone : propagation de la suppression aux caches offline
    await recordTombstone(auth.userId, "task", id)

    void triggerWebhooks(auth.userId, "task.deleted", { id }).catch(() => {})

    return NextResponse.json({ ok: true, mode: "deleted" })
  }

  // Soft delete : archivage (masqué par défaut dans l'UI)
  await db.task.update({ where: { id }, data: { status: "archived" } })

  void triggerWebhooks(auth.userId, "task.deleted", { id }).catch(() => {})

  return NextResponse.json({ ok: true, mode: "archived" })
}
