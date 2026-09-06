// Orbit — Tombstones de synchronisation (offline-first, usage serveur)
// ─────────────────────────────────────────────────────────────────────────────
// Une suppression en base est INVISIBLE pour un pull delta (la ligne n'existe
// plus). On enregistre donc une « pierre tombale » que GET /api/sync/changes
// propage aux autres appareils : ils suppriment l'entité de leur cache
// IndexedDB local. Best-effort : JAMAIS faire échouer la suppression serveur.

import { db } from "@/lib/db";

export type TombstoneEntity = "event" | "task" | "email";

/**
 * Enregistre la suppression d'une entité (propagation multi-appareils).
 * Idempotent côté lecture : le client Dexie supprime par id (no-op si absent).
 */
export async function recordTombstone(
  userId: string,
  entity: TombstoneEntity,
  entityId: string
): Promise<void> {
  if (!entityId) return;
  try {
    await db.syncTombstone.create({ data: { userId, entity, entityId } });
  } catch {
    // Best-effort : la purge opportuniste (> 30 j) côté route de sync évite
    // l'accumulation ; un échec d'écriture ne bloque jamais le DELETE.
  }
}
