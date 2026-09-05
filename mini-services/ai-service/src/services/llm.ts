// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Micro-service IA · client LLM (routeur de providers)
// ───────────────────────────────────────────────────────────────────────────
//   Provider 1 : Ollama (http://OLLAMA_URL) — IA 100 % locale, aucune donnée
//                ne quitte la machine (objectif de confidentialité d'Orbit).
//   Provider 2 : z-ai-web-dev-sdk — fallback de l'environnement sandbox.
//
//   Tout appel transite par ces fonctions : remplacer un provider n'impacte
//   aucun routeur. Timeouts systématiques (Ollama 90 s, health 2 s).
// ═══════════════════════════════════════════════════════════════════════════

import ZAI from "z-ai-web-dev-sdk"
import { HEALTH_TIMEOUT_MS, OLLAMA_MODEL, OLLAMA_TIMEOUT_MS, OLLAMA_URL } from "../config"
import { parseJsonLoose } from "../utils"

// ── Provider 1 : Ollama ─────────────────────────────────────────────────────

export interface OllamaGenOptions {
  system: string
  prompt: string
  /** Force une sortie JSON valide côté Ollama (format: "json"). */
  json?: boolean
  stream?: boolean
}

/** POST {OLLAMA_URL}/api/generate — null si Ollama absent/indisponible/timeout. */
export async function ollamaGenerate(opts: OllamaGenOptions): Promise<Response | null> {
  if (!OLLAMA_URL) return null
  try {
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        system: opts.system,
        prompt: opts.prompt,
        format: opts.json ? "json" : undefined,
        stream: opts.stream ?? false,
        options: { temperature: 0.2 },
      }),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    })
    return res.ok ? res : null
  } catch {
    // Ollama éteint, timeout, modèle absent… → on bascule sur le fallback.
    return null
  }
}

/** GET {OLLAMA_URL}/api/tags — true si Ollama répond (health). */
export async function ollamaReachable(): Promise<boolean> {
  if (!OLLAMA_URL) return false
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
    return res.ok
  } catch {
    return false
  }
}

// ── Provider 2 : z-ai-web-dev-sdk (fallback sandbox) ───────────────────────

export async function zaiComplete(system: string, user: string): Promise<string | null> {
  const zai = await ZAI.create()
  const completion = await zai.chat.completions.create({
    messages: [
      // Rôle « system » (et non « assistant ») : indispensable pour que le
      // modèle respecte les instructions de format (JSON strict, français…).
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    thinking: { type: "disabled" },
  })
  return completion?.choices?.[0]?.message?.content ?? null
}

export async function zaiStream(
  system: string,
  messages: { role: string; content: string }[]
): Promise<ReadableStream<Uint8Array> | null> {
  const zai = await ZAI.create()
  return (await zai.chat.completions.create({
    messages: [{ role: "system", content: system }, ...messages],
    stream: true,
    thinking: { type: "disabled" },
  })) as ReadableStream<Uint8Array> | null
}

// ── Helpers de haut niveau ─────────────────────────────────────────────────

/** Complétion en mode JSON : Ollama (format forcé) → fallback SDK. */
export async function completeJson(
  system: string,
  prompt: string
): Promise<{ content: string; provider: string } | null> {
  // 1) Ollama — mode JSON
  const ollamaRes = await ollamaGenerate({ system, prompt, json: true })
  if (ollamaRes) {
    const data = (await ollamaRes.json().catch(() => null)) as { response?: string } | null
    if (data?.response) return { content: data.response, provider: "ollama" }
  }
  // 2) Fallback SDK
  const content = await zaiComplete(system, prompt).catch(() => null)
  if (content) return { content, provider: "zai-fallback" }
  return null
}

/** Résultat d'une complétion JSON robuste (parse + éventuelle réparation). */
export interface JsonCompletion {
  /** JSON parsé (null si la réparation elle-même a échoué). */
  json: Record<string, unknown> | null
  /** Contenu brut de la réponse principale (debug). */
  content: string
  provider: string
  /** true si une passe de réparation LLM a été nécessaire. */
  repaired: boolean
}

/**
 * Complétion JSON robuste — défense en profondeur (le LLM n'est jamais
 * garanti 100 % JSON, même avec format: "json" côté Ollama) :
 *   1. appel principal (Ollama JSON → fallback SDK) ;
 *   2. parse tolérant (fences markdown, texte autour) ;
 *   3. si échec : UNE passe de réparation — on redemande au modèle de
 *      convertir sa propre réponse en JSON strict conforme au format.
 */
export async function completeJsonRobust(
  system: string,
  prompt: string,
  expectedShape: string
): Promise<JsonCompletion | null> {
  // 1) Appel principal
  const first = await completeJson(system, prompt)
  if (!first) return null

  // 2) Parse tolérant
  const json = parseJsonLoose(first.content)
  if (json) return { json, content: first.content, provider: first.provider, repaired: false }

  // 3) Passe de réparation (une seule, fallback SDK uniquement)
  const repairedContent = await zaiComplete(
    [
      "Tu es un extracteur JSON strict.",
      "Convertis la réponse fournie en JSON valide conforme EXACTEMENT au format attendu.",
      "Réponds UNIQUEMENT par ce JSON, sans aucun texte autour, sans fencing markdown.",
    ].join(" "),
    `Format attendu :\n${expectedShape}\n\nRéponse à convertir :\n${first.content.slice(0, 4_000)}`
  ).catch(() => null)
  if (repairedContent) {
    const repairedJson = parseJsonLoose(repairedContent)
    if (repairedJson) {
      return { json: repairedJson, content: first.content, provider: first.provider, repaired: true }
    }
  }
  return { json: null, content: first.content, provider: first.provider, repaired: false }
}
