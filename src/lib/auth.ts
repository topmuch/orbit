// Orbit — Authentification (Phase 1)
// Sessions par cookie httpOnly signé HMAC-SHA256 + mots de passe hachés scrypt.
// (Équivalent fonctionnel NextAuth credentials/JWT, optimisé pour l'environnement proxy.)

import "server-only"
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { cookies } from "next/headers"
import { db } from "@/lib/db"
import type { SessionUser } from "@/lib/types"

const COOKIE_NAME = "orbit_session"
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 jours

function getSecret(): string {
  const secret = process.env.AUTH_SECRET
  if (!secret) throw new Error("AUTH_SECRET manquant dans .env")
  return secret
}

// ---------- Mots de passe ----------

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex")
  const hash = scryptSync(password, salt, 64).toString("hex")
  return `${salt}:${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":")
  if (!salt || !hash) return false
  const candidate = scryptSync(password, salt, 64)
  const expected = Buffer.from(hash, "hex")
  if (candidate.length !== expected.length) return false
  return timingSafeEqual(candidate, expected)
}

// ---------- Token de session ----------

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url")
}

function sign(payload: string): string {
  return createHmac("sha256", getSecret()).update(payload).digest("base64url")
}

export function createSessionToken(userId: string): string {
  const payload = base64url(
    JSON.stringify({
      uid: userId,
      iat: Date.now(),
      exp: Date.now() + SESSION_TTL_MS,
    })
  )
  return `${payload}.${sign(payload)}`
}

function verifySessionToken(token: string): { uid: string } | null {
  const [payload, signature] = token.split(".")
  if (!payload || !signature) return null
  const expected = sign(payload)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString())
    if (typeof data.uid !== "string" || typeof data.exp !== "number") return null
    if (Date.now() > data.exp) return null
    return { uid: data.uid }
  } catch {
    return null
  }
}

// ---------- Gestion du cookie de session ----------

export async function setSessionCookie(userId: string): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.set(COOKIE_NAME, createSessionToken(userId), {
    httpOnly: true,
    sameSite: "lax",
    secure: false, // gateway proxy en HTTP interne
    path: "/",
    maxAge: SESSION_TTL_MS / 1000,
  })
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies()
  cookieStore.delete(COOKIE_NAME)
}

/** Retourne l'utilisateur connecté (ou null) */
export async function getSessionUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies()
  const token = cookieStore.get(COOKIE_NAME)?.value
  if (!token) return null
  const data = verifySessionToken(token)
  if (!data) return null
  const user = await db.user.findUnique({
    where: { id: data.uid },
    select: { id: true, email: true, name: true, preferences: true },
  })
  if (!user) return null
  // Onboarding (features avancées) : drapeau dans User.preferences (JSON) —
  // exposé à la SPA pour déclencher le wizard de première connexion.
  const onboardingCompleted =
    (user.preferences as Record<string, unknown> | null)?.onboardingCompleted === true
  return { id: user.id, email: user.email, name: user.name, onboardingCompleted }
}