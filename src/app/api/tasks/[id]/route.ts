// PATCH/PUT/DELETE /api/tasks/[id] — Édition partielle + suppression
// ─────────────────────────────────────────────────────────────────────────────
// PATCH (et PUT, alias sémantique) : TaskUpdateInput — champs scalaires +
// remplacement complet des collections (tags / sous-tâches) si fournies.
//   • Changement de statut → completedAt maintenu (done = horodatage).
//   • Position acceptée (rare : le move passe par /move).
// DELETE : ?hard=true|1 → suppression définitive (cascade sous-tâches) ;
//   par défaut soft delete → statut « archived » ; une tâche DÉJÀ archivée
//   est supprimée définitivement (2e appel = purge).

import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { taskUpdateSchema } from "@/lib/validators"
import { loadOwnedTask, updateTaskWithRelations, taskDto } from "@/lib/tasks-service"
import { recordTombstone } from "@/lib/sync-tombstones"

type Params = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  const { id } = await params

  const limit = rateLimit(`tasks:update:${user.id}`, 60)
  if (!limit.ok) return tooManyRequests(limit)

  const existing = await loadOwnedTask(user.id, id)
  if (!existing) return NextResponse.json({ error: "Tâche introuvable" }, { status: 404 })

  const parsed = taskUpdateSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }

  // Lien événement : ownership explicite
  if (parsed.data.eventId) {
    const event = await db.event.findFirst({
      where: { id: parsed.data.eventId, userId: user.id },
      select: { id: true },
    })
    if (!event) {
      return NextResponse.json(
        { error: "Événement introuvable — impossible de lier la tâche" },
        { status: 400 }
      )
    }
  }

  const task = await updateTaskWithRelations(existing, parsed.data)
  return NextResponse.json({ task: taskDto(task) })
}

/** PUT = alias de PATCH (sémantique « upsert complet » gérée côté client). */
export const PUT = PATCH

export async function DELETE(req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  const { id } = await params

  const limit = rateLimit(`tasks:delete:${user.id}`, 60)
  if (!limit.ok) return tooManyRequests(limit)

  const existing = await loadOwnedTask(user.id, id)
  if (!existing) return NextResponse.json({ error: "Tâche introuvable" }, { status: 404 })

  const hard =
    req.nextUrl.searchParams.get("hard") === "1" ||
    req.nextUrl.searchParams.get("hard") === "true"

  if (hard || existing.status === "archived") {
    // Suppression définitive : sous-tâches en cascade, tags détachés (m:n)
    await db.task.delete({ where: { id } })
    // Tombstone : propagation de la suppression aux caches offline (multi-appareils)
    await recordTombstone(user.id, "task", id)
    return NextResponse.json({ ok: true, mode: "deleted" })
  }

  // Soft delete : archivage (masqué par défaut dans l'UI)
  await db.task.update({ where: { id }, data: { status: "archived" } })
  return NextResponse.json({ ok: true, mode: "archived" })
}
