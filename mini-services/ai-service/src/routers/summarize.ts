// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Micro-service IA · routeur POST /summarize
// ───────────────────────────────────────────────────────────────────────────
// Synthèse de contenus longs (emails, descriptions de tâches, documents).
// Styles : bullet_points | paragraph | key_points — longueur bornée en mots.
// La valeur « now » permet de résoudre les dates relatives (« demain »…).
// ═══════════════════════════════════════════════════════════════════════════

import { LIMITS } from "../config"
import { cacheGet, cacheSet } from "../cache"
import {
  render,
  STYLE_DESCRIPTIONS,
  templates,
} from "../prompts"
import {
  normalizeMaxLength,
  normalizeStyle,
  type SummarizeBody,
} from "../models/schemas"
import { completeJsonRobust } from "../services/llm"
import { countWords, formatFrLong, hashString, hourBucket, sanitize } from "../utils"

export async function handleSummarize(body: SummarizeBody): Promise<Response> {
  const content = sanitize(body.content, LIMITS.summarizeContent)
  if (content.length < 200) {
    return Response.json(
      { error: "Contenu trop court pour une synthèse (200 caractères minimum)" },
      { status: 400 }
    )
  }

  const style = normalizeStyle(body.style)
  const maxLength = normalizeMaxLength(body.maxLength)
  const now = body.now && !Number.isNaN(Date.parse(body.now)) ? new Date(body.now) : new Date()

  // ── Cache (contenu + style + longueur + heure courante) ──────────────────
  const cacheKey = `summarize:${hashString(
    JSON.stringify({ c: hashString(content), style, maxLength, h: hourBucket(now.toISOString()) })
  )}`
  const cached = cacheGet<unknown>(cacheKey)
  if (cached) {
    return Response.json({ ...(cached as Record<string, unknown>), cached: true })
  }

  // ── Prompt système + contenu à synthétiser ───────────────────────────────
  const system = render(templates.summarization, {
    STYLE_DESCRIPTION: STYLE_DESCRIPTIONS[style] ?? STYLE_DESCRIPTIONS.bullet_points,
    MAX_WORDS: String(maxLength),
    NOW_FR: formatFrLong(now),
  })
  const user = [
    `Date et heure actuelles : ${formatFrLong(now)}.`,
    "",
    "Contenu à synthétiser :",
    content,
  ].join("\n")

  // ── Inférence ─────────────────────────────────────────────────────────────
  const completion = await completeJsonRobust(
    system,
    user,
    '{"summary": "texte du résumé"}'
  )
  if (!completion) {
    return Response.json({ error: "Aucune réponse du moteur IA" }, { status: 502 })
  }
  const { json, content: raw, provider, repaired } = completion

  // Repli tolérant : si même la réparation échoue, la prose EST déjà la
  // synthèse — on la nettoie des éventuels fences markdown.
  const summaryFromJson = typeof json?.summary === "string" ? json.summary.trim() : ""
  const summary = (summaryFromJson || raw
    .replace(/^```(?:json|text)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim()).slice(0, maxLength * 8) // garde-fou ~8 caractères/mot

  if (!summary) {
    return Response.json({
      result: null,
      provider,
      message: "Synthèse non exploitable",
      rawResponse: raw.slice(0, LIMITS.rawResponse),
    })
  }

  const result = {
    summary,
    originalLength: countWords(content),
    summaryLength: countWords(summary),
    style,
  }
  const payload = { result, provider, ...(repaired ? { repaired: true } : {}) }
  cacheSet(cacheKey, payload)
  return Response.json(payload)
}
