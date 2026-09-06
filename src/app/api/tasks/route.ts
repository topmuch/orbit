// GET/POST /api/tasks — Liste filtrée/triée/paginée + création riche
// ─────────────────────────────────────────────────────────────────────────────
// GET : ?status=todo,doing (csv) &priority=HIGH,URGENT (csv) &tag=<nom|id>
//       &search=<texte> &dueBefore=<ISO> &dueAfter=<ISO> &overdue=1
//       &sortBy=position|dueDate|priority|createdAt|title &sortOrder=asc|desc
//       &page=1 &limit=300 — inclut tags + sous-tâches.
//       Tri par défaut : statut croissant puis position croissante (Kanban).
// POST : TaskCreateInput — validation Zod, tags upsertés par nom, sous-tâches
//       créées, position = fin de colonne, completedAt si statut « done ».

import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { taskCreateSchema } from "@/lib/validators"
import { createTaskWithRelations, taskDto } from "@/lib/tasks-service"
import { TASK_INCLUDE } from "@/lib/tasks-service"
import { triggerWebhooks } from "@/lib/api/webhooks"
import type { Prisma } from "@prisma/client"

const SORT_FIELDS = new Set(["position", "dueDate", "priority", "createdAt", "title"])
const MAX_LIMIT = 500
const DEFAULT_LIMIT = 300

/** Liste de valeurs csv valides parmis `allowed`. */
function csvParam(value: string | null, allowed: Set<string>): string[] | null {
  if (!value) return null
  const items = value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v && allowed.has(v))
  return items.length ? items : null
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const sp = new URL(req.url).searchParams
  const now = new Date()

  // ── Filtres ───────────────────────────────────────────────────────────────
  const where: Prisma.TaskWhereInput = { userId: user.id }

  const statuses = csvParam(
    sp.get("status"),
    new Set(["todo", "doing", "done", "archived"])
  )
  if (statuses) where.status = statuses.length === 1 ? statuses[0] : { in: statuses }

  const priorities = csvParam(sp.get("priority"), new Set(["LOW", "MEDIUM", "HIGH", "URGENT"]))
  if (priorities) where.priority = priorities.length === 1 ? priorities[0] : { in: priorities }

  const tag = sp.get("tag")?.trim()
  if (tag) {
    // Par id ou par nom (insensible à la casse via normalisation applicative)
    const tags = await db.tag.findMany({
      where: { userId: user.id, OR: [{ id: tag }, { name: tag }] },
      select: { id: true },
    })
    where.tags = tags.length
      ? { some: { id: { in: tags.map((t) => t.id) } } }
      : { none: {} } // tag inconnu → aucun résultat
  }

  const search = sp.get("search")?.trim()
  if (search) {
    where.OR = [
      { title: { contains: search } },
      { description: { contains: search } },
    ]
  }

  const dueBefore = sp.get("dueBefore")
  const dueAfter = sp.get("dueAfter")
  if (dueBefore || dueAfter) {
    const due: Prisma.DateTimeNullableFilter = {}
    if (dueBefore && !Number.isNaN(Date.parse(dueBefore))) due.lte = new Date(dueBefore)
    if (dueAfter && !Number.isNaN(Date.parse(dueAfter))) due.gte = new Date(dueAfter)
    where.dueDate = due
  }

  // « overdue » : échéance passée, non terminée, non archivée (priorité sur dueAfter)
  if (sp.get("overdue") === "1" || sp.get("overdue") === "true") {
    where.dueDate = { lt: now }
    where.status = { notIn: ["done", "archived"] }
  }

  // ── Tri ───────────────────────────────────────────────────────────────────
  const sortByParam = sp.get("sortBy") ?? "position"
  const sortBy = SORT_FIELDS.has(sortByParam) ? sortByParam : "position"
  const sortOrder: Prisma.SortOrder = sp.get("sortOrder") === "desc" ? "desc" : "asc"
  // Tri par défaut « position » : groupe par statut (Kanban) puis position.
  const orderBy: Prisma.TaskOrderByWithRelationInput[] =
    sortBy === "position"
      ? [{ status: sortOrder }, { position: sortOrder }]
      : [{ [sortBy]: { sort: sortOrder, nulls: "last" } } as Prisma.TaskOrderByWithRelationInput]

  // ── Pagination ────────────────────────────────────────────────────────────
  const page = Math.max(1, Number(sp.get("page")) || 1)
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(sp.get("limit")) || DEFAULT_LIMIT))

  const [tasks, total] = await Promise.all([
    db.task.findMany({
      where,
      orderBy,
      skip: (page - 1) * limit,
      take: limit,
      include: TASK_INCLUDE,
    }),
    db.task.count({ where }),
  ])

  return NextResponse.json({ tasks: tasks.map(taskDto), page, limit, total })
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const limit = rateLimit(`tasks:create:${user.id}`, 30)
  if (!limit.ok) return tooManyRequests(limit)

  const parsed = taskCreateSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }

  // Lien événement : vérification d'ownership explicite (le where du create
  // ne protège pas cette relation)
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

  const task = await createTaskWithRelations(user.id, parsed.data)

  // Webhook « task.created » — fire-and-forget, jamais bloquant.
  void triggerWebhooks(user.id, "task.created", taskDto(task)).catch(() => {})

  return NextResponse.json({ task: taskDto(task) }, { status: 201 })
}
