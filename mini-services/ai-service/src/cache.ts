// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Micro-service IA · cache mémoire des réponses identiques
// ───────────────────────────────────────────────────────────────────────────
// Map ordonnée (FIFO par insertion) : 200 entrées max, TTL 10 min.
// Les requêtes /chat ne passent PAS par ce cache (réponses uniques par
// nature). Un compteur de hits alimente /health (observabilité).
// ═══════════════════════════════════════════════════════════════════════════

import { CACHE_MAX_ENTRIES, CACHE_TTL_MS } from "./config"

interface Entry<T> {
  value: T
  expiresAt: number
}

const store = new Map<string, Entry<unknown>>()
let hits = 0

export function cacheGet<T>(key: string): T | null {
  const entry = store.get(key)
  if (!entry) return null
  if (entry.expiresAt <= Date.now()) {
    store.delete(key)
    return null
  }
  hits++
  return entry.value as T
}

export function cacheSet(key: string, value: unknown): void {
  // Éviction du plus ancien élément au-delà de la capacité (Map = ordre d'insertion).
  if (store.size >= CACHE_MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest !== undefined) store.delete(oldest)
  }
  store.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS })
}

export function cacheStats(): { size: number; hits: number } {
  // Purge opportuniste des entrées expirées pour un compteur honnête.
  const now = Date.now()
  for (const [k, e] of store) if (e.expiresAt <= now) store.delete(k)
  return { size: store.size, hits }
}
