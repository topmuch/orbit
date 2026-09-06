// /api/health — Sonde de santé publique de la plateforme Orbit
// ─────────────────────────────────────────────────────────────────────────────
// Consommateurs :
//   • Docker HEALTHCHECK du conteneur web (docker-compose.prod.yml, 30 s)
//   • scripts/health-check.sh + deploy.sh (gate de déploiement + rollback auto)
//   • GitHub Actions deploy.yml (vérification post-déploiement)
//   • Supervision humaine (curl https://domaine/api/health)
//
// Réponse (200 sain/dégradé, 503 base KO — cf. src/lib/health.ts) :
// {
//   "status": "healthy" | "degraded" | "unhealthy",
//   "service": "orbit-web",
//   "version": "…",
//   "timestamp": "ISO",
//   "uptimeSec": 1234,
//   "checks": {
//     "database":       { "status": "up", "responseTimeMs": 3 },
//     "aiService":      { "status": "up", "responseTimeMs": 12, "detail": {…} },
//     "reminderService":{ "status": "up", "responseTimeMs": 5,  "detail": {…} }
//   }
// }
//
// Route volontairement NON authentifiée : elle ne révèle que des états de
// service (aucune donnée utilisateur) et doit rester interrogeable par les
// orchestrateurs avant toute session.
// ─────────────────────────────────────────────────────────────────────────────
import { NextResponse } from "next/server"
import { collectHealth } from "@/lib/health"

export const dynamic = "force-dynamic" // jamais de cache (sonde temps réel)

export async function GET() {
  const health = await collectHealth()

  // 503 UNIQUEMENT si la base est KO — un service optionnel en échec ne doit
  // pas marquer le conteneur unhealthy (cascade de redémarrages inutile).
  const httpStatus = health.status === "unhealthy" ? 503 : 200

  return NextResponse.json(health, {
    status: httpStatus,
    headers: { "Cache-Control": "no-store" },
  })
}
