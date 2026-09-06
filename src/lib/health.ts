// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Sonde de santé partagée (/api/health + /api/metrics)
// ───────────────────────────────────────────────────────────────────────────
// Source unique de vérité sur l'état de la plateforme. Consommée par :
//   • GET /api/health  → JSON lisible (Docker healthcheck, deploy.sh,
//     scripts/health-check.sh, Grafana/Alertmanager via /api/metrics)
//   • GET /api/metrics → format exposition Prometheus (scrape 15 s)
//
// Composants sondés :
//   • database         → SELECT 1 via Prisma (SQLite — dépendance DURE :
//                        indisponible = 503 + statut "unhealthy")
//   • aiService        → GET {AI_SERVICE_URL}/health (FastAPI docker/ai-service
//                        en prod, mini-service bun :3031 en dev). AI_SERVICE_URL
//                        vide explicitement = IA désactivée → "skipped" (mode
//                        léger documenté, pas une dégradation).
//   • reminderService  → GET {REMINDER_SERVICE_URL}/health (:3032 — runCount,
//                        errorCount, dernier cycle). Vide = cron externe
//                        (le service reminder est remplaçable par un cron
//                        système, cf. en-tête de mini-services/reminder-service)
//                        → "skipped".
//
// Sémantique HTTP (CONTRAT, ne pas casser) :
//   200 + "healthy"  → tout va bien
//   200 + "degraded" → un service OPTIONNEL est KO (app utilisable : les
//                      fonctionnalités IA/emails dégradées proprement) — on ne
//                      renvoie PAS 503 sinon les healthchecks Docker/redéploiements
//                      boucleraient en échec pour une panne non bloquante
//   503 + "unhealthy"→ base de données KO (indisponibilité réelle)
// ═══════════════════════════════════════════════════════════════════════════

import { version as APP_VERSION } from "../../package.json"
import { db } from "@/lib/db"

// ── URL des services (mêmes conventions que src/lib/ai-provider.ts) ────────
const AI_SERVICE_URL = (process.env.AI_SERVICE_URL ?? "http://localhost:3031").replace(/\/+$/, "")
const REMINDER_SERVICE_URL = (process.env.REMINDER_SERVICE_URL ?? "http://localhost:3032").replace(/\/+$/, "")

// Mode désactivé explicitement (AI_SERVICE_URL="" / REMINDER_SERVICE_URL="")
// → composant "skipped", ni healthy ni dégradé.
const AI_DISABLED = process.env.AI_SERVICE_URL === ""
const REMINDER_DISABLED = process.env.REMINDER_SERVICE_URL === ""

const PROBE_TIMEOUT_MS = 3_000

const processStartedAt = Date.now()

export type ComponentState = "up" | "down" | "skipped"

export interface ComponentCheck {
  status: ComponentState
  /** Latence de la sonde (ms) — absent si skipped/erreur. */
  responseTimeMs?: number
  /** Détail brut du composant (JSON de /health du service, message d'erreur…). */
  detail?: Record<string, unknown> | string
}

export interface HealthReport {
  status: "healthy" | "degraded" | "unhealthy"
  service: string
  version: string
  timestamp: string
  uptimeSec: number
  checks: {
    database: ComponentCheck
    aiService: ComponentCheck
    reminderService: ComponentCheck
  }
}

/** Sonde HTTP générique d'un micro-service (timeout court, latence mesurée). */
async function probeService(
  url: string,
): Promise<ComponentCheck> {
  const startedAt = Date.now()
  try {
    const res = await fetch(`${url}/health`, {
      cache: "no-store",
      // Un service de santé doit répondre VITE — on ne bloque pas /api/health
      // (Docker + Prometheus) sur un service engourdi.
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const responseTimeMs = Date.now() - startedAt
    if (!res.ok) {
      return { status: "down", responseTimeMs, detail: `HTTP ${res.status}` }
    }
    let detail: Record<string, unknown> | string = ""
    try {
      detail = (await res.json()) as Record<string, unknown>
    } catch {
      detail = "réponse non-JSON"
    }
    return { status: "up", responseTimeMs, detail }
  } catch (error) {
    return {
      status: "down",
      responseTimeMs: Date.now() - startedAt,
      detail: error instanceof Error ? error.message : "erreur inconnue",
    }
  }
}

/**
 * Collecte l'état de tous les composants. Source unique pour /api/health
 * (JSON) et /api/metrics (Prometheus) — jamais de duplication de logique.
 */
export async function collectHealth(): Promise<HealthReport> {
  // ── Base de données (définition de l'indisponibilité réelle) ─────────────
  let database: ComponentCheck
  const dbStartedAt = Date.now()
  try {
    await db.$queryRaw`SELECT 1`
    database = { status: "up", responseTimeMs: Date.now() - dbStartedAt }
  } catch (error) {
    database = {
      status: "down",
      responseTimeMs: Date.now() - dbStartedAt,
      detail: error instanceof Error ? error.message : "erreur inconnue",
    }
  }

  // ── Services applicatifs (parallèles : la sonde reste rapide) ────────────
  const [aiService, reminderService] = await Promise.all([
    AI_DISABLED
      ? Promise.resolve({ status: "skipped" as ComponentState, detail: "IA désactivée (AI_SERVICE_URL vide)" })
      : probeService(AI_SERVICE_URL),
    REMINDER_DISABLED
      ? Promise.resolve({
          status: "skipped" as ComponentState,
          detail: "Cron externe (REMINDER_SERVICE_URL vide)",
        })
      : probeService(REMINDER_SERVICE_URL),
  ])

  // ── Statut global (contrat : DB KO = unhealthy, services optionnels KO =
  //    degraded, skipped ne compte pas) ────────────────────────────────────
  let status: HealthReport["status"] = "healthy"
  if (database.status === "down") status = "unhealthy"
  else if (aiService.status === "down" || reminderService.status === "down") status = "degraded"

  return {
    status,
    service: "orbit-web",
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
    uptimeSec: Math.round((Date.now() - processStartedAt) / 1000),
    checks: { database, aiService, reminderService },
  }
}
