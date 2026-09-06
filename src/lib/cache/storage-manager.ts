"use client";

// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Gestion du stockage (quota, persistance, éviction)
// ───────────────────────────────────────────────────────────────────────────
// Le cache offline vit dans IndexedDB (Dexie) + Cache Storage (SW). Volume
// personnel modeste, mais un garde-fou protège les appareils contraints :
//   • estimation usage/quota (StorageManager.estimate) ;
//   • demande de stockage PERSISTANT (éviter l'éviction auto du navigateur —
//     les données offline survivent à la pression disque) ;
//   • éviction ciblée : emails locaux > 90 j non suivis (isStarred false)
//     retirés du cache quand l'usage dépasse 80 % du quota.
// ═══════════════════════════════════════════════════════════════════════════

import { db } from "@/lib/offline/indexeddb";

export interface StorageEstimateInfo {
  usage: number;
  quota: number;
  persisted: boolean;
  /** Ratio usage/quota (0 si quota inconnu). */
  ratio: number;
}

export async function getStorageEstimate(): Promise<StorageEstimateInfo | null> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.estimate) return null;
    const estimate = await navigator.storage.estimate();
    const persisted = (await navigator.storage.persisted?.()) ?? false;
    const usage = estimate.usage ?? 0;
    const quota = estimate.quota ?? 0;
    return { usage, quota, persisted, ratio: quota > 0 ? usage / quota : 0 };
  } catch {
    return null;
  }
}

/** Demande un stockage persistant (installation PWA recommandée avant). */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.storage?.persist) return false;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/**
 * Éviction ciblée : emails locaux anciens et non suivis (le serveur conserve
 * tout — le cache n'est qu'un miroir). Retourne le nombre supprimé.
 */
export async function evictStaleEmails(daysOld = 90): Promise<number> {
  try {
    const cutoff = Date.now() - daysOld * 86_400_000;
    const stale = await db.emails
      .filter(
        (email) =>
          !email.isStarred &&
          email._syncStatus === "synced" &&
          Date.parse(email.receivedAt) < cutoff
      )
      .primaryKeys();
    if (stale.length > 0) await db.emails.bulkDelete(stale);
    return stale.length;
  } catch {
    return 0;
  }
}

/** Garde-fou appelé après chaque pull : éviction seulement si pression. */
export async function maybeEvictCache(): Promise<number> {
  const estimate = await getStorageEstimate();
  if (estimate && estimate.ratio > 0.8) return evictStaleEmails();
  return 0;
}

/** Purge complète des caches offline (IndexedDB données + caches SW). */
export async function purgeOfflineCaches(): Promise<void> {
  try {
    await Promise.all([db.events.clear(), db.tasks.clear(), db.emails.clear()]);
  } catch {
    // silencieux
  }
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
    }
  } catch {
    // silencieux
  }
}
