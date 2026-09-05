// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Micro-service IA · chargement des prompts (prompts/*.txt)
// ───────────────────────────────────────────────────────────────────────────
// Les prompts système vivent dans des fichiers .txt éditables sans toucher au
// code. Placeholders {{CLE}} interpolés par render(). En cas d'échec de
// lecture (fichier manquant), un repli interne garantit le fonctionnement.
// ═══════════════════════════════════════════════════════════════════════════

import { LIMITS } from "./config"

async function loadTemplate(name: string, fallback: string): Promise<string> {
  const raw = await Bun.file(`${import.meta.dir}/../../prompts/${name}`).text().catch(() => null)
  return raw && raw.trim() ? raw : fallback
}

/** Interpolation {{CLE}} → valeur. Les clés absentes sont supprimées. */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, key: string) => vars[key] ?? "")
}

export const templates = {
  emailAnalysis: await loadTemplate("email_analysis.txt", "fallback"),
  prioritySuggestion: await loadTemplate("priority_suggestion.txt", "fallback"),
  summarization: await loadTemplate("summarization.txt", "fallback"),
  chat: await loadTemplate("chat.txt", "fallback"),
}

/** Descriptions de style injectées dans le prompt de synthèse. */
export const STYLE_DESCRIPTIONS: Record<string, string> = {
  bullet_points: "liste à puces de 3 à 7 points, chaque puce sur sa propre ligne commençant par « • »",
  paragraph: "un paragraphe compact et fluide, sans liste",
  key_points: "3 à 5 points clés séparés par des sauts de ligne, chacun préfixé par « — »",
}

export const STYLE_KEYS = Object.keys(STYLE_DESCRIPTIONS)

/** Longueur par défaut/limites du résumé (en mots). */
export const SUMMARY_MAX_WORDS_DEFAULT = 150
export const SUMMARY_MAX_WORDS_MIN = 30
export const SUMMARY_MAX_WORDS_MAX = 600

export { LIMITS }
