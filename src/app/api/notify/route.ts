// /api/notify — Envoi de notifications Web Push (VAPID) + rappels email locaux
// ─────────────────────────────────────────────────────────────────────────────
// Modes d'appel :
//
//   1. Test utilisateur (auth par session) :
//      POST { "type": "test" } → envoie une notif aux appareils de l'utilisateur
//
//   2. Alertes personnalisées (auth par session, corps validé) :
//      POST { "type": "custom", title, body } → push + historique (spec
//      « alertes personnalisées »). Rate limité.
//      POST { "type": "custom", title, body, scheduledAt (ISO futur, max 7 j) }
//      → FILE D'ATTENTE planifiée : Notification.scheduledAt, envoyée à
//      l'échéance par le cycle (reminders) — queue indépendante de la
//      connexion client (le serveur envoie même app fermée).
//
//   3. Rappels automatiques (auth par secret de service — reminder-service :3032) :
//      POST { "type": "reminders" } + header "x-orbit-service-secret"
//      → scanne la base et envoie, en respectant les PRÉFÉRENCES de chaque
//        utilisateur (types activés, heures calmes sauf imminence < 15 min) :
//        • ÉVÉNEMENTS : rappels configurés par événement (reminders JSON,
//          défaut = préférence eventReminderTime, 15 min), occurrences de
//          séries incluses ; type "push" → Web Push, type "email" → EmailLog
//          synthétique (« Orbit — rappels », 100 % local).
//        • TÂCHES : « échéance aujourd'hui » (une fois/jour/tâche, heures
//          restantes) + imminence H-1 (filet de sécurité existant).
//        • EMAILS IMPORTANTS : l'IA a détecté un rendez-vous (suggestedEvent)
//          non confirmé → « à traiter » (une seule fois par email).
//        • FILE PLANIFIÉE : Notification.scheduledAt échues non envoyées →
//          envoi immédiat (sendExistingNotification).
//      Anti-doublons : reminderLog (occurrence::minutes::type) pour les
//      événements, reminderSentAt (H-1) pour les tâches, et Notification
//      (type + ids, filtrage mémoire — SQLite sans JSON path filter) pour
//      les scans journaliers. Les utilisateurs sans appareil ne sont PAS
//      marqués : s'ils s'abonnent avant l'heure, ils recevront leur rappel.
//      Hygiène : purge des notifications > 30 jours à chaque cycle.
//
//   4. Synchronisation email (auth par secret de service — reminder-service) :
//      POST { "type": "email-sync" } + header "x-orbit-service-secret"
//      → synchronise les comptes IMAP ÉCHUS (lastSyncAt + intervalle écoulé),
//      lecture seule (lib/imap). Aucune action si aucun compte n'est dû.
import { NextRequest, NextResponse } from "next/server"
import { format, startOfDay, endOfDay } from "date-fns"
import { fr } from "date-fns/locale"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { formatInTz } from "@/lib/timezone"
import { expandEvent } from "@/lib/calendar"
import { parseReminders, parseRecurrence } from "@/lib/dto"
import type { EventReminder, NotificationPreferenceDto } from "@/lib/types"
import { Prisma } from "@prisma/client"
import { notificationSendSchema } from "@/lib/validators"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { syncDueAccounts } from "@/lib/imap"
import {
  cleanupOldNotifications,
  ensureWebPushConfigured,
  isPushConfigured,
  isQuietHours,
  sendPushToUser,
  sendExistingNotification,
  type PushSendReport,
} from "@/lib/push"

export const runtime = "nodejs"
export const maxDuration = 60

/** Auth par secret de service (rappels automatiques, sans session navigateur). */
function isServiceAuthorized(req: NextRequest): boolean {
  const expected = process.env.REMINDER_SERVICE_SECRET
  if (!expected) return false
  return req.headers.get("x-orbit-service-secret") === expected
}

// ── Préférences (créées à la volée, cache du cycle) ─────────────────────────

async function getPrefs(userId: string): Promise<NotificationPreferenceDto> {
  const existing = await db.notificationPreference.findUnique({ where: { userId } })
  const pref = existing ?? (await db.notificationPreference.create({ data: { userId } }))
  return {
    eventReminder: pref.eventReminder,
    taskDeadline: pref.taskDeadline,
    importantEmail: pref.importantEmail,
    aiSuggestion: pref.aiSuggestion,
    eventReminderTime: pref.eventReminderTime,
    quietHoursEnabled: pref.quietHoursEnabled,
    quietHoursStart: pref.quietHoursStart,
    quietHoursEnd: pref.quietHoursEnd,
  }
}

/** Charge (prefs, fuseau) pour un lot d'utilisateurs (cache mémoire du cycle). */
async function userContexts(userIds: string[]) {
  const users = await db.user.findMany({
    where: { id: { in: userIds } },
    include: { notificationPreference: true },
  })
  const map = new Map<string, { prefs: NotificationPreferenceDto; timezone: string }>()
  for (const u of users) {
    map.set(u.id, {
      prefs: {
        eventReminder: u.notificationPreference?.eventReminder ?? true,
        taskDeadline: u.notificationPreference?.taskDeadline ?? true,
        importantEmail: u.notificationPreference?.importantEmail ?? true,
        aiSuggestion: u.notificationPreference?.aiSuggestion ?? false,
        eventReminderTime: u.notificationPreference?.eventReminderTime ?? 15,
        quietHoursEnabled: u.notificationPreference?.quietHoursEnabled ?? false,
        quietHoursStart: u.notificationPreference?.quietHoursStart ?? null,
        quietHoursEnd: u.notificationPreference?.quietHoursEnd ?? null,
      },
      timezone: u.timezone || "UTC",
    })
  }
  return map
}

/**
 * Les heures calmes bloquent les envois SAUF l'imminence forte (< 15 min
 * avant un événement) : ne jamais faire rater un rendez-vous à l'utilisateur.
 * Les notifications bloquées ne sont pas marquées → elles seront re-évaluées
 * au prochain cycle (et envoyées si la fenêtre de grâce le permet encore).
 */
function blockedByQuietHours(
  prefs: NotificationPreferenceDto,
  timezone: string,
  now: Date,
  imminent: boolean
): boolean {
  if (!prefs.quietHoursEnabled) return false
  if (imminent) return false
  return isQuietHours(prefs, now, timezone)
}

/** Anti-doublon mémoire (SQLite : pas de JSON path filter Prisma). */
function alreadyNotified(
  notifications: { type: string; data: unknown }[],
  type: string,
  key: string,
  value: string
): boolean {
  return notifications.some((n) => {
    if (n.type !== type) return false
    const data = (n.data ?? {}) as Record<string, unknown>
    return data[key] === value
  })
}

// ── Mode 1 : notification de test (session utilisateur) ────────────────────

async function notifyTest(userId: string): Promise<Response> {
  if (!ensureWebPushConfigured()) {
    return NextResponse.json(
      { error: "Notifications non configurées (clés VAPID absentes)" },
      { status: 503 }
    )
  }

  const report = await sendPushToUser(
    userId,
    {
      title: "Orbit 🪐",
      body: "Parfait ! Vous recevrez ici vos rappels d'événements, d'échéances de tâches et d'emails importants.",
      tag: "orbit-test",
      kind: "test",
      type: "SYSTEM",
    },
    { persist: false }
  )

  if (report.sent === 0 && report.removed === 0 && report.failed === 0) {
    return NextResponse.json(
      { error: "Aucun appareil abonné — activez d'abord les notifications push." },
      { status: 400 }
    )
  }

  return NextResponse.json({ ok: true, report })
}

// ── Mode 2 : alerte personnalisée (session utilisateur) ─────────────────────

/**
 * scheduledAt fourni (futur) : l'alerte rejoint la FILE D'ATTENTE planifiée
 * (Notification.scheduledAt, isSent=false) — aucun envoi immédiat, le cycle
 * « reminders » l'enverra pile à l'échéance (queue serveur, indépendante
 * de la connexion du client). Sans scheduledAt : envoi immédiat.
 */
async function notifyCustom(
  userId: string,
  title: string,
  body: string,
  tag?: string,
  scheduledAt?: string
): Promise<Response> {
  if (!ensureWebPushConfigured()) {
    return NextResponse.json(
      { error: "Notifications non configurées (clés VAPID absentes)" },
      { status: 503 }
    )
  }

  if (scheduledAt) {
    const notification = await db.notification.create({
      data: {
        userId,
        type: "CUSTOM",
        title: title.trim().slice(0, 100),
        body: body.trim().slice(0, 500),
        data: { view: "notifications" },
        isSent: false,
        scheduledAt: new Date(scheduledAt),
      },
    })
    return NextResponse.json({ ok: true, scheduled: true, notificationId: notification.id })
  }

  const report = await sendPushToUser(userId, {
    title,
    body,
    tag: tag ?? "orbit-custom",
    kind: "test",
    type: "CUSTOM",
    data: {},
  })

  return NextResponse.json({ ok: true, report })
}

// ── Mode 3 : rappels automatiques (secret de service) ──────────────────────

/** Imminence H-1 des tâches (système d'origine). */
const TASK_LEAD_MS = 60 * 60 * 1000
/** Horizon de scan : couvre les rappels configurables (jusqu'à 14 jours). */
const LOOKAHEAD_MS = 15 * 24 * 60 * 60 * 1000
/** Grâce après l'heure théorique d'envoi (cycle de 60 s + latence). */
const GRACE_MS = 5 * 60 * 1000
/** Imminence « forte » : passe outre les heures calmes. */
const IMMINENT_MINUTES = 15
/** Taille max du journal anti-doublon par événement. */
const LOG_MAX = 200
/** Emails importants : fenêtre de détection (reçus il y a moins de…). */
const EMAIL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

function parseLog(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return (raw as unknown[]).filter((s): s is string => typeof s === "string")
}

/** « Dans 15 min » / « Dans 2 h » / « Dans 3 j » */
function humanLead(minutes: number): string {
  if (minutes < 60) return `Dans ${minutes} min`
  if (minutes < 1440) {
    const h = Math.floor(minutes / 60)
    const m = minutes % 60
    return m ? `Dans ${h} h ${m}` : `Dans ${h} h`
  }
  const days = Math.floor(minutes / 1440)
  return `Dans ${days} j`
}

async function notifyReminders(): Promise<Response> {
  if (!ensureWebPushConfigured()) {
    return NextResponse.json(
      { error: "Notifications non configurées (clés VAPID absentes)" },
      { status: 503 }
    )
  }

  const now = new Date()
  const report: PushSendReport = { sent: 0, removed: 0, failed: 0 }
  let eventsNotified = 0
  let tasksNotified = 0
  let emailsNotified = 0
  let quietBlocked = 0
  let emailsSent = 0
  let scheduledSent = 0

  // Hygiène : purge de l'historique > 30 jours (spec performance).
  const cleaned = await cleanupOldNotifications()

  // ── Contextes utilisateurs (prefs + fuseau) ──────────────────────────────
  const candidateEvents = await db.event.findMany({
    where: {
      startTime: { gte: new Date(now.getTime() - GRACE_MS), lte: new Date(now.getTime() + LOOKAHEAD_MS) },
    },
    take: 200,
  })
  const ctxs = await userContexts([
    ...new Set([
      ...candidateEvents.map((e) => e.userId),
      // (tâches/emails : ajoutés après leur requête respective — Map get paresseux)
    ]),
  ])

  // Contextes utilisateurs (prefs + fuseau) — défauts si préférences absentes
  const DEFAULT_PREFS: NotificationPreferenceDto = {
    eventReminder: true,
    taskDeadline: true,
    importantEmail: true,
    aiSuggestion: false,
    eventReminderTime: 15,
    quietHoursEnabled: false,
    quietHoursStart: null,
    quietHoursEnd: null,
  }
  const ctxOf = (userId: string) =>
    ctxs.get(userId) ?? { prefs: DEFAULT_PREFS, timezone: "UTC" }

  // ── ÉVÉNEMENTS (simples + occurrences de séries) ────────────────────────
  for (const event of candidateEvents) {
    const { prefs, timezone } = ctxOf(event.userId)
    if (!prefs.eventReminder) continue

    const configured = parseReminders(event.reminders)
    // Pont legacy : événement déjà notifié par l'ancien système (reminderSentAt)
    // et sans rappels explicites → considéré comme déjà rappelé.
    if (!configured && event.reminderSentAt) continue

    // Rappel par défaut : préférence utilisateur (spec eventReminderTime)
    const reminders: EventReminder[] = configured ?? [{ minutes: prefs.eventReminderTime, type: "push" }]

    // Occurrences à considérer : l'événement lui-même, ou l'expansion de la
    // série dans la fenêtre de scan.
    const occurrences = expandEvent(
      {
        startTime: event.startTime,
        endTime: event.endTime,
        allDay: event.allDay,
        timezone: event.timezone,
        recurrence: parseRecurrence(event.recurrence),
        recurrenceExceptions: event.recurrenceExceptions,
      },
      new Date(now.getTime() - GRACE_MS),
      new Date(now.getTime() + LOOKAHEAD_MS),
      50
    )
    if (!occurrences.length) continue

    const log = new Set(parseLog(event.reminderLog))
    let dirty = false

    for (const occ of occurrences) {
      const occKey = occ.start.toISOString()
      for (const reminder of reminders) {
        const key = `${occKey}::${reminder.minutes}::${reminder.type}`
        if (log.has(key)) continue

        const sendAt = occ.start.getTime() - reminder.minutes * 60_000
        if (now.getTime() < sendAt || sendAt < now.getTime() - GRACE_MS) continue

        const imminent = reminder.minutes <= IMMINENT_MINUTES
        if (blockedByQuietHours(prefs, timezone, now, imminent)) {
          quietBlocked++
          continue // pas marqué → re-évalué au prochain cycle
        }

        if (reminder.type === "push") {
          const r = await sendPushToUser(event.userId, {
            title: "Orbit — rappel d'événement",
            body: `${humanLead(reminder.minutes)} : ${event.title} (${formatInTz(occ.start, event.timezone, { hour: "2-digit", minute: "2-digit" })})`,
            tag: `event-${event.id}-${occKey}-${reminder.minutes}`,
            kind: "event",
            type: "EVENT_REMINDER",
            data: { view: "calendar", eventId: event.id },
            requireInteraction: imminent,
          })
          report.sent += r.sent
          report.removed += r.removed
          report.failed += r.failed
          // Marqué uniquement si l'utilisateur a des appareils (cf. en-tête)
          if (r.sent > 0 || r.removed > 0) {
            log.add(key)
            dirty = true
            eventsNotified++
          }
        } else {
          // Rappel « email » 100 % local : EmailLog synthétique dans la boîte
          // Orbit (aucun transport SMTP — confidentialité stricte).
          try {
            await db.emailLog.create({
              data: {
                userId: event.userId,
                messageId: `rappel-${event.id}-${occKey}-${reminder.minutes}`,
                fromAddress: "rappels@orbit.app",
                fromName: "Orbit — rappels",
                subject: `Rappel : ${event.title}`,
                bodyText: [
                  `${humanLead(reminder.minutes)} : ${event.title}`,
                  event.allDay
                    ? "Journée entière"
                    : `Le ${formatInTz(occ.start, event.timezone, { weekday: "long", day: "numeric", month: "long" })} de ${formatInTz(occ.start, event.timezone, { hour: "2-digit", minute: "2-digit" })} à ${formatInTz(occ.end, event.timezone, { hour: "2-digit", minute: "2-digit" })} (${event.timezone})`,
                  event.location ? `Lieu : ${event.location}` : "",
                  event.description ? `\n${event.description}` : "",
                ]
                  .filter(Boolean)
                  .join("\n"),
                receivedAt: now,
              },
            })
            log.add(key)
            dirty = true
            emailsSent++
          } catch {
            // collision messageId (déjà envoyé) → rien à faire
          }
        }
      }
    }

    if (dirty) {
      const pruned = [...log].slice(-LOG_MAX)
      await db.event.update({
        where: { id: event.id },
        data: { reminderLog: pruned },
      })
    }
  }

  // ── TÂCHES : échéance aujourd'hui (une fois/jour/tâche) ─────────────────
  const dueToday = await db.task.findMany({
    where: {
      status: { notIn: ["done", "archived"] },
      dueDate: { gte: startOfDay(now), lte: endOfDay(now) },
    },
    take: 100,
  })

  if (dueToday.length) {
    // Contextes des propriétaires (prefs + fuseau) manquants
    const missing = [...new Set(dueToday.map((t) => t.userId))].filter((id) => !ctxs.has(id))
    for (const [id, ctx] of await userContexts(missing)) ctxs.set(id, ctx)

    // Notifications TASK_DEADLINE du jour (anti-doublon mémoire)
    const todays = await db.notification.findMany({
      where: { type: "TASK_DEADLINE", createdAt: { gte: startOfDay(now) } },
      select: { type: true, data: true },
    })

    for (const task of dueToday) {
      const { prefs, timezone } = ctxOf(task.userId)
      if (!prefs.taskDeadline) continue

      // Anti-doublon : déjà notifiée aujourd'hui (queue H-1 incluse)
      if (alreadyNotified(todays, "TASK_DEADLINE", "taskId", task.id)) continue
      if (
        task.reminderSentAt &&
        task.reminderSentAt.getTime() >= startOfDay(now).getTime()
      ) {
        continue
      }

      const hoursLeft = Math.max(0, Math.ceil((task.dueDate!.getTime() - now.getTime()) / 3_600_000))
      const overdue = task.dueDate!.getTime() < now.getTime()

      if (blockedByQuietHours(prefs, timezone, now, false)) {
        quietBlocked++
        continue
      }

      const r = await sendPushToUser(task.userId, {
        title: overdue ? "⏰ Tâche en retard" : "⏰ Tâche à traiter aujourd'hui",
        body: overdue
          ? `${task.title} — échéance dépassée (${format(task.dueDate!, "HH:mm", { locale: fr })})`
          : `${task.title} — ${hoursLeft <= 1 ? "dans moins d'1 h" : `à ${format(task.dueDate!, "HH:mm", { locale: fr })} (dans ${hoursLeft} h)`}`,
        tag: `task-today-${task.id}-${startOfDay(now).getTime()}`,
        kind: "task",
        type: "TASK_DEADLINE",
        data: { view: "tasks", taskId: task.id },
        actions: [
          { action: "view", title: "Voir" },
          { action: "complete", title: "Terminée" },
        ],
      })
      report.sent += r.sent
      report.removed += r.removed
      report.failed += r.failed
      if (r.notificationId) {
        // L'historique sert d'anti-doublon même sans appareil (valeur in-app).
        todays.push({ type: "TASK_DEADLINE", data: { taskId: task.id } })
        tasksNotified++
      }
    }
  }

  // ── TÂCHES : imminence H-1 (filet de sécurité existant) ──────────────────
  const dueTasks = await db.task.findMany({
    where: {
      reminderSentAt: null,
      status: { notIn: ["done", "archived"] },
      dueDate: { gte: now, lte: new Date(now.getTime() + TASK_LEAD_MS) },
    },
    take: 50,
  })

  for (const task of dueTasks) {
    const { prefs } = ctxOf(task.userId)
    if (!prefs.taskDeadline) continue

    // H-1 = imminence : passe outre les heures calmes (cf. blockedByQuietHours).
    const r = await sendPushToUser(task.userId, {
      title: "Orbit — échéance imminente",
      body: `${task.title} — prévue à ${format(task.dueDate!, "HH:mm", { locale: fr })}`,
      tag: `task-${task.id}`,
      kind: "task",
      type: "TASK_DEADLINE",
      data: { view: "tasks", taskId: task.id },
    })
    report.sent += r.sent
    report.removed += r.removed
    report.failed += r.failed
    if (r.sent > 0 || r.removed > 0) {
      await db.task.update({ where: { id: task.id }, data: { reminderSentAt: now } })
      tasksNotified++
    }
  }

  // ── EMAILS IMPORTANTS (flaggés par l'IA) ────────────────────────────────
  const importantEmails = await db.emailLog.findMany({
    where: {
      isProcessed: false,
      // SQLite/Prisma : filtre « JSON non-null » via DbNull
      suggestedEvent: { not: Prisma.DbNull },
      receivedAt: { gte: new Date(now.getTime() - EMAIL_WINDOW_MS) },
    },
    take: 50,
  })

  if (importantEmails.length) {
    const missing = [...new Set(importantEmails.map((e) => e.userId))].filter((id) => !ctxs.has(id))
    for (const [id, ctx] of await userContexts(missing)) ctxs.set(id, ctx)

    // IMPORTANT_EMAIL déjà envoyées (fenêtre 7 j) — anti-doublon mémoire
    const sentEmailNotifs = await db.notification.findMany({
      where: { type: "IMPORTANT_EMAIL", createdAt: { gte: new Date(now.getTime() - EMAIL_WINDOW_MS) } },
      select: { type: true, data: true },
    })

    for (const email of importantEmails) {
      const { prefs, timezone } = ctxOf(email.userId)
      if (!prefs.importantEmail) continue
      if (alreadyNotified(sentEmailNotifs, "IMPORTANT_EMAIL", "emailId", email.id)) continue

      if (blockedByQuietHours(prefs, timezone, now, false)) {
        quietBlocked++
        continue
      }

      const r = await sendPushToUser(email.userId, {
        title: "📧 Email important détecté par l'IA",
        body: `« ${email.subject.slice(0, 80)} » — un rendez-vous y a été détecté, à confirmer.`,
        tag: `email-${email.id}`,
        kind: "email",
        type: "IMPORTANT_EMAIL",
        data: { view: "emails", emailId: email.id },
      })
      report.sent += r.sent
      report.removed += r.removed
      report.failed += r.failed
      if (r.notificationId) {
        sentEmailNotifs.push({ type: "IMPORTANT_EMAIL", data: { emailId: email.id } })
        emailsNotified++
      }
    }
  }

  // ── FILE D'ATTENTE PLANIFIÉE (scheduledAt échues, non envoyées) ──────
  // Alerte programmée par l'utilisateur : l'heure choisie prime sur les
  // heures calmes (choix explicite). Envoi via sendExistingNotification
  // (aucune nouvelle ligne d'historique — la ligne existante est marquée).
  const dueScheduled = await db.notification.findMany({
    where: { scheduledAt: { lte: now }, isSent: false },
    take: 50,
  })
  for (const scheduled of dueScheduled) {
    try {
      const r = await sendExistingNotification(scheduled)
      report.sent += r.sent
      report.removed += r.removed
      report.failed += r.failed
      scheduledSent++
    } catch {
      // configuration VAPID/DB indisponible → retenté au prochain cycle
    }
  }

  return NextResponse.json({
    ok: true,
    scannedAt: now.toISOString(),
    eventsNotified,
    emailsSent,
    tasksNotified,
    emailsNotified,
    scheduledSent,
    quietBlocked,
    cleaned,
    report,
  })
}

// ── Route ───────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { type?: string } | null
  const type = body?.type

  if (type === "reminders") {
    // Rappels automatiques : authentification par secret de service.
    if (!isServiceAuthorized(req)) {
      return NextResponse.json({ error: "Secret de service invalide" }, { status: 401 })
    }
    return notifyReminders()
  }

  if (type === "email-sync") {
    // Synchronisation des comptes IMAP dus : authentification par secret de
    // service (reminder-service :3032). Lecture seule, erreurs isolées par
    // compte — un compte en échec ne bloque jamais le cycle de rappels.
    if (!isServiceAuthorized(req)) {
      return NextResponse.json({ error: "Secret de service invalide" }, { status: 401 })
    }
    try {
      const { due, results } = await syncDueAccounts()
      const created = results.reduce((sum, r) => sum + r.created, 0)
      return NextResponse.json({
        ok: true,
        due,
        created,
        results: results.map((r) => ({
          accountId: r.accountId,
          address: r.address,
          ok: r.ok,
          created: r.created,
          error: r.error ?? undefined,
        })),
      })
    } catch (error) {
      return NextResponse.json(
        { error: `Synchronisation impossible : ${(error as Error).message.slice(0, 200)}` },
        { status: 500 }
      )
    }
  }

  if (type === "test") {
    // Notification de test : session utilisateur + rate limit anti-abus.
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
    const rl = rateLimit(`push:test:${user.id}`, 10, 60_000)
    if (!rl.ok) return tooManyRequests(rl)
    return notifyTest(user.id)
  }

  if (type === "custom") {
    // Alerte personnalisée : session utilisateur + validation stricte.
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
    const rl = rateLimit(`push:custom:${user.id}`, 10, 60_000)
    if (!rl.ok) return tooManyRequests(rl)

    const parsed = notificationSendSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json({ error: "Données invalides" }, { status: 400 })
    }
    const { title, body: customBody, tag, scheduledAt } = parsed.data
    return notifyCustom(user.id, title, customBody, tag, scheduledAt)
  }

  return NextResponse.json(
    { error: "type invalide (valeurs : \"test\" | \"custom\" | \"reminders\" | \"email-sync\")" },
    { status: 400 }
  )
}

export async function GET() {
  // Diagnostic simple : état de la configuration push (sans exposer les clés).
  return NextResponse.json({
    configured: isPushConfigured(),
    types: [
      "test (session)",
      "custom (session — envoi immédiat ou planifié via scheduledAt)",
      "reminders (secret de service)",
      "email-sync (secret de service — comptes IMAP dus)",
    ],
  })
}
