import "server-only";

// Orbit — Recherche full-text : moteur SQLite (défaut, sandbox & petite prod)
// ─────────────────────────────────────────────────────────────────────────────
// Stratégie adaptée à l'échelle PERSONNELLE (≤ quelques milliers d'entités) :
//   1. Chargement borné des colonnes légères de l'utilisateur (jamais les
//      corps d'emails complets — piège « données sensibles » de la spec :
//      seuls sujet / expéditeur / snippet ≤ 200 car. sont cherchables) ;
//   2. Scoring en mémoire sur textes NORMALISÉS (accents retirés, casse
//      pliée) → recherche insensible aux accents ET à la casse, avec tolérance
//      aux fautes de frappe (distance de Levenshtein ≤ 2 bornée) ;
//   3. Snippet ~150 car. reconstruit autour de la première correspondance,
//      HTML échappé puis correspondances encadrées de <mark>.
// SQLite FTS5 n'est pas exposé proprement par Prisma — ce scoring JS est
// volontairement simple, mesurable (< 50 ms) et sans serveur externe.

import { db } from "@/lib/db";
import type {
  SearchEngine,
  SearchEntityType,
  SearchOptions,
  SearchResultItem,
  SearchOutcome,
} from "./types";
import { DEFAULT_SEARCH_TYPES } from "./types";

// ── Normalisation & helpers ─────────────────────────────────────────────────

/** Retire accents + plie la casse (NFD → suppression des diacritiques). */
function normalize(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Échappe le HTML d'un texte brut avant injection des <mark>. */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Distance de Levenshtein BORNÉE : renvoie max+1 dès que le coût dépasse
 * `max` (élagage agressif — tolérance aux fautes sans exploser en O(n·m)).
 */
function boundedLevenshtein(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (row[j] < rowMin) rowMin = row[j];
    }
    if (rowMin > max) return max + 1; // élagage : ligne entière au-delà du seuil
    prev = row;
  }
  return prev[b.length];
}

/** Tokenise une requête : mots ≥ 2 caractères (ponctuation ignorée). */
function tokenize(query: string): string[] {
  return normalize(query)
    .split(/[^\p{L}\p{N}@._-]+/u)
    .filter((w) => w.length >= 2);
}

// ── Snippet surligné ────────────────────────────────────────────────────────

/**
 * Construit un extrait du texte original autour de la première correspondance
 * des mots de la requête. Retourne un HTML sûr : texte échappé + <mark>.
 * (Mapping index normalisé → index original construit char par char pour
 * rester exact malgré la décomposition NFD.)
 */
function buildSnippet(
  text: string | null | undefined,
  words: string[],
  maxLen = 150
): string {
  if (!text) return "";
  const source = text.replace(/\s+/g, " ").trim();
  if (!source) return "";

  // Texte normalisé + carte normaliséIdx → originalIdx.
  let norm = "";
  const indexMap: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const nc = normalize(source[i]);
    for (const ch of nc) {
      indexMap.push(i);
      norm += ch;
    }
  }

  // Première occurrence (exacte ou préfixe) d'un mot de la requête.
  let hitStart = -1;
  let hitEnd = -1;
  for (const word of words) {
    const at = norm.indexOf(word);
    if (at !== -1 && (hitStart === -1 || at < hitStart)) {
      hitStart = at;
      hitEnd = at + word.length;
    }
  }
  if (hitStart === -1) {
    const head = source.slice(0, maxLen);
    return escapeHtml(head) + (source.length > maxLen ? "…" : "");
  }

  // Fenêtre autour de la correspondance (préserve le contexte).
  const origStart = indexMap[hitStart] ?? 0;
  const origEnd = indexMap[Math.min(hitEnd - 1, indexMap.length - 1)] + 1;
  const pad = Math.floor((maxLen - (origEnd - origStart)) / 2);
  const windowStart = Math.max(0, origStart - Math.max(pad, 20));
  const windowEnd = Math.min(source.length, Math.max(origEnd + Math.max(pad, 20), origStart + maxLen));
  const windowText = source.slice(windowStart, windowEnd);

  // Ré-échappe la fenêtre puis surligne les occurrences (sur la fenêtre
  // normalisée recalculée localement — même longueur logique).
  const windowNorm = normalize(windowText);
  const marked = escapeHtml(windowText);
  // Version échappée de la fenêtre normalisée : on marque via regex tolérante
  // construite sur les mots (échappés regex + accents rendus optionnels).
  let html = marked;
  for (const word of words.slice().sort((a, b) => b.length - a.length)) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Tolérance accents : chaque lettre peut être suivie de diacritiques (\u0300-\u036f)
    const letterClass = escaped
      .split("")
      .map((c) => (/[a-z0-9]/.test(c) ? c : `\\${c}`))
      .join("[\\u0300-\\u036f]*");
    const pattern = new RegExp(`(${letterClass})`, "gi");
    html = html.replace(pattern, "<mark>$1</mark>");
  }

  const prefix = windowStart > 0 ? "…" : "";
  const suffix = windowEnd < source.length ? "…" : "";
  return prefix + html + suffix;
}

// ── Scoring ─────────────────────────────────────────────────────────────────

type ScoredCandidate = {
  item: SearchResultItem;
  score: number;
};

/** Poids par champ (titre > sujet > expéditeur > description/extrait/lieu). */
const W_TITLE = 10;
const W_FROM = 4;
const W_BODY = 3;
const W_TAG = 5;

/**
 * Score d'un candidat pour les mots de la requête :
 * · correspondance exacte (sous-chaîne) → poids plein ;
 * · préfixe → 80 % ;
 * · faute de frappe (Levenshtein ≤ 2 sur mots ≥ 4 car.) → 45 %.
 * Bonus de fraîcheur (max +2, décroissance sur 180 j) pour départager les
 * égalités vers le contenu récent.
 */
function scoreCandidate(
  haystacks: Array<{ text: string; weight: number }>,
  words: string[]
): number {
  let total = 0;
  const now = Date.now();
  for (const { text, weight } of haystacks) {
    if (!text) continue;
    const norm = normalize(text);
    for (const word of words) {
      if (norm.includes(word)) {
        total += weight;
      } else if (norm.includes(word.slice(0, Math.max(3, word.length - 1)))) {
        total += weight * 0.8;
      } else if (word.length >= 4) {
        // Tolérance aux fautes : comparaison mot à mot du texte normalisé.
        for (const candidate of norm.split(/[^\p{L}\p{N}@._-]+/u)) {
          if (candidate.length >= 3 && boundedLevenshtein(word, candidate, 2) <= 2) {
            total += weight * 0.45;
            break;
          }
        }
      }
    }
  }
  if (total === 0) return 0;
  return total;
}

function freshnessBonus(date: Date | null): number {
  if (!date) return 0;
  const days = (Date.now() - date.getTime()) / 86_400_000;
  if (days <= 0) return 2;
  return Math.max(0, 2 * (1 - days / 180));
}

// ── Moteur SQLite ──────────────────────────────────────────────────────────

export class SqliteSearchEngine implements SearchEngine {
  readonly name = "sqlite";

  async search(
    query: string,
    userId: string,
    options?: SearchOptions
  ): Promise<SearchOutcome> {
    const startedAt = performance.now();
    const words = tokenize(query);
    const limit = Math.min(50, Math.max(1, options?.limit ?? 20));
    const types = options?.types?.length ? options.types : DEFAULT_SEARCH_TYPES;

    // Requête trop courte ou mots trop courts → rien (cohérent avec l'API).
    if (words.length === 0) {
      return { items: [], totalHits: 0, tookMs: 0 };
    }

    // Candidats chargés en parallèle — colonnes légères uniquement, bornés
    // aux 3000 plus récents par type (échelle personnelle).
    const [events, tasks, emails] = await Promise.all([
      types.includes("event")
        ? db.event.findMany({
            where: { userId },
            select: {
              id: true,
              title: true,
              description: true,
              location: true,
              startTime: true,
            },
            orderBy: { startTime: "desc" },
            take: 3000,
          })
        : Promise.resolve([]),
      types.includes("task")
        ? db.task.findMany({
            where: { userId, status: { not: "archived" } },
            select: {
              id: true,
              title: true,
              description: true,
              dueDate: true,
              completedAt: true,
              tags: { select: { name: true } },
            },
            orderBy: { createdAt: "desc" },
            take: 3000,
          })
        : Promise.resolve([]),
      types.includes("email")
        ? db.emailLog.findMany({
            // Corbeille exclue : on ne cherche pas dans ce qu'on a jeté.
            where: { userId, folder: { not: "TRASH" } },
            select: {
              id: true,
              subject: true,
              snippet: true,
              fromAddress: true,
              fromName: true,
              receivedAt: true,
            },
            orderBy: { receivedAt: "desc" },
            take: 3000,
          })
        : Promise.resolve([]),
    ]);

    const scored: ScoredCandidate[] = [];

    for (const ev of events) {
      const score =
        scoreCandidate(
          [
            { text: ev.title, weight: W_TITLE },
            { text: ev.description ?? "", weight: W_BODY },
            { text: ev.location ?? "", weight: W_BODY },
          ],
          words
        ) + freshnessBonus(ev.startTime);
      if (score >= W_BODY) {
        scored.push({
          score,
          item: {
            id: ev.id,
            type: "event",
            title: ev.title,
            snippet: buildSnippet(ev.description ?? ev.title, words),
            date: ev.startTime.toISOString(),
            view: "calendar",
          },
        });
      }
    }

    for (const t of tasks) {
      const score =
        scoreCandidate(
          [
            { text: t.title, weight: W_TITLE },
            { text: t.description ?? "", weight: W_BODY },
            { text: t.tags.map((tag) => tag.name).join(" "), weight: W_TAG },
          ],
          words
        ) + freshnessBonus(t.completedAt ?? t.dueDate ?? null);
      if (score >= W_BODY) {
        scored.push({
          score,
          item: {
            id: t.id,
            type: "task",
            title: t.title,
            snippet: buildSnippet(t.description ?? t.title, words),
            date: t.dueDate?.toISOString() ?? null,
            view: "tasks",
          },
        });
      }
    }

    for (const e of emails) {
      const score =
        scoreCandidate(
          [
            { text: e.subject, weight: W_TITLE },
            { text: e.fromAddress, weight: W_FROM },
            { text: e.fromName ?? "", weight: W_FROM },
            { text: e.snippet ?? "", weight: W_BODY },
          ],
          words
        ) + freshnessBonus(e.receivedAt);
      if (score >= W_BODY) {
        scored.push({
          score,
          item: {
            id: e.id,
            type: "email",
            title: e.subject,
            snippet: buildSnippet(e.snippet ?? e.subject, words),
            date: e.receivedAt.toISOString(),
            view: "emails",
          },
        });
      }
    }

    scored.sort((a, b) => b.score - a.score || (b.item.date ?? "").localeCompare(a.item.date ?? ""));
    const totalHits = scored.length;

    return {
      items: scored.slice(0, limit).map((s) => s.item),
      totalHits,
      tookMs: Math.round(performance.now() - startedAt),
    };
  }
}
