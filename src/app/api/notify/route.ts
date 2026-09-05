// /api/notify — Envoi de notifications Web Push (VAPID)
// ───────────────────────────────────────────────────────────────────────────
// Deux modes d'appel, mutuellement exclusifs :
//
//   1. Test utilisateur (auth par session) :
//      POST { "type": "test" } → envoie une notif aux appareils de l'utilisateur
//
//   2. Rappels automatiques (auth par secret de service — reminder-service :3032) :
//      POST { "type": "reminders" } + header "x-orbit-service-secret"
//      → scanne la base et envoie :
//        • événements démarrant dans moins de 15 minutes
//        • tâches non terminées dont l'échéance arrive dans moins d'1 heure
//      Chaque objet notifié est marqué (reminderSentAt) pour éviter tout doublon.
//      Les utilisateurs sans abonnement push ne sont PAS marqués : s'ils
//      s'abonnent avant l'heure, ils recevront quand même leur rappel.
import { NextRequest, NextResponse } from "next/server"
import { format } from "date-fns"
import { fr } from "date-fns/locale"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
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

const EVENT_LEAD_MS = 15 * 60 * 1000 // 15 minutes avant un événement
const TASK_LEAD_MS = 60 * 60 * 1000 // 1 heure avant l'échéance d'une tâche

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

  // ── Événements démarrant dans moins de 15 minutes ──────────────────────
  // (un push par rappel, tag unique par objet → remplace au lieu d'empiler)
  const dueEvents = await db.event.findMany({
    where: {
      reminderSentAt: null,
      startTime: { gte: now, lte: new Date(now.getTime() + EVENT_LEAD_MS) },
    },
    take: 50,
  })

  for (const event of dueEvents) {
    const r = await sendPushToUser(event.userId, {
      title: "Orbit — rappel d'événement",
      body: `Dans 15 min : ${event.title} (${format(event.startTime, "HH:mm", { locale: fr })})`,
      tag: `event-${event.id}`,
      kind: "event",
    })
    Object.assign(report, {
      sent: report.sent + r.sent,
      removed: report.removed + r.removed,
      failed: report.failed + r.failed,
    })
    // Marqué uniquement si l'utilisateur a des appareils (sent/removed > 0) :
    // sans abonnement, le rappel restera disponible s'il s'abonne à temps.
    if (r.sent > 0 || r.removed > 0) {
      await db.event.update({
        where: { id: event.id },
        data: { reminderSentAt: now },
      })
      eventsNotified++
    }
  }

  // ── Tâches non terminées échuant dans moins d'1 heure ──────────────────
  const dueTasks = await db.task.findMany({
    where: {
      reminderSentAt: null,
      status: { not: "done" },
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
    Object.assign(report, {
      sent: report.sent + r.sent,
      removed: report.removed + r.removed,
      failed: report.failed + r.failed,
    })
    if (r.sent > 0 || r.removed > 0) {
      await db.task.update({
        where: { id: task.id },
        data: { reminderSentAt: now },
      })
      tasksNotified++
    }
  }

  return NextResponse.json({
    ok: true,
    scannedAt: now.toISOString(),
    eventsNotified,
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
