"use client";

// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Cache intelligent en mémoire : LRU (Least Recently Used) + TTL
// ───────────────────────────────────────────────────────────────────────────
// Objectif : éviter les travaux redondants du moteur de sync sans faire
// diverger les données (contrairement à un cache HTTP). Deux usages :
//   • DÉDOUBLONNAGE : une même clé de pull (curseur « since ») traitée deux
//     fois à moins d'une seconde de distance → la 2e lecture est servie du
//     cache (fenêtre de coalescence) ;
//   • ANTI-BURST UI : les compteurs/métadonnées lus à haute fréquence.
// Purge : entrées expirées (TTL) au fil des accès + éviction LRU au-delà de
// maxSize. L'ordre d'insertion du Map = récence (get re-promouvoir l'entrée).
// ═══════════════════════════════════════════════════════════════════════════

export interface LRUCacheOptions {
  /** Nombre maximal d'entrées (au-delà : éviction de la moins récente). */
  maxSize: number;
  /** Durée de vie d'une entrée (ms). */
  ttlMs: number;
  /** Purge passive : fréquence max d'un balayage complet (ms). */
  sweepIntervalMs?: number;
}

export class LRUTTLCache<K, V> {
  private store = new Map<K, { value: V; expiresAt: number }>();
  private lastSweep = 0;

  constructor(private readonly opts: LRUCacheOptions) {}

  get(key: K): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return undefined;
    }
    // Promotion LRU : re-insertion en fin de Map (la plus récente)
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    // Éviction LRU avant insertion si plein
    while (this.store.size >= this.opts.maxSize) {
      const oldest = this.store.keys().next().value;
      if (oldest === undefined) break;
      this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.opts.ttlMs });
    this.sweepIfDue();
  }

  has(key: K): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: K): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    this.sweepIfDue();
    return this.store.size;
  }

  private isExpired(entry: { expiresAt: number }): boolean {
    return Date.now() > entry.expiresAt;
  }

  /** Purge passive : au plus un balayage par sweepIntervalMs. */
  private sweepIfDue(): void {
    const now = Date.now();
    if (now - this.lastSweep < (this.opts.sweepIntervalMs ?? 30_000)) return;
    this.lastSweep = now;
    for (const [key, entry] of this.store) {
      if (this.isExpired(entry)) this.store.delete(key);
    }
  }
}

/**
 * Cache de coalescence du moteur de sync : les pulls consécutifs identiques
 * (même curseur « since », < 3 s) ne re-déclenchent pas le merge Dexie.
 */
export const syncPullCache = new LRUTTLCache<string, boolean>({
  maxSize: 32,
  ttlMs: 3_000,
  sweepIntervalMs: 10_000,
});
