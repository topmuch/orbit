// GET /api/analytics — Agrégats + séries de la section « Analytique »
// ─────────────────────────────────────────────────────────────────────────────
// Réponse : { analytics: AnalyticsDto } (cf. src/lib/analytics/types.ts).
// Consommé par dashboard-view.tsx (hook local useQuery, staleTime 60 s).
// Toutes les fenêtres (semaine courante, 14 derniers jours) sont calculées
// DANS LE FUSEAU DU PROFIL de l'utilisateur (User.timezone) — cf. queries.ts.

import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { getAnalytics } from "@/lib/analytics/queries";

export async function GET() {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  // Même budget que /api/search : le dashboard recharge au focus, pas en boucle.
  const rl = rateLimit(`analytics:${user.id}`, 60);
  if (!rl.ok) return tooManyRequests(rl);

  const analytics = await getAnalytics(user.id);
  return NextResponse.json({ analytics });
}
