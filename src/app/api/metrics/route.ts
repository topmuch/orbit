// /api/metrics — Exposition Prometheus de la plateforme Orbit
// ─────────────────────────────────────────────────────────────────────────────
// Format d'exposition Prometheus textuel (text/plain; version=0.0.4), scrapé
// par monitoring/prometheus/prometheus.yml (job "orbit-web", 15 s) et affiché
// dans le dashboard Grafana provisionné « orbit-overview ».
//
// Métriques :
//   orbit_up                    1 si cette route répond (gauge)
//   orbit_db_up                 1 si SQLite répond à SELECT 1
//   orbit_db_latency_ms         latence de la sonde base (ms)
//   orbit_ai_service_up         1 si le micro-service IA répond
//                               (ABSENTE si IA désactivée — AI_SERVICE_URL vide :
//                               pas de métrique = pas de fausse alerte == 0)
//   orbit_reminder_service_up   1 si le planificateur :3032 répond
//                               (ABSENTE en mode cron externe)
//   orbit_uptime_seconds        durée de vie du processus web
//   orbit_version_info{version} label informatif
//
// Sécurité : par défaut ouverte (uniquement des états de service, aucune
// donnée utilisateur). Si METRICS_SECRET est défini (recommandé si le domaine
// est public), l'accès exige `?token=<secret>` ou l'en-tête
// `Authorization: Bearer <secret>` — Prometheus est alors à configurer avec
// `authorization: credentials` ou `params: token:` (documenté dans
// docs/MONITORING.md).
// ─────────────────────────────────────────────────────────────────────────────
import { collectHealth, type ComponentCheck } from "@/lib/health"

export const dynamic = "force-dynamic" // jamais de cache (scrape temps réel)

/** Valeur numérique d'une sonde (1=up, 0=down). */
function gaugeValue(check: ComponentCheck): number {
  return check.status === "up" ? 1 : 0
}

export async function GET(request: Request) {
  // ── Authentification optionnelle (METRICS_SECRET) ─────────────────────────
  const secret = process.env.METRICS_SECRET
  if (secret) {
    const url = new URL(request.url)
    const token =
      url.searchParams.get("token") ??
      request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
      ""
    if (token !== secret) {
      return Response.json(
        { error: "Accès refusé — token invalide ou absent (METRICS_SECRET actif)" },
        { status: 401, headers: { "Cache-Control": "no-store" } },
      )
    }
  }

  const health = await collectHealth()
  const { checks } = health

  // ── Corps au format exposition Prometheus ─────────────────────────────────
  // Les HELP/TYPE sont requis par les bonnes pratiques de nommage Prometheus.
  const lines: string[] = []

  lines.push("# HELP orbit_up Disponibilité de l'application Orbit (1 = répond).")
  lines.push("# TYPE orbit_up gauge")
  lines.push("orbit_up 1")

  lines.push("# HELP orbit_db_up Disponibilité de la base SQLite (1 = SELECT 1 OK).")
  lines.push("# TYPE orbit_db_up gauge")
  lines.push(`orbit_db_up ${gaugeValue(checks.database)}`)

  lines.push("# HELP orbit_db_latency_ms Latence de la sonde base (ms).")
  lines.push("# TYPE orbit_db_latency_ms gauge")
  lines.push(`orbit_db_latency_ms ${checks.database.responseTimeMs ?? -1}`)

  // Métriques de services optionnels ÉMISES seulement si sondées —
  // une métrique absente ne déclenche pas les alertes `== 0`.
  if (checks.aiService.status !== "skipped") {
    lines.push("# HELP orbit_ai_service_up Disponibilité du micro-service IA (1 = répond).")
    lines.push("# TYPE orbit_ai_service_up gauge")
    lines.push(`orbit_ai_service_up ${gaugeValue(checks.aiService)}`)
  }
  if (checks.reminderService.status !== "skipped") {
    lines.push("# HELP orbit_reminder_service_up Disponibilité du planificateur de rappels (1 = répond).")
    lines.push("# TYPE orbit_reminder_service_up gauge")
    lines.push(`orbit_reminder_service_up ${gaugeValue(checks.reminderService)}`)
  }

  lines.push("# HELP orbit_uptime_seconds Durée de vie du processus web (secondes).")
  lines.push("# TYPE orbit_uptime_seconds gauge")
  lines.push(`orbit_uptime_seconds ${health.uptimeSec}`)

  lines.push("# HELP orbit_version_info Version de l'application (label informatif).")
  lines.push("# TYPE orbit_version_info gauge")
  lines.push(`orbit_version_info{version="${health.version}"} 1`)

  return new Response(`${lines.join("\n")}\n`, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}
