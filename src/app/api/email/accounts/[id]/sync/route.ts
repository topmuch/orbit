// POST /api/email/accounts/[id]/sync — Synchroniser UN compte maintenant
// ─────────────────────────────────────────────────────────────────────────────
// Déclenché par l'utilisateur (bouton « Synchroniser » sur un compte).
// L'auto-synchronisation passe par le reminder-service (:3032) →
// POST /api/notify {type:"email-sync"} — cf. lib/imap.ts syncDueAccounts.

import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { syncEmailAccount } from "@/lib/imap"

export const runtime = "nodejs"
export const maxDuration = 60

type Ctx = { params: Promise<{ id: string }> }

export async function POST(_req: Request, ctx: Ctx) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const rl = rateLimit(`email-accounts:sync:${user.id}`, 10, 60_000)
  if (!rl.ok) return tooManyRequests(rl)

  const { id } = await ctx.params
  const account = await db.emailAccount.findFirst({ where: { id, userId: user.id } })
  if (!account) return NextResponse.json({ error: "Compte introuvable" }, { status: 404 })
  if (!account.isActive) {
    return NextResponse.json({ error: "Compte suspendu — réactivez-le d'abord." }, { status: 400 })
  }

  const result = await syncEmailAccount(account)

  return NextResponse.json(
    {
      ok: result.ok,
      count: result.created,
      fetched: result.fetched,
      error: result.error ?? null,
    },
    { status: result.ok ? 200 : 400 }
  )
}
