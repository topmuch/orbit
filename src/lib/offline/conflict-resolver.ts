"use client";

// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Résolution de conflits (3-way merge, LWW, auto-merge par champs)
// ───────────────────────────────────────────────────────────────────────────
// Un conflit naît quand une entité est modifiée LOCALEMENT (en file, pas
// encore poussée) ET sur le SERVEUR (autre appareil) depuis le dernier sync.
//
// Stratégies (dans l'ordre) :
//   1. AUTO-MERGE : modifications sur des champs DISJOINTS → les deux sont
//      conservées (état serveur + champs locaux modifiés).
//      Ex. : l'app A coche « terminée » pendant que l'app B renomme la tâche.
//   2. LWW (Last Write Wins) : horodatages locaux vs serveur suffisamment
//      écartés (> fenêtre d'ambiguïté) → le plus récent gagne.
//   3. CONFLIT UTILISATEUR : mêmes champs modifiés des deux côtés avec des
//      horloges trop proches pour trancher (dérive d'horloge entre appareils)
//      → _syncStatus « conflict », résolution manuelle dans les réglages
//      (garder local / garder serveur).
//
// La base 3-way = _serverVersion (cliché serveur au moment de la modification
// locale), conservée sur l'entité quand elle passe « pending ».
// ═══════════════════════════════════════════════════════════════════════════

import type { LocalEvent, LocalTask, LocalEmail } from "./indexeddb";

/** N'importe quelle entité locale (métadonnées de sync incluses). */
export type AnyLocal = LocalEvent | LocalTask | LocalEmail;

/** Résultat d'une résolution automatique. */
export type ConflictResolution<T> =
  | { strategy: "local" }
  | { strategy: "server" }
  | { strategy: "merged"; data: T }
  | null; // null = conflit utilisateur (décision humaine)

/** Horloges trop proches pour départager (dérive d'horloge multi-appareils). */
const AMBIGUITY_WINDOW_MS = 120_000;

/** Champs purement métier (métadonnées de sync exclues du merge). */
const META_FIELDS = new Set([
  "_syncStatus",
  "_lastSyncedAt",
  "_localUpdatedAt",
  "_serverUpdatedAt",
  "_serverVersion",
  "_version",
]);

function businessKeys(record: Record<string, unknown>): string[] {
  return Object.keys(record).filter((key) => !META_FIELDS.has(key));
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Champs divergents entre deux enregistrements (comparaison JSON). */
function diffFields(a: Record<string, unknown> | null, b: Record<string, unknown> | null): string[] {
  if (!a || !b) return [];
  const keys = new Set([...businessKeys(a), ...businessKeys(b)]);
  const out: string[] = [];
  for (const key of keys) {
    if (!deepEqual(a[key], b[key])) out.push(key);
  }
  return out;
}

/** Copie métier (métadonnées de sync retirées). */
function toBusiness(record: AnyLocal): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!META_FIELDS.has(key)) out[key] = value;
  }
  return out;
}

function pick(source: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field] = source[field];
  return out;
}

export class ConflictResolver {
  /**
   * Résout local vs serveur avec base = dernier cliché serveur connu
   * (Record métier, sans métadonnées). base null → pas de 3-way : LWW direct.
   */
  resolve<T extends AnyLocal>(
    local: T,
    base: Record<string, unknown> | null,
    server: T
  ): ConflictResolution<T> {
    const localRecord = toBusiness(local);
    const serverRecord = toBusiness(server);

    const localChanges = base
      ? diffFields(base, localRecord)
      : diffFields(serverRecord, localRecord);
    const serverChanges = base ? diffFields(base, serverRecord) : [];

    // 1. Auto-merge : champs modifiés DISJOINTS → fusion des deux
    const overlap = localChanges.filter((field) => serverChanges.includes(field));
    if (overlap.length === 0) {
      if (localChanges.length === 0) return { strategy: "server" };
      if (serverChanges.length === 0) return { strategy: "local" };
      const merged = {
        ...serverRecord,
        ...pick(localRecord, localChanges),
      } as unknown as T;
      return { strategy: "merged", data: merged };
    }

    // Mêmes champs modifiés → comparaison des horodatages
    const localTime = Date.parse(local._localUpdatedAt);
    const serverTime = Date.parse(String(serverRecord.updatedAt ?? "0"));
    const skew = localTime - serverTime;

    // 2. Fenêtre d'ambiguïté (dérive d'horloge) → décision humaine
    if (Number.isNaN(skew) || Math.abs(skew) < AMBIGUITY_WINDOW_MS) return null;

    // 3. LWW
    return skew > 0 ? { strategy: "local" } : { strategy: "server" };
  }

  /**
   * Alias spec : merge spécialisé tâches (changement isolé statut/priorité).
   * Délègue au resolve générique — même heuristique, plus prévisible.
   */
  autoMergeTask(local: LocalTask, base: Record<string, unknown> | null, server: LocalTask): ConflictResolution<LocalTask> {
    return this.resolve(local, base, server);
  }
}

export const conflictResolver = new ConflictResolver();
