// /api/notify — Envoi de notifications Web Push (VAPID) + rappels email locaux
// ─────────────────────────────────────────────────────────────────────────────
// Deux modes d'appel, mutuellement exclusifs :
//
//   1. Test utilisateur (auth par session) :
//      POST { "type": "test" } → envoie une notif aux appareils de l'utilisateur
//
//   2. Rappels automatiques (auth par secret de service — reminder-service :3032) :
//      POST { "type": "reminders" } + header "x-orbit-service-secret"
//      → scanne la base et envoie :
//        • ÉVÉNEMENTS : rappels configurés par événement (reminders JSON,
//          défaut 15 min push), y compris les OCCURRENCES de séries
//          récurrentes (expansion à la volée, cf. lib/calendar.ts).
//          type "push" → Web Push ; type "email" → EmailLog synthétique
//          (« Orbit — rappels ») visible dans la boîte Orbit (100 % local).
//        • TÂCHES non terminées dont l'échéance arrive dans moins d'1 heure.
//      Anti-doublon : reminderLog (clés occurrence::minutes::type, max 200).
//      Les utilisateurs sans appareil ne sont PAS marqués : s'ils s'abonnent
//      avant l'heure, ils recevront quand même leur rappel.

import { NextRequest, NextResponse } from "next/server"
import { format } from "date-fns"
import { fr } from "date-fns/locale"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { formatInTz } from "@/lib/timezone"
import { expandEvent } from "@/lib/calendar"
import { parseReminders, parseRecurrence } from "@/lib/dto"
import type { EventReminder } from "@/lib/types"
import {
  ensureWebPushConfigured,
  isPushConfigured,
  sendPushToUser,
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

// ── Mode 1 : notification de test (session utilisateur) ────────────────────

async function notifyTest(userId: string): Promise<Response> {
  if (!ensureWebPushConfigured()) {
    return NextResponse.json(
      { error: "Notifications non configurées (clés VAPID absentes)" },
      { status: 503 }
    )
  }

  const report = await sendPushToUser(userId, {
    title: "Orbit 🪐",
    body: "Parfait ! Vous recevrez vos rappels d'événements (15 min avant) et de tâches (1 h avant) ici.",
    tag: "orbit-test",
    kind: "test",
  })

  if (report.sent === 0 && report.removed === 0 && report.failed === 0) {
    return NextResponse.json(
      { error: "Aucun appareil abonné — activez d'abord les notifications push." },
      { status: 400 }
    )
  }

  return NextResponse.json({ ok: true, report })
}

// ── Mode 2 : rappels automatiques (secret de service) ──────────────────────

const TASK_LEAD_MS = 60 * 60 * 1000 // 1 heure avant l'échéance d'une tâche
/** Horizon de scan : couvre les rappels configurables (jusqu'à 14 jours). */
const LOOKAHEAD_MS = 15 * 24 * 60 * 60 * 1000
/** Grâce après l'heure théorique d'envoi (cycle de 60 s + latence). */
const GRACE_MS = 5 * 60 * 1000
/** Rappel par défaut quand l'événement n'en définit aucun. */
const DEFAULT_EVENT_REMINDERS: EventReminder[] = [{ minutes: 15, type: "push" }]
/** Taille max du journal anti-doublon par événement. */
const LOG_MAX = 200

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
  let emailsSent = 0

  // ── Événements (simples + occurrences de séries) ────────────────────────
  const candidates = await db.event.findMany({
    where: {
      startTime: { gte: new Date(now.getTime() - GRACE_MS), lte: new Date(now.getTime() + LOOKAHEAD_MS) },
    },
    take: 200,
  })

  for (const event of candidates) {
    const configured = parseReminders(event.reminders)
    // Pont legacy : événement déjà notifié par l'ancien système (reminderSentAt)
    // et sans rappels explicites → considéré comme déjà rappelé.
    if (!configured && event.reminderSentAt) continue

    const reminders = configured ?? DEFAULT_EVENT_REMINDERS

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

        if (reminder.type === "push") {
          const r = await sendPushToUser(event.userId, {
            title: "Orbit — rappel d'événement",
            body: `${humanLead(reminder.minutes)} : ${event.title} (${formatInTz(occ.start, event.timezone, { hour: "2-digit", minute: "2-digit" })})`,
            tag: `event-${event.id}-${occKey}-${reminder.minutes}`,
            kind: "event",
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

  // ── Tâches non terminées/non archivées échuant dans moins d'1 heure ─────
  const dueTasks = await db.task.findMany({
    where: {
      reminderSentAt: null,
      status: { notIn: ["done", "archived"] },
      dueDate: { gte: now, lte: new Date(now.getTime() + TASK_LEAD_MS) },
    },
    take: 50,
  })

  for (const task of dueTasks) {
    const r = await sendPushToUser(task.userId, {
      title: "Orbit — échéance imminente",
      body: `${task.title} — prévue à ${format(task.dueDate!, "HH:mm", { locale: fr })}`,
      tag: `task-${task.id}`,
      kind: "task",
    })
    report.sent += r.sent
    report.removed += r.removed
    report.failed += r.failed
    if (r.sent > 0 || r.removed > 0) {
      await db.task.update({ where: { id: task.id }, data: { reminderSentAt: now } })
      tasksNotified++
    }
  }

  return NextResponse.json({
    ok: true,
    scannedAt: now.toISOString(),
    eventsNotified,
    emailsSent,
    tasksNotified,
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

  if (type === "test") {
    // Notification de test : session utilisateur requise.
    const user = await getSessionUser()
    if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
    return notifyTest(user.id)
  }

  return NextResponse.json(
    { error: "type invalide (valeurs : \"test\" | \"reminders\")" },
    { status: 400 }
  )
}

export async function GET() {
  // Diagnostic simple : état de la configuration push (sans exposer les clés).
  return NextResponse.json({
    configured: isPushConfigured(),
    types: ["test (session)", "reminders (secret de service)"],
  })
}
