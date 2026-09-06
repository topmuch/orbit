// Orbit — Recherche full-text : types & contrat moteur
// ─────────────────────────────────────────────────────────────────────────────
// Deux implémentations interchangeables (spec « Recherche full-text ») :
//   · SQLiteEngine  — actif par défaut (données personnelles, < 50 ms, zéro
//                     dépendance externe ; tolérance aux fautes + accents) ;
//   · MeiliSearchEngine — actif quand MEILI_HOST est défini (production
//                     Docker, cf. docker-compose.prod.yml service meilisearch).
// Contrat commun ci-dessous → l'API /api/search est agnostique du moteur.

export type SearchEntityType = "event" | "task" | "email";

/** Vue SPA ciblée par un résultat (navigation depuis la palette Ctrl+K). */
export type SearchResultView = "calendar" | "tasks" | "emails";

export type SearchResultItem = {
  id: string;
  type: SearchEntityType;
  title: string;
  /**
   * Extrait (~150 car.) avec correspondances surlignées `<mark>…</mark>`.
   * Le HTML est échappé côté MOTEUR (avant injection des balises mark) :
   * le client peut le rendre en confiance via dangerouslySetInnerHTML.
   */
  snippet: string;
  /** Date pertinente ISO (startTime / dueDate / receivedAt) — null si absente. */
  date: string | null;
  /** Vue de destination pour le deep link SPA. */
  view: SearchResultView;
};

export type SearchOptions = {
  types?: SearchEntityType[];
  limit?: number;
};

export type SearchOutcome = {
  items: SearchResultItem[];
  /** Nombre total de correspondances (avant troncature à `limit`). */
  totalHits: number;
  /** Durée du traitement en ms (transparence UI : « 12 ms · moteur sqlite »). */
  tookMs: number;
};

export interface SearchEngine {
  readonly name: string;
  search(query: string, userId: string, options?: SearchOptions): Promise<SearchOutcome>;
}

export const DEFAULT_SEARCH_TYPES: SearchEntityType[] = ["event", "task", "email"];
