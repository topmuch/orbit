// GET/POST /api/webhooks — Gestion des webhooks sortants (session auth)
// ─────────────────────────────────────────────────────────────────────────────
// GET  : webhooks de l'utilisateur + 5 dernières livraisons chacun.
//        secretEnc JAMAIS exposé (le secret n'est connu que du propriétaire,
//        affiché une seule fois à la création).
// POST : { url (https strict hors localhost), events (non vide ⊆ WEBHOOK_EVENTS), description? }
//        → secret aléatoire, stocké CHIFFRÉ AES-256-GCM ; renvoyé UNE SEULE
//        fois dans la réponse 201 (pour vérifier les signatures HMAC).

import { NextRequest, NextResponse } from "next/server"
import { randomBytes } from "node:crypto"
import { z } from "zod"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { encryptSecret } from "@/lib/secret-box"
import { WEBHOOK_EVENTS } from "@/lib/api/webhooks"

// ─────────────────────────────────────────────────────────────────────────────
// Validation d'URL : https OBLIGATOIRE en production — toléré en http pour
// localhost/127.0.0.1 uniquement (tests locaux, récepteur de dev, conteneurs
// du réseau interne). Un webhook http externe serait trop facile à intercepter.
const LOCALHOST_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//i

const webhookCreateSchema = z.object({
  url: z
    .string()
    .trim()
    .url("URL invalide")
    .refine(
      (value) => value.startsWith("https://") || LOCALHOST_PATTERN.test(value),
      "URL invalide (https requis hors localhost)"
    ),
  events: z
    .array(z.enum(WEBHOOK_EVENTS), {
      message: "Événement invalide",
    })
    .min(1, "Sélectionnez au moins un événement")
    .max(WEBHOOK_EVENTS.length),
  description: z.string().trim().max(200, "Description trop longue (200 max)").optional(),
})

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const rl = rateLimit(`webhooks:list:${user.id}`, 30)
  if (!rl.ok) return tooManyRequests(rl)

  const webhooks = await db.webhook.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    include: {
      logs: {
        orderBy: { createdAt: "desc" },
        take: 5,
        select: { event: true, status: true, statusCode: true, error: true, createdAt: true },
      },
    },
  })

  // Sanitisation : events (Json) tel quel (validé à l'entrée), PAS secretEnc.
  const sanitized = webhooks.map((wh) => ({
    id: wh.id,
    url: wh.url,
    description: wh.description,
    events: Array.isArray(wh.events) ? (wh.events as string[]) : [],
    isActive: wh.isActive,
    lastStatus: wh.lastStatus,
    lastDeliveryAt: wh.lastDeliveryAt?.toISOString() ?? null,
    lastError: wh.lastError,
    createdAt: wh.createdAt.toISOString(),
    logs: wh.logs.map((log) => ({
      event: log.event,
      status: log.status,
      statusCode: log.statusCode,
      error: log.error,
      createdAt: log.createdAt.toISOString(),
    })),
  }))

  return NextResponse.json({ webhooks: sanitized })
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const rl = rateLimit(`webhooks:create:${user.id}`, 30)
  if (!rl.ok) return tooManyRequests(rl)

  const parsed = webhookCreateSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }

  // Secret de signature : généré côté serveur, stocké chiffré (AES-256-GCM).
  const secret = randomBytes(24).toString("base64url")
  const secretEnc = encryptSecret(secret)

  const webhook = await db.webhook.create({
    data: {
      userId: user.id,
      url: parsed.data.url,
      description: parsed.data.description || null,
      events: parsed.data.events,
      secretEnc,
    },
  })

  // Secret en clair : UNE SEULE fois, ici — jamais re-servi ensuite.
  return NextResponse.json(
    {
      webhook: {
        id: webhook.id,
        url: webhook.url,
        description: webhook.description,
        events: parsed.data.events,
        isActive: webhook.isActive,
        lastStatus: webhook.lastStatus,
        lastDeliveryAt: webhook.lastDeliveryAt?.toISOString() ?? null,
        lastError: webhook.lastError,
        createdAt: webhook.createdAt.toISOString(),
        logs: [],
      },
      secret,
    },
    { status: 201 }
  )
}
