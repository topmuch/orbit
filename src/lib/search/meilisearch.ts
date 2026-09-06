import "server-only";

// Orbit — Recherche full-text : adaptateur Meilisearch (production)
// ─────────────────────────────────────────────────────────────────────────────
// Actif UNIQUEMENT si MEILI_HOST est défini (docker-compose.prod.yml service
// `meilisearch` : image v1.6, clé maître, volume dédié — jamais exposé par le
// reverse proxy). Le client npm est importé DYNAMIQUEMENT : absent du bundle
// quand le moteur SQLite par défaut est utilisé.
// Recherche multi-index (events / tasks / emails) + filtre `userId` STRICT :
// chaque requête est scopée à l'utilisateur connecté, jamais de fuite croisée.
// Piège « données sensibles » de la spec : le corps complet des emails n'est
// PAS indexé — sujet / expéditeur / extrait (≤ 200 car.) seulement.

import type {
  SearchEngine,
  SearchEntityType,
  SearchOptions,
  SearchResultItem,
  SearchOutcome,
} from "./types";
import { DEFAULT_SEARCH_TYPES } from "./types";

const INDEX_NAMES: Record<SearchEntityType, string> = {
  event: "events",
  task: "tasks",
  email: "emails",
};

/** Documents indexés par type — projection MINIMALE (jamais de contenu sensible). */
export type IndexedDocument = {
  id: string;
  userId: string;
  // events
  title?: string;
  description?: string;
  location?: string;
  startTime?: string;
  endTime?: string;
  source?: string;
  // tasks
  status?: string;
  priority?: string;
  dueDate?: string;
  tags?: string[];
  // emails
  subject?: string;
  from?: string;
  fromName?: string;
  snippet?: string;
  receivedAt?: string;
  isRead?: boolean;
  isStarred?: boolean;
};

type MeiliClient = {
  index: (uid: string) => MeiliIndex;
};

type MeiliIndex = {
  updateSettings: (settings: Record<string, unknown>) => Promise<unknown>;
  addDocuments: (docs: IndexedDocument[], opts?: { primaryKey?: string }) => Promise<unknown>;
  deleteDocument: (id: string) => Promise<unknown>;
  deleteAllDocuments: () => Promise<unknown>;
  search: (query: string, params: Record<string, unknown>) => Promise<MeiliSearchResult>;
};

type MeiliSearchResult = {
  hits: Array<Record<string, unknown> & { _formatted?: Record<string, unknown> }>;
  estimatedTotalHits: number;
  processingTimeMs: number;
};

/** Résolution paresseuse du client (import dynamique — bundle-clean). */
async function getClient(): Promise<MeiliClient | null> {
  const host = process.env.MEILI_HOST;
  if (!host) return null;
  try {
    // v0.60+ : la classe s'exporte sous le nom « Meilisearch ».
    const { Meilisearch } = await import("meilisearch");
    return new Meilisearch({
      host,
      apiKey: process.env.MEILI_MASTER_KEY,
    }) as unknown as MeiliClient;
  } catch (error) {
    console.error("[search] Client Meilisearch indisponible :", error);
    return null;
  }
}

/**
 * Initialise les index et leurs réglages (typo-tolerance par défaut de
 * Meilisearch, synonymes FR, attributs cherchables/filtrables/triables).
 * Appelée au premier démarrage (ou via un script de réindexation) — les
 * settings sont idempotents côté Meilisearch.
 */
export async function initializeMeiliIndexes(): Promise<boolean> {
  const client = await getClient();
  if (!client) return false;

  const events = client.index(INDEX_NAMES.event);
  await events.updateSettings({
    searchableAttributes: ["title", "description", "location"],
    filterableAttributes: ["userId", "source", "startTime", "endTime"],
    sortableAttributes: ["startTime"],
    displayedAttributes: ["id", "title", "description", "location", "startTime", "endTime", "source"],
    synonyms: {
      rdv: ["rendez-vous", "reunion", "meeting", "appointment"],
      reunion: ["rdv", "meeting"],
      urgent: ["prioritaire", "important", "asap"],
    },
  });

  const tasks = client.index(INDEX_NAMES.task);
  await tasks.updateSettings({
    searchableAttributes: ["title", "description", "tags"],
    filterableAttributes: ["userId", "status", "priority", "dueDate"],
    sortableAttributes: ["dueDate", "priority", "createdAt"],
    displayedAttributes: ["id", "title", "description", "status", "priority", "dueDate", "tags"],
    synonyms: {
      tache: ["task", "todo", "afaire"],
      urgent: ["prioritaire", "important", "asap"],
    },
  });

  const emails = client.index(INDEX_NAMES.email);
  await emails.updateSettings({
    // PAS de bodyText : seul l'extrait ≤ 200 car. est cherchable (sensibilité).
    searchableAttributes: ["subject", "from", "fromName", "snippet"],
    filterableAttributes: ["userId", "isRead", "isStarred", "receivedAt"],
    sortableAttributes: ["receivedAt"],
    displayedAttributes: ["id", "subject", "from", "fromName", "snippet", "receivedAt", "isRead", "isStarred"],
  });

  return true;
}

/** Indexe (upsert) un document — hook de synchronisation applicative future. */
export async function indexDocument(
  type: SearchEntityType,
  document: IndexedDocument
): Promise<void> {
  const client = await getClient();
  if (!client) return; // SQLite actif : indexation Meilisearch sans objet
  try {
    await client.index(INDEX_NAMES[type]).addDocuments([document], { primaryKey: "id" });
  } catch (error) {
    // L'indexation ne doit JAMAIS bloquer l'opération métier principale.
    console.error(`[search] Indexation ${type} échouée :`, error);
  }
}

/** Retire un document de l'index (suppression applicative). */
export async function removeDocument(type: SearchEntityType, id: string): Promise<void> {
  const client = await getClient();
  if (!client) return;
  try {
    await client.index(INDEX_NAMES[type]).deleteDocument(id);
  } catch (error) {
    console.error(`[search] Désindexation ${type} échouée :`, error);
  }
}

export class MeiliSearchEngine implements SearchEngine {
  readonly name = "meilisearch";

  async search(
    query: string,
    userId: string,
    options?: SearchOptions
  ): Promise<SearchOutcome> {
    const startedAt = performance.now();
    const client = await getClient();
    if (!client) return { items: [], totalHits: 0, tookMs: 0 };

    const limit = Math.min(50, Math.max(1, options?.limit ?? 20));
    const types = options?.types?.length ? options.types : DEFAULT_SEARCH_TYPES;
    // Répartition équitable de la limite entre les types demandés.
    const perType = Math.max(3, Math.ceil(limit / types.length));

    let totalHits = 0;
    let meiliTookMs = 0;

    const searches = types.map(async (type) => {
      const result = await client.index(INDEX_NAMES[type]).search(query, {
        filter: `userId = "${userId}"`, // scoping STRICT par utilisateur
        limit: perType,
        attributesToHighlight: ["title", "description", "subject", "snippet"],
        highlightPreTag: "<mark>",
        highlightPostTag: "</mark>",
      });
      totalHits += result.estimatedTotalHits;
      meiliTookMs = Math.max(meiliTookMs, result.processingTimeMs);
      return result.hits.map((hit) => this.toItem(type, hit));
    });

    const allItems = (await Promise.all(searches)).flat();
    // Meilisearch ne renvoie pas de score global multi-index : classement
    // stable par date décroissante (la pertinence intra-index est déjà triée).
    allItems.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));

    return {
      items: allItems.slice(0, limit),
      totalHits,
      tookMs: Math.max(Math.round(performance.now() - startedAt), meiliTookMs),
    };
  }

  private toItem(type: SearchEntityType, hit: Record<string, unknown>): SearchResultItem {
    const formatted = (hit._formatted ?? {}) as Record<string, unknown>;
    const title =
      (formatted.title as string | undefined) ?? (formatted.subject as string | undefined) ?? "";
    const snippet =
      (formatted.description as string | undefined) ??
      (formatted.snippet as string | undefined) ??
      (formatted.subject as string | undefined) ??
      "";
    const dateRaw =
      (hit.startTime as string | undefined) ??
      (hit.dueDate as string | undefined) ??
      (hit.receivedAt as string | undefined) ??
      null;
    return {
      id: String(hit.id),
      type,
      title: String(title),
      // Les _formatted de Meilisearch contiennent déjà les <mark> ; le contenu
      // provient de l'index construit par nos soins (texte applicatif brut).
      snippet: String(snippet).slice(0, 160),
      date: dateRaw,
      view: type === "event" ? "calendar" : type === "task" ? "tasks" : "emails",
    };
  }
}
