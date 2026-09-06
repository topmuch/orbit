// GET/POST /api/keys — Gestion des clés d'API (session auth)
// ─────────────────────────────────────────────────────────────────────────────
// GET  : clés de l'utilisateur — keyHash JAMAIS exposé (id, name, keyPrefix,
//        lastUsedAt, createdAt, isActive, revokedAt).
// POST : { name (1-60) } → génération d'une clé « orbit_<base64url> ». La clé
//        brute est renvoyée UNE SEULE FOIS (réponse 201) : côté serveur seul
//        son SHA-256 est conservé (comparaison par hash — vol de base inutile).

import { NextRequest, NextResponse } from "next/server"
import { createHash, randomBytes } from "node:crypto"
import { z } from "zod"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"

const keyCreateSchema = z.object({
  name: z.string().trim().min(1, "Le nom de la clé est requis").max(60, "Nom trop long (60 max)"),
})

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const rl = rateLimit(`keys:list:${user.id}`, 30)
  if (!rl.ok) return tooManyRequests(rl)

  const keys = await db.apiKey.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      lastUsedAt: true,
      createdAt: true,
      isActive: true,
      revokedAt: true,
    },
  })

  return NextResponse.json({ keys })
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const rl = rateLimit(`keys:create:${user.id}`, 30)
  if (!rl.ok) return tooManyRequests(rl)

  const parsed = keyCreateSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }

  // Clé brute : préfixe lisible + 24 octets aléatoires (base64url, ~32 car.)
  const secret = `orbit_${randomBytes(24).toString("base64url")}`
  const keyHash = createHash("sha256").update(secret).digest("hex")
  const keyPrefix = secret.slice(0, 14) // "orbit_" + 8 car. non sensibles

  const apiKey = await db.apiKey.create({
    data: {
      userId: user.id,
      name: parsed.data.name,
      keyHash,
      keyPrefix,
    },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      lastUsedAt: true,
      createdAt: true,
      isActive: true,
      revokedAt: true,
    },
  })

  // Secret complet : UNE SEULE fois, ici — jamais re-servi ensuite.
  return NextResponse.json({ apiKey, secret }, { status: 201 })
}
