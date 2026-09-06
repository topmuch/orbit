// POST /api/emails/sync — Synchronisation réelle des comptes IMAP
// ─────────────────────────────────────────────────────────────────────────────
// Si l'utilisateur a des comptes IMAP actifs : synchronisation réelle de TOUS
// (lib/imap — lecture seule, upsert dédoublonné, mot de passe déchiffré
// uniquement en mémoire). Retourne le détail par compte.
//
// SANS compte configuré : la génération de démonstration historique est
// conservée (sandbox sans identifiants réels) et signalée par demo:true —
// le contrat client reste { ok, count }.

import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { syncUserAccounts } from "@/lib/imap"
import { generateIncomingEmails } from "@/lib/demo"

export const runtime = "nodejs"
export const maxDuration = 60

export async function POST() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const rl = rateLimit(`emails:sync:${user.id}`, 10, 60_000)
  if (!rl.ok) return tooManyRequests(rl)

  const accounts = await db.emailAccount.findMany({
    where: { userId: user.id, isActive: true },
    select: { id: true },
  })

  // Aucun compte réel configuré → fallback démo (données locales uniquement)
  if (!accounts.length) {
    const count = await generateIncomingEmails(user.id, 2 + Math.floor(Math.random() * 2))
    return NextResponse.json({ ok: true, demo: true, count })
  }

  const results = await syncUserAccounts(user.id)
  const created = results.reduce((sum, r) => sum + r.created, 0)
  const failed = results.filter((r) => !r.ok && !r.error?.includes("en cours"))

  return NextResponse.json({
    ok: failed.length === 0,
    count: created,
    accounts: results.map((r) => ({
      accountId: r.accountId,
      address: r.address,
      ok: r.ok,
      created: r.created,
      error: r.error ?? undefined,
    })),
  })
}
