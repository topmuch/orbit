// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Micro-service IA · routeur POST /analyze-email
// ───────────────────────────────────────────────────────────────────────────
// Extraction de rendez-vous depuis un email : date, horaires, durée, LIEU et
// PARTICIPANTS (enrichi Prompt IA locale). Cache mémoire 10 min (clé = hash
// du payload, « now » tronqué à l'heure). Les bornes métier finales restent
// côté Next.js (suggestionFromExtracted).
// ═══════════════════════════════════════════════════════════════════════════

import { LIMITS } from "../config"
import { cacheGet, cacheSet } from "../cache"
import { render, templates } from "../prompts"
import { completeJsonRobust } from "../services/llm"
import type { AnalyzeEmailBody } from "../models/schemas"
import { formatFrLong, hashString, hourBucket, sanitize } from "../utils"

export async function handleAnalyzeEmail(body: AnalyzeEmailBody): Promise<Response> {
  const subject = sanitize(body.subject, LIMITS.subject)
  const from = sanitize(body.from, 320)
  const bodyText = sanitize(body.bodyText, LIMITS.emailBody)
  if (!subject && !bodyText) {
    return Response.json({ error: "subject ou bodyText requis" }, { status: 400 })
  }

  const now = body.now && !Number.isNaN(Date.parse(body.now)) ? new Date(body.now) : new Date()
  const timezone = sanitize(body.timezone, 64) || "Africa/Dakar"

  // ── Cache (payload utile + heure courante) ───────────────────────────────
  const cacheKey = `analyze:${hashString(
    JSON.stringify({ subject, from, bodyText, h: hourBucket(now.toISOString()), timezone })
  )}`
  const cached = cacheGet<unknown>(cacheKey)
  if (cached) {
    return Response.json({ ...(cached as Record<string, unknown>), cached: true })
  }

  // ── Prompt système (template + interpolation) ────────────────────────────
  const system = render(templates.emailAnalysis, {
    NOW_FR: formatFrLong(now),
    NOW_ISO: now.toISOString(),
    TIMEZONE: timezone,
  })
  const user = [
    `Objet : ${subject}`,
    `De : ${from}`,
    "",
    "Corps de l'email :",
    bodyText,
  ].join("\n")

  // ── Inférence : Ollama (JSON forcé) → fallback SDK ───────────────────────
  const completion = await completeJsonRobust(
    system,
    user,
    '{"isEvent": true|false, "title": "titre court", "description": "résumé 1-2 phrases", "startTime": "ISO 8601", "endTime": "ISO 8601", "durationMinutes": 60, "location": "lieu ou null", "attendees": ["emails"], "confidence": 0.9}'
  )
  if (!completion) {
    return Response.json({ error: "Aucune réponse du moteur IA" }, { status: 502 })
  }
  const { json, content, provider, repaired } = completion

  if (!json) {
    return Response.json({
      result: null,
      provider,
      message: "Réponse non exploitable",
      rawResponse: content.slice(0, LIMITS.rawResponse),
    })
  }

  // ── Normalisation douce + garde-fous déterministes ───────────────────────
  // Participants : l'IA peut inventer des adresses — on ne conserve QUE les
  // adresses réellement présentes dans l'email source, en y ajoutant celles
  // détectées par regex (expéditeur inclus). Aucune invention ne passe.
  const sourceLower = `${subject}\n${from}\n${bodyText}`.toLowerCase()
  const inputEmails = [...new Set(sourceLower.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) ?? [])]
  const aiAttendees = (Array.isArray(json.attendees) ? json.attendees : [])
    .filter((a): a is string => typeof a === "string")
    .map((a) => a.trim().slice(0, 254))
    .filter((a) => a.includes("@") && sourceLower.includes(a.toLowerCase()))
  const attendees = [...new Set([...inputEmails, ...aiAttendees])].slice(0, 10)

  // Année : un rendez-vous email est TOUJOURS dans le futur — si l'IA renvoie
  // une date à plus de 90 jours dans le passé alors que la même date ramenée
  // à l'année courante est future (email sans année explicite), on corrige.
  let startTime = typeof json.startTime === "string" ? json.startTime : ""
  let endTime = typeof json.endTime === "string" ? json.endTime : ""
  let yearAdjusted = false
  const startMs = Date.parse(startTime)
  if (!Number.isNaN(startMs) && now.getTime() - startMs > 90 * 86_400_000) {
    const candidate = new Date(startMs)
    candidate.setUTCFullYear(now.getUTCFullYear())
    if (candidate.getTime() > now.getTime() - 86_400_000) {
      const shift = candidate.getTime() - startMs
      startTime = candidate.toISOString()
      const endMs = Date.parse(endTime)
      // La fin suit le même décalage si elle reste collée au début (< 48 h).
      if (!Number.isNaN(endMs) && Math.abs(endMs - startMs) < 48 * 3_600_000) {
        endTime = new Date(endMs + shift).toISOString()
      }
      yearAdjusted = true
    }
  }

  const result = {
    isEvent: json.isEvent !== false,
    title: typeof json.title === "string" ? json.title.trim().slice(0, 120) : "",
    description: typeof json.description === "string" ? json.description.slice(0, 500) : "",
    startTime,
    endTime,
    durationMinutes: Number(json.durationMinutes) || 60,
    location: typeof json.location === "string" && json.location.trim() ? json.location.trim().slice(0, 200) : null,
    attendees,
    confidence: Number(json.confidence) || 0.5,
    ...(yearAdjusted ? { yearAdjusted: true } : {}),
  }

  const payload = {
    result,
    provider,
    ...(repaired ? { repaired: true } : {}),
    // Debug côté client (tronqué) — jamais loggé côté service (confidentialité).
    rawResponse: content.slice(0, LIMITS.rawResponse),
  }
  cacheSet(cacheKey, payload)
  return Response.json(payload)
}
