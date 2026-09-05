// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Micro-service de rappels (reminder-service) · port 3032
// ───────────────────────────────────────────────────────────────────────────
// Planificateur de notifications : toutes les 60 secondes, il appelle
// POST http://localhost:3000/api/notify { type: "reminders" } avec le secret
// partagé (REMINDER_SERVICE_SECRET). La route Next.js scanne alors la base :
//   • événements démarrant dans < 15 minutes  → push « J-15 min »
//   • tâches non terminées échuant dans < 1 h → push « H-1 »
// et marque chaque objet notifié (reminderSentAt) pour éviter les doublons.
//
// En production, ce service est remplaçable par un cron externe :
//   curl -X POST https://orbit.exemple.fr/api/notify \
//        -H "x-orbit-service-secret: $REMINDER_SERVICE_SECRET" \
//        -H "Content-Type: application/json" -d '{"type":"reminders"}'
// ═══════════════════════════════════════════════════════════════════════════

const PORT = 3032
const APP_URL = process.env.APP_URL ?? "http://localhost:3000"
const INTERVAL_MS = Number(process.env.REMINDER_INTERVAL_MS ?? 60_000)

// Charge le .env du projet parent (secret partagé)
async function loadParentEnv() {
  const raw = await Bun.file("../../.env").text().catch(() => "")
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
    if (!m) continue
    const [, key, value] = m
    if (!(key in process.env)) process.env[key] = value.replace(/^["']|["']$/g, "")
  }
}
await loadParentEnv()

const SECRET = process.env.REMINDER_SERVICE_SECRET ?? ""
if (!SECRET) {
  console.error("[orbit:reminder] REMINDER_SERVICE_SECRET manquant dans .env — arrêt.")
  process.exit(1)
}

const startedAt = Date.now()
let lastResult: Record<string, unknown> | null = null
let lastRunAt: string | null = null
let runCount = 0
let errorCount = 0

/** Un cycle de scan : délègue TOUTE la logique à /api/notify (source unique). */
async function runReminderCycle() {
  try {
    const res = await fetch(`${APP_URL}/api/notify`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-orbit-service-secret": SECRET,
      },
      body: JSON.stringify({ type: "reminders" }),
      signal: AbortSignal.timeout(55_000),
    })
    runCount++
    if (!res.ok) {
      errorCount++
      const body = await res.text().catch(() => "")
      console.error(`[orbit:reminder] cycle #${runCount} → HTTP ${res.status} ${body.slice(0, 200)}`)
      return
    }
    const data = (await res.json()) as {
      eventsNotified?: number
      tasksNotified?: number
      emailsNotified?: number
      quietBlocked?: number
      report?: { sent?: number; removed?: number; failed?: number }
    }
    lastResult = data
    lastRunAt = new Date().toISOString()
    const notified = (data.eventsNotified ?? 0) + (data.tasksNotified ?? 0) + (data.emailsNotified ?? 0)
    const sent = data.report?.sent ?? 0
    if (notified > 0 || sent > 0) {
      console.log(
        `[orbit:reminder] cycle #${runCount} → ${data.eventsNotified ?? 0} événement(s), ${data.tasksNotified ?? 0} tâche(s), ${data.emailsNotified ?? 0} email(s) IA notifié(s), ${sent} push envoyé(s)${data.quietBlocked ? `, ${data.quietBlocked} bloqué(s) par les heures calmes` : ""}`
      )
    }
  } catch (error) {
    errorCount++
    console.error(`[orbit:reminder] cycle échoué :`, (error as Error).message)
  }
}

// ── Serveur de supervision (port 3032) ──────────────────────────────────────
const server = Bun.serve({
  port: PORT,
  async fetch(req): Promise<Response> {
    const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/"
    if (req.method === "GET" && path === "/health") {
      return Response.json({
        ok: true,
        service: "orbit-reminder-service",
        intervalMs: INTERVAL_MS,
        runCount,
        errorCount,
        lastRunAt,
        lastResult,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      })
    }
    if (req.method === "POST" && path === "/run") {
      // Déclenchement manuel (tests) : exécute immédiatement un cycle.
      await runReminderCycle()
      return Response.json({ ok: true, runCount, lastResult, lastRunAt })
    }
    return Response.json({ error: "Route inconnue", routes: ["GET /health", "POST /run"] }, { status: 404 })
  },
})

// Premier cycle immédiat puis boucle
await runReminderCycle()
setInterval(runReminderCycle, INTERVAL_MS)

console.log(`[orbit:reminder] démarré sur http://localhost:${server.port} — cycle toutes les ${INTERVAL_MS / 1000} s`)
console.log(`[orbit:reminder] cible : ${APP_URL}/api/notify (auth par secret de service)`)
