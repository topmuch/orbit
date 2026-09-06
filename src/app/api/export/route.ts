// GET /api/export + POST /api/export — Import/Export de données (features avancées)
// ─────────────────────────────────────────────────────────────────────────────
// GET ?format=json            → sauvegarde complète (events + tasks + tags) en
//                               fichier .json téléchargeable (Content-Disposition)
// GET ?format=csv&type=tasks  → export CSV des tâches (UTF-8 BOM pour Excel)
// POST (body JSON, même format que l'export) → import : événements upsertés par
//    externalId (idempotent), tâches créées via le service existant (tags
//    upsertés par nom). L'iCal des événements reste sur /api/events/export.
// Tout est scopé à l'utilisateur de session. Rate limit strict (imports lourds).

import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { createTaskWithRelations, taskDto, TASK_INCLUDE } from "@/lib/tasks-service"
import { toEventDto } from "@/lib/dto"
import { sanitizeText, toJsonInput } from "@/lib/events-service"
import type { Prisma } from "@prisma/client"

/** Échappe une valeur CSV (guillemets, séparateurs, retours ligne). */
function csvCell(value: unknown): string {
  const str = value === null || value === undefined ? "" : String(value)
  if (/[",\n\r]/.test(str)) return `"${str.replace(/"/g, '""')}"`
  return str
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const rl = rateLimit(`export:${user.id}`, 10)
  if (!rl.ok) return tooManyRequests(rl)

  const { searchParams } = new URL(req.url)
  const format = searchParams.get("format") ?? "json"

  // ── CSV des tâches ────────────────────────────────────────────────────────
  if (format === "csv") {
    const tasks = await db.task.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      include: TASK_INCLUDE,
    })
    const header = "id;title;description;status;priority;dueDate;completedAt;tags;createdAt"
    const lines = tasks.map((t) =>
      [
        t.id,
        t.title,
        t.description ?? "",
        t.status,
        t.priority,
        t.dueDate?.toISOString() ?? "",
        t.completedAt?.toISOString() ?? "",
        t.tags.map((tag) => tag.name).join("|"),
        t.createdAt.toISOString(),
      ]
        .map(csvCell)
        .join(";")
    )
    // BOM UTF-8 : ouverture propre dans Excel (séparateur ; = fr-FR friendly).
    const csv = "\uFEFF" + [header, ...lines].join("\r\n")
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="orbit-tasks-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    })
  }

  // ── JSON complet (sauvegarde) ─────────────────────────────────────────────
  const [events, tasks, tags] = await Promise.all([
    db.event.findMany({ where: { userId: user.id }, orderBy: { startTime: "asc" } }),
    db.task.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      include: TASK_INCLUDE,
    }),
    db.tag.findMany({ where: { userId: user.id } }),
  ])

  const backup = {
    version: 1,
    app: "orbit",
    exportedAt: new Date().toISOString(),
    events: events.map(toEventDto),
    // Corps d'emails volontairement exclus : la sauvegarde ne contient que du
    // contenu applicatif léger (calendrier + tâches), jamais la boîte mail.
    tasks: tasks.map(taskDto),
    tags: tags.map((t) => ({ name: t.name, color: t.color })),
  }

  return new NextResponse(JSON.stringify(backup, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="orbit-backup-${new Date().toISOString().slice(0, 10)}.json"`,
    },
  })
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const rl = rateLimit(`import:${user.id}`, 5, 60_000)
  if (!rl.ok) return tooManyRequests(rl)

  const body = await req.json().catch(() => null)
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "JSON invalide" }, { status: 400 })
  }
  const payload = body as {
    events?: unknown[]
    tasks?: unknown[]
  }
  if (!Array.isArray(payload.events) && !Array.isArray(payload.tasks)) {
    return NextResponse.json(
      { error: "Format inconnu — attendu : { events?: [], tasks?: [] }" },
      { status: 400 }
    )
  }

  let importedEvents = 0
  let skippedEvents = 0
  let importedTasks = 0
  const warnings: string[] = []

  // ── Événements : upsert idempotent par externalId+userId ──────────────────
  for (const raw of payload.events ?? []) {
    const ev = raw as Record<string, unknown>
    const title = typeof ev.title === "string" ? sanitizeText(ev.title) : ""
    const start = typeof ev.startTime === "string" ? new Date(ev.startTime) : null
    const end = typeof ev.endTime === "string" ? new Date(ev.endTime) : null
    if (!title || !start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      skippedEvents++
      continue
    }
    if (end <= start) {
      skippedEvents++
      continue
    }
    const externalId = typeof ev.externalId === "string" ? ev.externalId : null
    // Doublon : même externalId déjà importé → on saute (idempotence).
    if (externalId) {
      const existing = await db.event.findFirst({
        where: { userId: user.id, externalId },
        select: { id: true },
      })
      if (existing) {
        skippedEvents++
        continue
      }
    }
    await db.event.create({
      data: {
        userId: user.id,
        title,
        description: typeof ev.description === "string" ? sanitizeText(ev.description) || null : null,
        location: typeof ev.location === "string" ? sanitizeText(ev.location) || null : null,
        startTime: start,
        endTime: end,
        allDay: ev.allDay === true,
        timezone: typeof ev.timezone === "string" ? ev.timezone : "UTC",
        color: typeof ev.color === "string" ? ev.color : null,
        source: "import",
        externalId,
        reminderLog: [],
      },
    })
    importedEvents++
  }

  // ── Tâches : création via le service existant (tags upsertés par nom) ─────
  for (const raw of payload.tasks ?? []) {
    const t = raw as Record<string, unknown>
    const title = typeof t.title === "string" ? t.title.trim() : ""
    if (!title) continue
    try {
      await createTaskWithRelations(user.id, {
        title,
        description: typeof t.description === "string" ? t.description : null,
        status: t.status === "doing" || t.status === "done" || t.status === "archived" ? t.status : "todo",
        priority:
          t.priority === "LOW" || t.priority === "HIGH" || t.priority === "URGENT" ? t.priority : "MEDIUM",
        dueDate: typeof t.dueDate === "string" && !Number.isNaN(Date.parse(t.dueDate)) ? t.dueDate : null,
        tags: Array.isArray(t.tags)
          ? (t.tags as { name?: unknown; color?: unknown }[])
              .filter((tag) => typeof tag?.name === "string" && tag.name.trim())
              .slice(0, 20)
              .map((tag) => ({ name: String(tag.name).trim(), color: typeof tag.color === "string" ? tag.color : undefined }))
          : undefined,
        subtasks: Array.isArray(t.subtasks)
          ? (t.subtasks as { title?: unknown }[])
              .filter((st) => typeof st?.title === "string" && st.title.trim())
              .slice(0, 50)
              .map((st) => ({ title: st.title as string }))
          : undefined,
      })
      importedTasks++
    } catch {
      warnings.push(`Tâche ignorée : « ${title.slice(0, 40)} »`)
    }
  }

  return NextResponse.json({
    imported: { events: importedEvents, tasks: importedTasks },
    skipped: { events: skippedEvents },
    warnings,
  })
}
