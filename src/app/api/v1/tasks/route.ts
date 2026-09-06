// GET/POST /api/v1/tasks — API publique (clé API, sans session)
// ─────────────────────────────────────────────────────────────────────────────
// GET  : ?status=todo,doing (csv) &priority=HIGH (csv) &page=1 &limit=50 (≤ 200)
//        Tri fixe createdAt desc. Réponse : { tasks, total, page, limit }.
// POST : même contrat que /api/tasks (taskCreateSchema + createTaskWithRelations,
//        position = fin de colonne) → 201 { task } + webhook « task.created ».
// Auth : Authorization: Bearer orbit_… OU X-API-Key — 401 JSON si invalide.
// Rate : 60 req/min par clé (rateLimit "v1:<keyId>").

import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { rateLimit } from "@/lib/rate-limit"
import { taskCreateSchema } from "@/lib/validators"
import { createTaskWithRelations, taskDto, TASK_INCLUDE } from "@/lib/tasks-service"
import { verifyApiKey, v1Unauthorized, v1TooMany, V1_RATE_LIMIT } from "@/lib/api/auth"
import { triggerWebhooks } from "@/lib/api/webhooks"
import type { Prisma } from "@prisma/client"

const MAX_LIMIT = 200
const DEFAULT_LIMIT = 50
const STATUSES = new Set(["todo", "doing", "done", "archived"])
const PRIORITIES = new Set(["LOW", "MEDIUM", "HIGH", "URGENT"])

/** Valeurs csv valides parmi `allowed` (filles vides ignorées). */
function csvParam(value: string | null, allowed: Set<string>): string[] | null {
  if (!value) return null
  const items = value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v && allowed.has(v))
  return items.length ? items : null
}

export async function GET(req: NextRequest) {
  const auth = await verifyApiKey(req)
  if (!auth) return v1Unauthorized()

  const rl = rateLimit(`v1:${auth.keyId}`, V1_RATE_LIMIT)
  if (!rl.ok) return v1TooMany(rl.retryAfterSec)

  const sp = new URL(req.url).searchParams

  // ── Filtres (statut + priorité en csv) ─────────────────────────────────────
  const where: Prisma.TaskWhereInput = { userId: auth.userId }

  const statuses = csvParam(sp.get("status"), STATUSES)
  if (statuses) where.status = statuses.length === 1 ? statuses[0] : { in: statuses }

  const priorities = csvParam(sp.get("priority"), PRIORITIES)
  if (priorities) where.priority = priorities.length === 1 ? priorities[0] : { in: priorities }

  // ── Pagination (tri fixe : plus récentes d'abord) ──────────────────────────
  const page = Math.max(1, Number(sp.get("page")) || 1)
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(sp.get("limit")) || DEFAULT_LIMIT))

  const [tasks, total] = await Promise.all([
    db.task.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      include: TASK_INCLUDE,
    }),
    db.task.count({ where }),
  ])

  return NextResponse.json({ tasks: tasks.map(taskDto), total, page, limit })
}

export async function POST(req: NextRequest) {
  const auth = await verifyApiKey(req)
  if (!auth) return v1Unauthorized()

  const rl = rateLimit(`v1:${auth.keyId}`, V1_RATE_LIMIT)
  if (!rl.ok) return v1TooMany(rl.retryAfterSec)

  const parsed = taskCreateSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid payload" },
      { status: 400 }
    )
  }

  // Lien événement : ownership explicite (le where du create ne protège pas
  // cette relation)
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

  const task = await createTaskWithRelations(auth.userId, parsed.data)

  // Webhook « task.created » — jamais bloquant, jamais en échec de route.
  void triggerWebhooks(auth.userId, "task.created", taskDto(task)).catch(() => {})

  return NextResponse.json({ task: taskDto(task) }, { status: 201 })
}
