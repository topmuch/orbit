// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Micro-service IA · configuration
// ───────────────────────────────────────────────────────────────────────────
// Ce module est le PREMIER importé par tous les autres : il charge le .env
// du projet parent (Bun ne lit que le .env du dossier courant) avant de
// figer les constantes, garantissant que OLLAMA_URL / AI_SERVICE_* soient
// bien pris en compte quelle que soit la façon dont le service démarre.
// ═══════════════════════════════════════════════════════════════════════════

import { readFileSync } from "node:fs"
import { join } from "node:path"

// ── Chargement du .env du projet parent (lecture synchrone, avant tout) ────
try {
  const raw = readFileSync(join(import.meta.dir, "..", "..", "..", ".env"), "utf8")
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/)
    if (!m) continue
    const [, key, value] = m
    // On ne surcharge jamais une variable déjà définie (process.env gagne).
    if (key in process.env) continue
    process.env[key] = value.replace(/^["']|["']$/g, "")
  }
} catch {
  // Pas de .env parent (ex. conteneur Docker) → valeurs par défaut.
}

// ── Ports & routes ──────────────────────────────────────────────────────────
export const PORT = 3031

// ── Ollama (IA 100 % locale, prioritaire) ──────────────────────────────────
export const OLLAMA_URL = (process.env.OLLAMA_URL ?? "").replace(/\/+$/, "")
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? "llama3.1:8b"
/** Timeout global par requête d'inférence Ollama (90 s par défaut). */
export const OLLAMA_TIMEOUT_MS = Number(process.env.OLLAMA_TIMEOUT_MS ?? 90_000)
/** Timeout du health-check Ollama (doit rester court). */
export const HEALTH_TIMEOUT_MS = 2_000

// ── Cache mémoire des réponses IA identiques ───────────────────────────────
// Clé = hash du payload utile (l'instant « now » est tronqué à l'heure pour
// que les requêtes répétées dans la même heure partagent leur réponse).
export const CACHE_TTL_MS = Number(process.env.AI_CACHE_TTL_MS ?? 600_000) // 10 min
export const CACHE_MAX_ENTRIES = 200

// ── Bornes de sanitization des entrées ─────────────────────────────────────
// Protège les prompts (et la mémoire) contre les contenus démesurés.
export const LIMITS = {
  subject: 500,
  emailBody: 4_000,
  taskTitle: 200,
  taskDescription: 2_000,
  summarizeContent: 12_000,
  chatMessage: 8_000,
  reasoning: 200,
  rawResponse: 800, // taille du champ de debug renvoyé au client
} as const
