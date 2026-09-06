import "server-only";

// Orbit — Recherche full-text : fabrique de moteur (singleton)
// ─────────────────────────────────────────────────────────────────────────────
// MEILI_HOST défini  → adaptateur Meilisearch (production Docker).
// Sinon              → moteur SQLite embarqué (sandbox / petites instances).
// L'API /api/search consomme ce singleton — un seul objet alloué par process.

import { SqliteSearchEngine } from "./sqlite-engine";
import { MeiliSearchEngine } from "./meilisearch";
import type { SearchEngine } from "./types";

let cached: SearchEngine | null = null;

export function getSearchEngine(): SearchEngine {
  if (cached) return cached;
  cached = process.env.MEILI_HOST ? new MeiliSearchEngine() : new SqliteSearchEngine();
  return cached;
}
