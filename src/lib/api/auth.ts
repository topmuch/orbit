// Orbit — Authentification par clé API (API publique /api/v1)
// ─────────────────────────────────────────────────────────────────────────────
// Clé brute « orbit_<base64url> » fournie via `Authorization: Bearer …` ou
// `X-API-Key`. Seul le SHA-256 (hex) est stocké en base : on hache la clé
// candidate et on cherche par hash — un vol de base ne permet PAS de rejouer
// les clés. Les clés révoquées (isActive=false / revokedAt) sont rejetées.

import "server-only"
import { createHash } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"

/** Limite standard des routes v1 (req/min par clé). */
export const V1_RATE_LIMIT = 60

/** Identité issue d'une clé API valide. */
export type ApiKeyAuth = { userId: string; keyId: string }

/**
 * Vérifie la clé API d'une requête v1.
 * @returns null si absente/invalide/révoquée (→ répondre 401), sinon
 *          { userId, keyId } pour le filtrage d'ownership.
 */
export async function verifyApiKey(req: NextRequest): Promise<ApiKeyAuth | null> {
  // Bearer token OU en-tête dédié X-API-Key
  const authHeader = req.headers.get("authorization")
  let key: string | null = null
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    key = authHeader.slice(7).trim()
  } else {
    const raw = req.headers.get("x-api-key")
    key = raw?.trim() || null
  }
  if (!key) return null

  const keyHash = createHash("sha256").update(key).digest("hex")
  const apiKey = await db.apiKey.findUnique({ where: { keyHash } })
  if (!apiKey || !apiKey.isActive || apiKey.revokedAt) return null

  // Télémétrie fire-and-forget : ne jamais faire échouer la requête pour ça.
  db.apiKey
    .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
    .catch(() => {})

  return { userId: apiKey.userId, keyId: apiKey.id }
}

/** Réponse 401 standardisée de l'API publique (anglais : contrat REST public). */
export function v1Unauthorized(): NextResponse {
  return NextResponse.json({ error: "Invalid API key" }, { status: 401 })
}

/** Réponse 429 standardisée de l'API publique. */
export function v1TooMany(retryAfterSec = 60): NextResponse {
  return NextResponse.json(
    { error: "Too many requests — rate limit exceeded", retryAfterSec },
    { status: 429, headers: { "Retry-After": String(retryAfterSec) } }
  )
}
