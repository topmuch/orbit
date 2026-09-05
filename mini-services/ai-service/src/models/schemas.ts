// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Micro-service IA · schémas d'entrée (normalisation défensive)
// ───────────────────────────────────────────────────────────────────────────
// Équivalent sandbox des schémas Pydantic de la version FastAPI
// (docker/ai-service/models/schemas.py) — mêmes champs, mêmes bornes.
// La validation « stricte » (Zod) vit côté Next.js : ici on normalise
// toléramment des payloads déjà de confiance relative (appel serveur à
// serveur), en bornant tout ce qui part vers l'IA.
// ═══════════════════════════════════════════════════════════════════════════

import { LIMITS } from "../config"
import { sanitize } from "../utils"
import {
  STYLE_DESCRIPTIONS,
  STYLE_KEYS,
  SUMMARY_MAX_WORDS_DEFAULT,
  SUMMARY_MAX_WORDS_MAX,
  SUMMARY_MAX_WORDS_MIN,
} from "../prompts"

// ── POST /analyze-email ─────────────────────────────────────────────────────

export interface AnalyzeEmailBody {
  subject?: string
  from?: string
  bodyText?: string
  /** ISO — fourni par Next.js (horloge applicative cohérente). */
  now?: string
  timezone?: string
}

// ── POST /suggest-priority ──────────────────────────────────────────────────

export interface UserContext {
  totalTasks?: number
  urgentTasks?: number
  overdueTasks?: number
}

export interface SuggestPriorityBody {
  taskTitle?: string
  taskDescription?: string
  /** ISO ou null */
  dueDate?: string | null
  userContext?: UserContext
  now?: string
  timezone?: string
}

// ── POST /summarize ─────────────────────────────────────────────────────────

export type SummaryStyle = "bullet_points" | "paragraph" | "key_points"

export interface SummarizeBody {
  content?: string
  style?: string
  /** Longueur max du résumé en mots. */
  maxLength?: number
  now?: string
}

/** Normalise le style de synthèse (défaut : bullet_points). */
export function normalizeStyle(raw: unknown): SummaryStyle {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : ""
  return (STYLE_KEYS as SummaryStyle[]).includes(s as SummaryStyle)
    ? (s as SummaryStyle)
    : "bullet_points"
}

/** Borne la longueur demandée du résumé. */
export function normalizeMaxLength(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return SUMMARY_MAX_WORDS_DEFAULT
  return Math.min(SUMMARY_MAX_WORDS_MAX, Math.max(SUMMARY_MAX_WORDS_MIN, Math.round(n)))
}

export { LIMITS, STYLE_DESCRIPTIONS, sanitize }
