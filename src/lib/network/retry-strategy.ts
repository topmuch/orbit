"use client";

// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Stratégie de retry avec backoff exponentiel + gigue (offline-first)
// ───────────────────────────────────────────────────────────────────────────
// Utilisé par le moteur de sync pour les erreurs TRANSITOIRES (réseau coupé,
// 5xx, 429) : nouvelle tentative après un délai croissant (base × 2^tentative)
// plafonné, avec gigue aléatoire pour éviter le thundering herd au retour du
// réseau (tous les onglets/appareils ne re-retryent pas à l'instant identique).
// Les erreurs DÉFINITIVES (4xx applicatifs) ne retentent JAMAIS.
// ═══════════════════════════════════════════════════════════════════════════

export interface RetryOptions {
  /** Délai initial (ms). */
  baseMs: number;
  /** Multiplicateur par tentative (2 = double à chaque fois). */
  factor: number;
  /** Délai maximal (ms). */
  maxMs: number;
  /** Nombre total de tentatives (1 = aucun retry). */
  maxAttempts: number;
  /** Gigue max (ms) ajoutée à chaque délai. */
  jitterMs: number;
}

export class RetryStrategy {
  constructor(private readonly opts: RetryOptions) {}

  /** Délai d'attente avant la tentative N (1-based, après un échec). */
  delayFor(attempt: number): number {
    const exponential = this.opts.baseMs * Math.pow(this.opts.factor, Math.max(0, attempt - 1));
    const capped = Math.min(this.opts.maxMs, exponential);
    return capped + Math.random() * this.opts.jitterMs;
  }

  /**
   * Exécute `fn` avec retries sur erreur transitoire.
   * `isTransient` distingue l'abandon (false) du retry (true).
   * Lève la dernière erreur après épuisement des tentatives.
   */
  async run<T>(fn: () => Promise<T>, isTransient: (error: unknown) => boolean): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt >= this.opts.maxAttempts || !isTransient(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, this.delayFor(attempt)));
      }
    }
    throw lastError;
  }
}

/** Erreur réseau : fetch échoué (TypeError) — la plus transitoire qui soit. */
export function isNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError && /fetch|network|réseau|failed/i.test(error.message)
  );
}

/** HTTP 5xx / 408 / 429 : le serveur est en difficulté, retenter plus tard. */
export function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

/** Instance partagée : pull de sync (3 tentatives, 500 ms → 1 s → 2 s + gigue). */
export const networkRetry = new RetryStrategy({
  baseMs: 500,
  factor: 2,
  maxMs: 8_000,
  maxAttempts: 3,
  jitterMs: 300,
});
