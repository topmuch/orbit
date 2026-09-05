// /api/subscribe — Enregistrement des abonnements Web Push (VAPID)
// ───────────────────────────────────────────────────────────────────────────
//   GET    → statut : { configured, publicKey, subscriptions } (l'utilisateur
//            garde sa clé publique pour PushManager.subscribe)
//   POST   → upsert de la subscription { endpoint, keys, userAgent?, platform? }
//            (liée à l'utilisateur, isActive à true)
//   DELETE → désinscription (par endpoint) — soft (isActive=false) pour garder
//            l'historique, la purge complète se fait sur 404/410 côté envoi.
// Le endpoint /api/notify envoie ensuite les notifications à ces abonnés.
import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { pushSubscribeSchema } from "@/lib/validators"
import { getVapidPublicKey, isPushConfigured, countSubscriptions } from "@/lib/push"

export const runtime = "nodejs"

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const subscriptions = await countSubscriptions(user.id)
  return NextResponse.json({
    configured: isPushConfigured(),
    publicKey: getVapidPublicKey(),
    subscriptions,
  })
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const parsed = pushSubscribeSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: "Données invalides" }, { status: 400 })
  }
  const { endpoint, keys, userAgent, platform } = parsed.data

  // Upsert par endpoint : un refresh de subscription ne crée pas de doublon.
  const existing = await db.pushSubscription.findFirst({
    where: { userId: user.id, endpoint },
  })
  if (existing) {
    await db.pushSubscription.update({
      where: { id: existing.id },
      data: { keys, userAgent, platform, isActive: true },
    })
  } else {
    await db.pushSubscription.create({
      data: { userId: user.id, endpoint, keys, userAgent, platform, isActive: true },
    })
  }

  return NextResponse.json(
    { ok: true, subscriptions: await countSubscriptions(user.id) },
    { status: 201 }
  )
}

export async function DELETE(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const body = (await req.json().catch(() => null)) as { endpoint?: string } | null
  if (!body?.endpoint) {
    return NextResponse.json({ error: "endpoint requis" }, { status: 400 })
  }

  // Soft delete : isActive=false (l'historique d'appareils reste consultable,
  // les purges dures ont lieu quand le service push répond 404/410).
  await db.pushSubscription.updateMany({
    where: { userId: user.id, endpoint: body.endpoint },
    data: { isActive: false },
  })

  return NextResponse.json({ ok: true, subscriptions: await countSubscriptions(user.id) })
}
