// GET /api/tasks/stats — Statistiques de tâches
// ─────────────────────────────────────────────────────────────────────────────
// total, byStatus, byPriority, overdue, completedThisWeek, completionRate
// + « week » : 7 derniers jours (aujourd'hui en dernier), tâches complétées
// par jour (clé yyyy-MM-dd locale serveur + label FR court).

import { NextResponse } from "next/server"
import { format, startOfWeek, subDays } from "date-fns"
import { fr } from "date-fns/locale"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { TASK_INCLUDE } from "@/lib/tasks-service"
import { isTaskOverdue } from "@/lib/tasks"
import type { TaskStatsDto, TaskPriority, TaskStatus } from "@/lib/types"

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const now = new Date()
  const tasks = await db.task.findMany({
    where: { userId: user.id },
    include: TASK_INCLUDE,
  })

  const byStatus: Record<TaskStatus, number> = { todo: 0, doing: 0, done: 0, archived: 0 }
  const byPriority: Record<TaskPriority, number> = { LOW: 0, MEDIUM: 0, HIGH: 0, URGENT: 0 }
  for (const t of tasks) {
    const status = (["todo", "doing", "done", "archived"] as TaskStatus[]).includes(
      t.status as TaskStatus
    )
      ? (t.status as TaskStatus)
      : "todo"
    byStatus[status]++
    const priority = (["LOW", "MEDIUM", "HIGH", "URGENT"] as TaskPriority[]).includes(
      t.priority as TaskPriority
    )
      ? (t.priority as TaskPriority)
      : "MEDIUM"
    byPriority[priority]++
  }

  const active = tasks.filter((t) => t.status !== "archived")
  const done = byStatus.done
  const activeTotal = active.length

  // Semaine ISO (lundi) — complétions de la semaine en cours
  const weekStart = startOfWeek(now, { weekStartsOn: 1 })
  const completedThisWeek = active.filter(
    (t) => t.completedAt && t.completedAt >= weekStart
  ).length

  // 7 derniers jours : barres du graphique (complétions par jour calendaire)
  const week: TaskStatsDto["week"] = []
  for (let i = 6; i >= 0; i--) {
    const day = subDays(now, i)
    const key = format(day, "yyyy-MM-dd")
    week.push({
      date: key,
      label: format(day, "EEE", { locale: fr }),
      completed: active.filter((t) => t.completedAt && format(t.completedAt, "yyyy-MM-dd") === key)
        .length,
    })
  }

  const stats: TaskStatsDto = {
    total: tasks.length,
    byStatus,
    byPriority,
    overdue: active.filter((t) =>
      isTaskOverdue(
        { dueDate: t.dueDate ? t.dueDate.toISOString() : null, status: t.status as TaskStatus },
        now
      )
    ).length,
    completedThisWeek,
    completionRate: activeTotal === 0 ? 0 : done / activeTotal,
    week,
  }

  return NextResponse.json({ stats })
}
