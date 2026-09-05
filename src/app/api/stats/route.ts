// GET /api/stats — Agrégats pour le tableau de bord
import { NextResponse } from "next/server"
import {
  addDays,
  startOfDay,
  endOfDay,
  startOfWeek,
  endOfWeek,
  endOfToday,
  isBefore,
} from "date-fns"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { toEventDto, toTaskDto, toEmailDto } from "@/lib/dto"
import type { StatsDto } from "@/lib/types"

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const now = new Date()

  const [events, tasks, emails] = await Promise.all([
    db.event.findMany({
      where: {
        userId: user.id,
        startTime: { gte: startOfWeek(now, { weekStartsOn: 1 }), lte: endOfWeek(now, { weekStartsOn: 1 }) },
      },
      orderBy: { startTime: "asc" },
    }),
    db.task.findMany({ where: { userId: user.id } }),
    db.emailLog.findMany({
      where: { userId: user.id },
      orderBy: { receivedAt: "desc" },
      take: 5,
    }),
  ])

  // Charge de la semaine (7 jours à venir, à partir d'aujourd'hui)
  const weekLoad: StatsDto["weekLoad"] = []
  for (let i = 0; i < 7; i++) {
    const day = addDays(startOfDay(now), i)
    const next = addDays(day, 1)
    weekLoad.push({
      date: day.toISOString(),
      count: events.filter((e) => e.startTime >= day && e.startTime < next).length,
    })
  }

  const todayEvents = events.filter(
    (e) => e.startTime >= startOfDay(now) && e.startTime <= endOfDay(now)
  )
  const nextEvent =
    events.find((e) => e.startTime >= now) ?? null

  const pendingTasks = tasks.filter((t) => t.status !== "done")
  const priorityTasks = [...pendingTasks]
    .sort((a, b) => {
      const dueA = a.dueDate ? a.dueDate.getTime() : Infinity
      const dueB = b.dueDate ? b.dueDate.getTime() : Infinity
      if (b.priority !== a.priority) return b.priority - a.priority
      return dueA - dueB
    })
    .slice(0, 5)

  const stats: StatsDto = {
    eventsToday: todayEvents.length,
    tasksTodo: tasks.filter((t) => t.status === "todo").length,
    tasksDoing: tasks.filter((t) => t.status === "doing").length,
    tasksDone: tasks.filter((t) => t.status === "done").length,
    tasksOverdue: pendingTasks.filter((t) => t.dueDate && isBefore(t.dueDate, now)).length,
    unreadEmails: await db.emailLog.count({ where: { userId: user.id, isRead: false } }),
    unprocessedEmails: await db.emailLog.count({
      where: { userId: user.id, isProcessed: false },
    }),
    nextEvent: nextEvent ? toEventDto(nextEvent) : null,
    todayEvents: todayEvents.map(toEventDto),
    priorityTasks: priorityTasks.map(toTaskDto),
    recentEmails: emails.map(toEmailDto),
    weekLoad,
  }

  return NextResponse.json({ stats })
}
