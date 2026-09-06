"use client";

// Orbit — Statut de synchronisation (offline-first v2)
// pendingCount/isSyncing/lastSyncAt/conflicts + déclencheur manuel sync().
// Compteurs réactifs : live queries Dexie (pas de polling artificiel).

import { useCallback } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { db } from "@/lib/offline/indexeddb";
import { useSyncStore, triggerSync } from "@/lib/offline/sync-engine";

export interface SyncStatusInfo {
  /** Opérations en attente de push (outbox). */
  pendingCount: number;
  /** Sync complète en cours (push + pull). */
  isSyncing: boolean;
  /** Dernier serverTimestamp reçu (ISO) — null si jamais synchronisé. */
  lastSyncAt: string | null;
  /** Entités en conflit non résolu (décision utilisateur attendue). */
  conflicts: number;
  /** Déclenche une synchronisation manuelle (badge/réglages). */
  sync: () => ReturnType<typeof triggerSync>;
}

/** Statut de sync réactif pour l'UI (badge du shell, carte des réglages). */
export function useSyncStatus(): SyncStatusInfo {
  const pendingCount =
    useLiveQuery(() => db.pendingOperations.count(), [], 0) ?? 0;

  const lastSyncAt = useLiveQuery(
    async () => (await db.syncMetadata.get("lastSyncAt"))?.value ?? null,
    []
  ) as string | null;

  const conflicts =
    useLiveQuery(
      async () => {
        const [events, tasks, emails] = await Promise.all([
          db.events.where("_syncStatus").equals("conflict").count(),
          db.tasks.where("_syncStatus").equals("conflict").count(),
          db.emails.where("_syncStatus").equals("conflict").count(),
        ]);
        return events + tasks + emails;
      },
      [],
      0
    ) ?? 0;

  const isSyncing = useSyncStore((s) => s.syncing);
  const sync = useCallback(() => triggerSync(), []);

  return { pendingCount, isSyncing, lastSyncAt, conflicts, sync };
}
