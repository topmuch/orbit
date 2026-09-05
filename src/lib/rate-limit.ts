// Orbit — Rate limiting en mémoire (anti-abus des API routes)
// ─────────────────────────────────────────────────────────────────────────────
// Compteurs glissants par fenêtre fixe, clé = "route:userId|ip". Adapté à
// l'architecture mono-processus de la sandbox (pas de Redis nécessaire) ;
// un balayage périodique évite toute fuite mémoire.

const buckets = new Map<string, { count: number; resetAt: number }>()
let lastSweep = Date.now()
const SWEEP_INTERVAL_MS = 5 * 60_000

export type RateLimitResult = {
  ok: boolean
  /** Secondes avant réouverture de la fenêtre (quand ok = false). */
  retryAfterSec?: number
}

/**
 * Consomme un jeton dans la fenêtre ; renvoie ok = false si la limite est atteinte.
 * @param key     Clé unique (ex. "events:create:usr_123")
 * @param limit   Nombre max de requêtes par fenêtre
 * @param windowMs Durée de la fenêtre (défaut 60 s)
 */
export function rateLimit(key: string, limit: number, windowMs = 60_000): RateLimitResult {
  const now = Date.now()

  // Balayage opportuniste (nettoie les fenêtres expirées)
  if (now - lastSweep > SWEEP_INTERVAL_MS) {
    lastSweep = now
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k)
  }

  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return { ok: true }
  }
  if (bucket.count >= limit) {
    return { ok: false, retryAfterSec: Math.ceil((bucket.resetAt - now) / 1000) }
  }
  bucket.count++
  return { ok: true }
}

/** Réponse 429 standardisée. */
export function tooManyRequests(result: RateLimitResult): Response {
  return new Response(
    JSON.stringify({
      error: "Trop de requêtes — patientez un instant",
      retryAfterSec: result.retryAfterSec ?? 60,
    }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        ...(result.retryAfterSec ? { "Retry-After": String(result.retryAfterSec) } : {}),
      },
    }
  )
}
