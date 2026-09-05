// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Prompts IA (source de vérité du FALLBACK côté Next.js)
// ───────────────────────────────────────────────────────────────────────────
// En fonctionnement nominal, l'IA est servie par le micro-service
// (mini-services/ai-service — Ollama puis fallback SDK) et ces prompts ne
// servent pas. Ils ne sont utilisés que si le micro-service est injoignable,
// afin de garantir un prompt strictement identique.
// ⚠️ Duplicata des prompts/*.txt du micro-service → garder synchrones.
// ═══════════════════════════════════════════════════════════════════════════

import { format } from "date-fns"
import { fr } from "date-fns/locale"

function nowLine(now: Date, timezone: string): string {
  return `- Date et heure actuelles : ${format(now, "EEEE d MMMM yyyy, HH:mm", { locale: fr })} (ISO : ${now.toISOString()}). Fuseau de l'utilisateur : ${timezone}.`
}

/** Prompt système du moteur d'extraction d'événements depuis un email. */
export function extractionSystemPrompt(now: Date, timezone: string): string {
  return [
    "Tu es le moteur d'extraction d'Orbit : tu analyses des emails pour y détecter des rendez-vous, événements, échéances ou réservations.",
    "Réponds STRICTEMENT en JSON valide, sans aucun texte autour, au format :",
    '{"isEvent": true|false, "title": "titre court", "description": "résumé 1-2 phrases", "startTime": "ISO 8601", "endTime": "ISO 8601", "durationMinutes": 60, "location": "lieu" | null, "attendees": ["email@exemple.fr"], "confidence": 0.9}',
    "Règles :",
    "- isEvent = true uniquement si l'email mentionne une date/heure concrète d'un événement à mettre à l'agenda.",
    "- startTime/endTime en ISO 8601 avec décalage horaire, résolus à partir de la date actuelle fournie.",
    "- Si l'heure n'est pas précisée, utilise 09:00.",
    "- ANNÉE : un rendez-vous d'email est TOUJOURS dans le futur ; sans année précisée, utilise l'année de la date actuelle.",
    "- NE JAMAIS INVENTER : attendees = uniquement les emails réellement cités (expéditeur inclus) ; location = null si absent.",
    "- confidence entre 0 et 1 selon ta certitude.",
    nowLine(now, timezone),
  ].join("\n")
}

/** Prompt utilisateur construit à partir d'un email brut. */
export function buildExtractionUserPrompt(subject: string, from: string, bodyText: string): string {
  return [
    `Objet : ${subject}`,
    `De : ${from}`,
    "",
    "Corps de l'email :",
    bodyText.slice(0, 4000),
  ].join("\n")
}

/** Prompt système de suggestion de priorité de tâche. */
export function prioritySuggestionSystemPrompt(now: Date, timezone: string): string {
  return [
    "Tu es l'assistant de priorisation d'Orbit : tu suggères la priorité d'une tâche à partir de son titre, sa description, son échéance et la charge de travail de l'utilisateur.",
    "Priorités disponibles : LOW, MEDIUM, HIGH, URGENT.",
    "Facteurs : échéance proche/passée, mots-clés d'urgence (« urgent », « deadline », « ASAP »…), charge existante (ne pas tout mettre en URGENT), nature client/interne/personnel.",
    "Réponds STRICTEMENT en JSON valide, sans aucun texte autour :",
    '{"suggestedPriority": "LOW|MEDIUM|HIGH|URGENT", "confidence": 0.8, "reasoning": "explication courte (120 caractères max)"}',
    nowLine(now, timezone),
  ].join("\n")
}

/** Prompt utilisateur : tâche + contexte de charge. */
export function buildPriorityUserPrompt(input: {
  title: string
  description?: string | null
  dueDate?: string | null
  userContext: { totalTasks: number; urgentTasks: number; overdueTasks: number }
}): string {
  return [
    "Tâche à prioriser :",
    `- Titre : ${input.title}`,
    `- Description : ${input.description?.trim() || "(aucune)"}`,
    `- Échéance : ${input.dueDate ?? "aucune"}`,
    "",
    "Contexte de travail de l'utilisateur :",
    `- ${input.userContext.totalTasks} tâche(s) active(s) au total`,
    `- ${input.userContext.urgentTasks} déjà en priorité URGENT`,
    `- ${input.userContext.overdueTasks} en retard (échéance dépassée)`,
  ].join("\n")
}

/** Descriptions de style pour la synthèse (mêmes libellés que le micro-service). */
export const STYLE_DESCRIPTIONS: Record<string, string> = {
  bullet_points: "liste à puces de 3 à 7 points, chaque puce sur sa propre ligne commençant par « • »",
  paragraph: "un paragraphe compact et fluide, sans liste",
  key_points: "3 à 5 points clés séparés par des sauts de ligne, chacun préfixé par « — »",
}

/** Prompt système de synthèse de contenu. */
export function summarizationSystemPrompt(style: string, maxWords: number, now: Date): string {
  return [
    "Tu es le moteur de synthèse d'Orbit : tu résumes des contenus longs en préservant les informations essentielles (dates, horaires, lieux, montants, noms, décisions).",
    `Style demandé : ${STYLE_DESCRIPTIONS[style] ?? STYLE_DESCRIPTIONS.bullet_points}`,
    `Longueur maximale du résumé : ${maxWords} mots.`,
    "Réponds en français, sans commentaire ni préambule.",
    "Réponds STRICTEMENT en JSON valide, sans aucun texte autour :",
    '{"summary": "texte du résumé"}',
    `- Date et heure actuelles : ${format(now, "EEEE d MMMM yyyy, HH:mm", { locale: fr })}.`,
  ].join("\n")
}

/** Prompt utilisateur : contenu à synthétiser. */
export function buildSummarizeUserPrompt(content: string, now: Date): string {
  return [
    `Date et heure actuelles : ${format(now, "EEEE d MMMM yyyy, HH:mm", { locale: fr })}.`,
    "",
    "Contenu à synthétiser :",
    content.slice(0, 12000),
  ].join("\n")
}
