// GET /api/stats — Agrégats pour le tableau de bord
// ─────────────────────────────────────────────────────────────────────────────
// ?tz=IANA (optionnel) : fuseau de regroupement des jours (défaut UTC). Les
// séries récurrentes sont EXPANSÉES (cf. lib/events-service.ts) pour que le
// tableau de bord, la charge de semaine et le « prochain événement » reflètent
// les occurrences réelles. weekLoad.date = clé « yyyy-MM-dd » du jour dans le
// fuseau (à formater côté client sans reparsing Date).

import { NextRequest, NextResponse } from "next/server"
import { addDays, isBefore } from "date-fns"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { toEmailDto } from "@/lib/dto"
import { loadExpandedEvents } from "@/lib/events-service"
import { TASK_INCLUDE, taskDto } from "@/lib/tasks-service"
import { priorityWeight } from "@/lib/tasks"
import { dayKeyInTz, isValidTimezone, utcToWall } from "@/lib/timezone"
import type { StatsDto, EventDto } from "@/lib/types"

export async function GET(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const tzParam = new URL(req.url).searchParams.get("tz")
  const tz = tzParam && isValidTimezone(tzParam) ? tzParam : "UTC"

  const now = new Date()

  // Agenda élargi : cette semaine (UTC) + marge de 7 jours, expansions incluses
  const [events, tasks, emails, userRow] = await Promise.all([
    loadExpandedEvents(user.id, new Date(now.getTime() - 14 * 86_400_000), addDays(now, 21)),
    db.task.findMany({ where: { userId: user.id }, include: TASK_INCLUDE }),
    db.emailLog.findMany({
      where: { userId: user.id },
      orderBy: { receivedAt: "desc" },
      take: 5,
    }),
    db.user.findUnique({ where: { id: user.id }, select: { timezone: true } }),
  ])

  // Fuseau de regroupement : paramètre explicite > préférence profil > UTC
  const effectiveTz = tzParam ? tz : userRow?.timezone && isValidTimezone(userRow.timezone) ? userRow.timezone : "UTC"
  const todayKey = dayKeyInTz(now, effectiveTz)

  // Charge de la semaine (7 jours à venir, à partir d'aujourd'hui dans le fuseau)
  const weekLoad: StatsDto["weekLoad"] = []
  const todayWall = utcToWall(now, effectiveTz)
  const baseY = todayWall.getUTCFullYear()
  const baseM = todayWall.getUTCMonth()
  const baseD = todayWall.getUTCDate()
  for (let i = 0; i < 7; i++) {
    const key = new Date(Date.UTC(baseY, baseM, baseD + i)).toISOString().slice(0, 10)
    weekLoad.push({
      date: key,
      count: events.filter((e) => dayKeyInTz(new Date(e.startTime), effectiveTz) === key).length,
    })
  }

  const todayEvents = events.filter((e) => dayKeyInTz(new Date(e.startTime), effectiveTz) === todayKey)
  const nextEvent: EventDto | null = events.find((e) => new Date(e.startTime) >= now) ?? null

  // Tâches actives = non archivées (l'archivage est un soft delete)
  const activeTasks = tasks.filter((t) => t.status !== "archived")
  const pendingTasks = activeTasks.filter((t) => t.status !== "done")
  const priorityTasks = [...pendingTasks]
    .sort((a, b) => {
      const dueA = a.dueDate ? a.dueDate.getTime() : Infinity
      const dueB = b.dueDate ? b.dueDate.getTime() : Infinity
      const w = priorityWeight(b.priority) - priorityWeight(a.priority)
      if (w !== 0) return w
      return dueA - dueB
    })
    .slice(0, 5)

  const stats: StatsDto = {
    eventsToday: todayEvents.length,
    tasksTodo: activeTasks.filter((t) => t.status === "todo").length,
    tasksDoing: activeTasks.filter((t) => t.status === "doing").length,
    tasksDone: activeTasks.filter((t) => t.status === "done").length,
    tasksOverdue: pendingTasks.filter((t) => t.dueDate && isBefore(t.dueDate, now)).length,
    unreadEmails: await db.emailLog.count({ where: { userId: user.id, isRead: false } }),
    unprocessedEmails: await db.emailLog.count({
      where: { userId: user.id, isProcessed: false },
    }),
    nextEvent,
    todayEvents,
    priorityTasks: priorityTasks.map(taskDto),
    recentEmails: emails.map((e) => toEmailDto(e)),
    weekLoad,
  }

  return NextResponse.json({ stats })
}
