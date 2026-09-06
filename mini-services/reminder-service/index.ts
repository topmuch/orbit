// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Micro-service de rappels (reminder-service) · port 3032
// ───────────────────────────────────────────────────────────────────────────
// Planificateur : toutes les 60 secondes, il appelle :
//   • POST /api/notify { type: "reminders" } — scan des rappels (événements,
//     tâches, emails IA, file planifiée scheduledAt) avec le secret partagé
//   • POST /api/notify { type: "email-sync" } — synchronisation IMAP des
//     comptes ÉCHUS (la route décide de l'échéance : lastSyncAt + intervalle,
//     lecture seule, mot de passe chiffré AES-256-GCM — Task 6)
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
let lastSyncResult: Record<string, unknown> | null = null
let lastRunAt: string | null = null
let lastSyncAt: string | null = null
let runCount = 0
let errorCount = 0
let syncRunCount = 0
let syncErrorCount = 0

/** Appel authentifié vers /api/notify (secret de service). */
async function callNotify(type: "reminders" | "email-sync"): Promise<Response> {
  return fetch(`${APP_URL}/api/notify`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-orbit-service-secret": SECRET,
    },
    body: JSON.stringify({ type }),
    signal: AbortSignal.timeout(55_000),
  })
}

/** Un cycle de scan de rappels : délègue TOUTE la logique à /api/notify (source unique). */
async function runReminderCycle() {
  try {
    const res = await callNotify("reminders")
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
      scheduledSent?: number
      quietBlocked?: number
      report?: { sent?: number; removed?: number; failed?: number }
    }
    lastResult = data
    lastRunAt = new Date().toISOString()
    const notified =
      (data.eventsNotified ?? 0) + (data.tasksNotified ?? 0) + (data.emailsNotified ?? 0) + (data.scheduledSent ?? 0)
    const sent = data.report?.sent ?? 0
    if (notified > 0 || sent > 0) {
      console.log(
        `[orbit:reminder] cycle #${runCount} → ${data.eventsNotified ?? 0} événement(s), ${data.tasksNotified ?? 0} tâche(s), ${data.emailsNotified ?? 0} email(s) IA, ${data.scheduledSent ?? 0} alerte(s) planifiée(s), ${sent} push envoyé(s)${data.quietBlocked ? `, ${data.quietBlocked} bloqué(s) par les heures calmes` : ""}`
      )
    }
  } catch (error) {
    errorCount++
    console.error(`[orbit:reminder] cycle échoué :`, (error as Error).message)
  }
}

/** Cycle IMAP : synchronise les comptes ÉCHUS (décision côté route). */
async function runEmailSyncCycle() {
  try {
    const res = await callNotify("email-sync")
    syncRunCount++
    if (!res.ok) {
      syncErrorCount++
      const body = await res.text().catch(() => "")
      console.error(`[orbit:emails] cycle #${syncRunCount} → HTTP ${res.status} ${body.slice(0, 200)}`)
      return
    }
    const data = (await res.json()) as {
      due?: number
      created?: number
      results?: Array<{ address: string; ok: boolean; created: number; error?: string }>
    }
    lastSyncResult = data
    lastSyncAt = new Date().toISOString()
    if ((data.due ?? 0) > 0) {
      const failures = (data.results ?? []).filter((r) => !r.ok)
      console.log(
        `[orbit:emails] cycle #${syncRunCount} → ${data.due} compte(s) synchronisé(s), ${data.created ?? 0} nouveau(x) email(s)${failures.length ? `, échecs : ${failures.map((f) => `${f.address} (${f.error ?? "?"})`).join(" ; ")}` : ""}`
      )
    }
  } catch (error) {
    syncErrorCount++
    console.error(`[orbit:emails] cycle échoué :`, (error as Error).message)
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
        emailSync: {
          runCount: syncRunCount,
          errorCount: syncErrorCount,
          lastRunAt: lastSyncAt,
          lastResult: lastSyncResult,
        },
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      })
    }
    if (req.method === "POST" && path === "/run") {
      // Déclenchement manuel (tests) : exécute immédiatement les deux cycles.
      await runReminderCycle()
      await runEmailSyncCycle()
      return Response.json({
        ok: true,
        runCount,
        lastResult,
        lastRunAt,
        emailSync: { runCount: syncRunCount, lastResult: lastSyncResult, lastRunAt: lastSyncAt },
      })
    }
    return Response.json({ error: "Route inconnue", routes: ["GET /health", "POST /run"] }, { status: 404 })
  },
})

// Premier cycle immédiat puis boucle (rappels + emails IMAP, séquentiels)
await runReminderCycle()
await runEmailSyncCycle()
setInterval(() => {
  runReminderCycle()
  runEmailSyncCycle()
}, INTERVAL_MS)

console.log(`[orbit:reminder] démarré sur http://localhost:${server.port} — cycle toutes les ${INTERVAL_MS / 1000} s`)
console.log(`[orbit:reminder] cible : ${APP_URL}/api/notify (rappels + email-sync IMAP, auth par secret de service)`)
