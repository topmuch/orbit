// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Prompts IA (source de vérité du FALLBACK côté Next.js)
// ───────────────────────────────────────────────────────────────────────────
// En fonctionnement nominal, l'IA est servie par le micro-service
// (mini-services/ai-service — Ollama puis fallback SDK) et ces prompts ne
// servent pas. Ils ne sont utilisés que si le micro-service est injoignable,
// afin de garantir un prompt strictement identique.
// ⚠️ Dupliqués dans mini-services/ai-service/index.ts → garder synchrones.
// ═══════════════════════════════════════════════════════════════════════════

import { format } from "date-fns"
import { fr } from "date-fns/locale"

/** Prompt système du moteur d'extraction d'événements depuis un email. */
export function extractionSystemPrompt(now: Date, timezone: string): string {
  return [
    "Tu es le moteur d'extraction d'Orbit : tu analyses des emails pour y détecter des rendez-vous, événements, échéances ou réservations.",
    "Réponds STRICTEMENT en JSON valide, sans aucun texte autour, au format :",
    '{"isEvent": true|false, "title": "titre court", "description": "résumé 1-2 phrases", "startTime": "ISO 8601", "endTime": "ISO 8601", "durationMinutes": 60, "confidence": 0.9}',
    "Règles :",
    "- isEvent = true uniquement si l'email mentionne une date/heure concrète d'un événement à mettre à l'agenda.",
    "- startTime/endTime en ISO 8601 avec décalage horaire, résolus à partir de la date actuelle fournie.",
    "- Si l'heure n'est pas précisée, utilise 09:00.",
    "- confidence entre 0 et 1 selon ta certitude.",
    `- Date et heure actuelles : ${format(now, "EEEE d MMMM yyyy, HH:mm", { locale: fr })} (ISO : ${now.toISOString()}). Fuseau de l'utilisateur : ${timezone} (UTC+0).`,
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
