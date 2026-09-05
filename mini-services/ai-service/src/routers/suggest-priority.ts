// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Micro-service IA · routeur POST /suggest-priority
// ───────────────────────────────────────────────────────────────────────────
// Suggestion de priorité LOW/MEDIUM/HIGH/URGENT pour une tâche, à partir de
// son titre/description/échéance + contexte de charge de l'utilisateur.
// Réponse : { result: { suggestedPriority, confidence, reasoning }, provider,
// cached } — la persistance (aiSuggestedPriority/aiConfidence) reste côté
// Next.js (ownership + transaction), ce routeur est sans état.
// ═══════════════════════════════════════════════════════════════════════════

import { LIMITS } from "../config"
import { cacheGet, cacheSet } from "../cache"
import { render, templates } from "../prompts"
import { completeJsonRobust } from "../services/llm"
import type { SuggestPriorityBody } from "../models/schemas"
import { clampNumber, formatFrLong, hashString, hourBucket, sanitize } from "../utils"

const PRIORITIES = ["LOW", "MEDIUM", "HIGH", "URGENT"] as const

/**
 * Repli tolérant quand le LLM répond en prose au lieu du JSON demandé
 * (cf. spec : « L'IA peut retourner du JSON invalide, toujours try/catch »).
 * On accepte uniquement un signal non ambigu : motif « priorité : X » ou
 * token entre guillemets ; sinon un SEUL niveau distinct cité dans le texte.
 */
function extractPriorityFromText(
  raw: string
): { suggestedPriority: string; confidence: number; reasoning: string } | null {
  const explicit = raw.match(
    /(?:priorit(?:é|y)|recommandation|suggestion|niveau)\s*(?:à|:|=|est)?\s*["«']?\s*(URGENT|HIGH|MEDIUM|LOW)\b/i
  )
  if (explicit) {
    return { suggestedPriority: explicit[1].toUpperCase(), confidence: 0.5, reasoning: "" }
  }
  const quoted = raw.match(/"(URGENT|HIGH|MEDIUM|LOW)"/)
  if (quoted) return { suggestedPriority: quoted[1], confidence: 0.5, reasoning: "" }

  // Dernier recours : un seul niveau distinct mentionné dans toute la réponse.
  const distinct = new Set(raw.match(/\b(URGENT|HIGH|MEDIUM|LOW)\b/g) ?? [])
  if (distinct.size === 1) {
    const [only] = distinct
    return { suggestedPriority: only, confidence: 0.4, reasoning: "" }
  }
  return null
}

export async function handleSuggestPriority(body: SuggestPriorityBody): Promise<Response> {
  const taskTitle = sanitize(body.taskTitle, LIMITS.taskTitle)
  if (!taskTitle) {
    return Response.json({ error: "taskTitle requis" }, { status: 400 })
  }
  const taskDescription = sanitize(body.taskDescription, LIMITS.taskDescription)
  const dueDate = typeof body.dueDate === "string" && !Number.isNaN(Date.parse(body.dueDate))
    ? body.dueDate
    : null

  const now = body.now && !Number.isNaN(Date.parse(body.now)) ? new Date(body.now) : new Date()
  const timezone = sanitize(body.timezone, 64) || "Africa/Dakar"

  const ctx = body.userContext ?? {}
  const totalTasks = clampNumber(ctx.totalTasks, 0, 9_999, 0)
  const urgentTasks = clampNumber(ctx.urgentTasks, 0, 9_999, 0)
  const overdueTasks = clampNumber(ctx.overdueTasks, 0, 9_999, 0)

  // ── Cache (tâche + contexte + heure courante) ────────────────────────────
  const cacheKey = `priority:${hashString(
    JSON.stringify({ taskTitle, taskDescription, dueDate, totalTasks, urgentTasks, overdueTasks, h: hourBucket(now.toISOString()) })
  )}`
  const cached = cacheGet<unknown>(cacheKey)
  if (cached) {
    return Response.json({ ...(cached as Record<string, unknown>), cached: true })
  }

  // ── Prompt système + contexte utilisateur ────────────────────────────────
  const system = render(templates.prioritySuggestion, {
    NOW_FR: formatFrLong(now),
    NOW_ISO: now.toISOString(),
    TIMEZONE: timezone,
  })
  const user = [
    "Tâche à prioriser :",
    `- Titre : ${taskTitle}`,
    `- Description : ${taskDescription || "(aucune)"}`,
    `- Échéance : ${dueDate ?? "aucune"}`,
    "",
    "Contexte de travail de l'utilisateur :",
    `- ${totalTasks} tâche(s) active(s) au total`,
    `- ${urgentTasks} déjà en priorité URGENT`,
    `- ${overdueTasks} en retard (échéance dépassée)`,
  ].join("\n")

  // ── Inférence ─────────────────────────────────────────────────────────────
  const completion = await completeJsonRobust(
    system,
    user,
    '{"suggestedPriority": "LOW|MEDIUM|HIGH|URGENT", "confidence": 0.0-1.0, "reasoning": "explication courte"}'
  )
  if (!completion) {
    return Response.json({ error: "Aucune réponse du moteur IA" }, { status: 502 })
  }
  const { json, content, provider, repaired } = completion

  const rawPriority =
    typeof json?.suggestedPriority === "string" ? json.suggestedPriority.toUpperCase() : ""

  // ── Normalisation (JSON strict → repli prose) ────────────────────────────
  let result: { suggestedPriority: string; confidence: number; reasoning: string } | null =
    json && PRIORITIES.includes(rawPriority as (typeof PRIORITIES)[number])
      ? {
          suggestedPriority: rawPriority,
          confidence: clampNumber(json.confidence, 0, 1, 0.5),
          reasoning:
            typeof json.reasoning === "string" ? json.reasoning.trim().slice(0, LIMITS.reasoning) : "",
        }
      : extractPriorityFromText(content)

  if (!result) {
    return Response.json({
      result: null,
      provider,
      message: "Priorité non reconnue dans la réponse IA",
      rawResponse: content.slice(0, LIMITS.rawResponse),
    })
  }

  const payload = { result, provider, ...(repaired ? { repaired: true } : {}) }
  cacheSet(cacheKey, payload)
  return Response.json(payload)
}
