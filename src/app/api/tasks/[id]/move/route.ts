// PATCH /api/tasks/[id]/move — Déplacement Kanban optimisé (drag & drop)
// ─────────────────────────────────────────────────────────────────────────────
// Body : { status: "todo"|"doing"|"done"|"archived", position: <indice cible> }
// Transaction atomique : insère la tâche à l'indice demandé dans la colonne
// cible puis RENORMALISE toutes les positions de la colonne (1000, 2000…).
// Changement de statut → completedAt maintenu (done = horodatage).

import { NextRequest, NextResponse } from "next/server"
import { getSessionUser } from "@/lib/auth"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { taskMoveSchema } from "@/lib/validators"
import { loadOwnedTask, moveTaskWithinColumn, taskDto } from "@/lib/tasks-service"

type Params = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  const { id } = await params

  // Généreux : un drag rapide peut générer plusieurs moves rapprochés.
  const limit = rateLimit(`tasks:move:${user.id}`, 120)
  if (!limit.ok) return tooManyRequests(limit)

  const existing = await loadOwnedTask(user.id, id)
  if (!existing) return NextResponse.json({ error: "Tâche introuvable" }, { status: 404 })

  const parsed = taskMoveSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }

  const task = await moveTaskWithinColumn(user.id, existing, parsed.data.status, parsed.data.position)
  return NextResponse.json({ task: taskDto(task) })
}
