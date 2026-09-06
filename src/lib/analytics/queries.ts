import "server-only";

// Orbit — Analytics : agrégats + séries pour la section « Analytique » du
// dashboard (Task 20-c). Zéro route dédiée aux calculs : tout se fait ici,
// l'API /api/analytics ne fait qu'auth + rate-limit + sérialisation.
// ─────────────────────────────────────────────────────────────────────────────
// MÊME APPROCHE QUE /api/stats & /api/tasks/stats (cf. worklog 12-c) :
//  • le fuseau de RÉFÉRENCE est celui du PROFIL (User.timezone, repli UTC) ;
//  • le bucketing par jour est fait en JS via dayKeyInTz (Intl "en-CA",
//    clés "yyyy-MM-dd" propres) — JAMAIS via GROUP BY SQL (SQLite dater()
//    inexistant et fuseau serveur non pertinent) ;
//  • la semaine ISO (lundi → dimanche) est calculée avec date-fns
//    startOfWeek/endOfWeek (weekStartsOn: 1) appliqués à « aujourd'hui »
//    DANS le fuseau du profil (date murale), puis reconvertis en instants
//    UTC réels pour les filtres Prisma ;
//  • le serveur ne connaît pas la locale UI : `label` = "MM-dd" court, le
//    composant client reconstruit le jour de semaine localisé (date-fns).

import { endOfWeek, startOfWeek } from "date-fns";
import { db } from "@/lib/db";
import { loadExpandedEvents } from "@/lib/events-service";
import { dayKeyInTz, isValidTimezone, utcToWall, wallToUtc } from "@/lib/timezone";
import {
  type AnalyticsDto,
  type AnalyticsPriority,
  type AnalyticsStatus,
} from "./types";

// Ré-export du DTO partagé (le type vit dans types.ts, importable client).
export type { AnalyticsDto, AnalyticsPriority, AnalyticsStatus } from "./types";

/** Ordre stable des seaux (le client s'appuie sur cet ordre pour les charts). */
const STATUS_BUCKETS = ["todo", "doing", "done"] as const satisfies readonly AnalyticsStatus[];
const PRIORITY_BUCKETS = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const satisfies readonly AnalyticsPriority[];

export async function getAnalytics(userId: string): Promise<AnalyticsDto> {
  const now = new Date();

  // ── 1er lot parallèle : agrégats indépendants du fuseau + profil ──────────
  const [userRow, activeTasks, overdue, unreadEmails, statusGroups, priorityGroups] =
    await Promise.all([
      db.user.findUnique({ where: { id: userId }, select: { timezone: true } }),
      // Tâches actives = à faire + en cours (l'archivage est un soft delete)
      db.task.count({ where: { userId, status: { in: ["todo", "doing"] } } }),
      // En retard : échéance passée, ni terminée ni archivée (lt exclut null)
      db.task.count({
        where: { userId, status: { notIn: ["done", "archived"] }, dueDate: { lt: now } },
      }),
      db.emailLog.count({ where: { userId, isRead: false, folder: "INBOX" } }),
      db.task.groupBy({
        by: ["status"],
        where: { userId, status: { not: "archived" } },
        _count: { _all: true },
      }),
      db.task.groupBy({
        by: ["priority"],
        where: { userId, status: { not: "archived" } },
        _count: { _all: true },
      }),
    ]);

  // Fuseau de référence : préférence profil → UTC (défensif si IANA invalide)
  const tz =
    userRow?.timezone && isValidTimezone(userRow.timezone) ? userRow.timezone : "UTC";

  // ── Calendrier « mural » dans le fuseau du profil ─────────────────────────
  const todayWall = utcToWall(now, tz);
  const y = todayWall.getUTCFullYear();
  const m = todayWall.getUTCMonth();
  const d = todayWall.getUTCDate();

  // Semaine courante (lundi → dimanche) autour d'« aujourd'hui » dans le fuseau :
  // date-fns sur une date formatable (champs locaux = champs muraux), puis
  // wallToUtc pour retrouver les instants UTC réels des bornes (DST-safe).
  const todayFormatable = new Date(y, m, d);
  const weekStartWall = startOfWeek(todayFormatable, { weekStartsOn: 1 });
  const weekEndWall = endOfWeek(todayFormatable, { weekStartsOn: 1 });
  const weekStart = wallToUtc(
    new Date(
      Date.UTC(
        weekStartWall.getFullYear(),
        weekStartWall.getMonth(),
        weekStartWall.getDate(),
        0,
        0,
        0
      )
    ),
    tz
  );
  const weekEnd = wallToUtc(
    new Date(
      Date.UTC(
        weekEndWall.getFullYear(),
        weekEndWall.getMonth(),
        weekEndWall.getDate(),
        23,
        59,
        59,
        999
      )
    ),
    tz
  );

  // 14 derniers jours (aujourd'hui en dernier) : clés murales yyyy-MM-dd.
  const dayKeys: string[] = [];
  for (let i = 13; i >= 0; i--) {
    dayKeys.push(new Date(Date.UTC(y, m, d - i)).toISOString().slice(0, 10));
  }
  // 00:00 murale du plus vieux jour → borne basse des findMany (peuple les
  // buckets ET couvre toute la semaine courante, lundi ≤ 6 jours dans le passé).
  const rangeStart = wallToUtc(new Date(Date.UTC(y, m, d - 13, 0, 0, 0)), tz);

  // ── 2e lot parallèle : requêtes dépendant des bornes (fuseau) ─────────────
  const [completedThisWeek, weekEvents, completions, emails] = await Promise.all([
    db.task.count({ where: { userId, completedAt: { gte: weekStart, lte: weekEnd } } }),
    // Occurrences EXPANSÉES (récurrences incluses) — même moteur que /api/stats
    // pour rester cohérent avec la carte « Semaine à venir » affichée à côté.
    loadExpandedEvents(userId, weekStart, weekEnd),
    db.task.findMany({
      where: { userId, completedAt: { gte: rangeStart } },
      select: { completedAt: true },
    }),
    db.emailLog.findMany({
      where: { userId, folder: "INBOX", receivedAt: { gte: rangeStart } },
      select: { receivedAt: true },
    }),
  ]);

  // ── Bucketing JS par jour calendaire local (fuseau du profil) ─────────────
  const productivity = dayKeys.map((date) => ({
    date,
    label: date.slice(5), // "MM-dd" — le client reformate avec sa locale
    completed: completions.filter(
      (t) => t.completedAt !== null && dayKeyInTz(t.completedAt, tz) === date
    ).length,
  }));

  const emailsPerDay = dayKeys.map((date) => ({
    date,
    label: date.slice(5),
    count: emails.filter((e) => dayKeyInTz(e.receivedAt, tz) === date).length,
  }));

  // Répartitions stables (seaux toujours présents, compteurs à 0 inclus)
  const byStatus: AnalyticsDto["byStatus"] = STATUS_BUCKETS.map((status) => ({
    status,
    count: statusGroups.find((g) => g.status === status)?._count._all ?? 0,
  }));
  const byPriority: AnalyticsDto["byPriority"] = PRIORITY_BUCKETS.map((priority) => ({
    priority,
    count: priorityGroups.find((g) => g.priority === priority)?._count._all ?? 0,
  }));

  // Taux de complétion : done / (todo + doing + done), archivé exclu
  const doneCount = byStatus.find((s) => s.status === "done")?.count ?? 0;
  const statusTotal = byStatus.reduce((sum, s) => sum + s.count, 0);

  const analytics: AnalyticsDto = {
    totals: {
      activeTasks,
      completedThisWeek,
      overdue,
      unreadEmails,
      completionRate: statusTotal === 0 ? 0 : doneCount / statusTotal,
      eventsThisWeek: weekEvents.length,
    },
    productivity,
    byStatus,
    byPriority,
    emailsPerDay,
  };
  return analytics;
}
