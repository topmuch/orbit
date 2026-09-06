// GET /api/search — Recherche full-text globale (événements, tâches, emails)
// ─────────────────────────────────────────────────────────────────────────────
// ?q=<texte> (≥ 2 caractères) &types=event,task,email (csv, optionnel)
// &limit=20 (≤ 50) → { results, totalHits, processingTimeMs, engine }.
// Authentification session obligatoire (aucune fuite inter-utilisateurs : le
// filtre userId est appliqué DANS le moteur, quel que soit son backend).
// Réponse consommée par la palette de commandes (Ctrl+K) et le champ de
// recherche global. Moteur SQLite par défaut, Meilisearch en production
// (MEILI_HOST) — cf. src/lib/search/.

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { getSearchEngine } from "@/lib/search";
import type { SearchEntityType } from "@/lib/search/types";

const VALID_TYPES = new Set<SearchEntityType>(["event", "task", "email"]);

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  // La frappe humaine (palette) reste largement sous la limite — seules les
  // fuites de boucle / scripts dépassent 60 requêtes/minute.
  const rl = rateLimit(`search:${user.id}`, 60);
  if (!rl.ok) return tooManyRequests(rl);

  const { searchParams } = new URL(req.url);
  const query = (searchParams.get("q") ?? "").trim();

  if (query.length < 2) {
    return NextResponse.json({
      results: [],
      totalHits: 0,
      processingTimeMs: 0,
      engine: getSearchEngine().name,
    });
  }

  const typesParam = searchParams.get("types");
  const types = typesParam
    ? typesParam
        .split(",")
        .map((t) => t.trim())
        .filter((t): t is SearchEntityType => VALID_TYPES.has(t as SearchEntityType))
    : undefined;

  const limitParam = Number(searchParams.get("limit"));
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? limitParam : 20;

  try {
    const engine = getSearchEngine();
    const outcome = await engine.search(query, user.id, { types, limit });
    return NextResponse.json({
      results: outcome.items,
      totalHits: outcome.totalHits,
      processingTimeMs: outcome.tookMs,
      engine: engine.name,
    });
  } catch (error) {
    console.error("[search] Échec de la recherche :", error);
    return NextResponse.json({ error: "Recherche indisponible" }, { status: 500 });
  }
}
