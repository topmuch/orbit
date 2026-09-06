// POST /api/email/accounts/test-smtp — Tester une connexion SMTP SANS stockage
// ─────────────────────────────────────────────────────────────────────────────
// Identique en esprit à /api/email/accounts/test (IMAP) : vérifie hôte/port/
// identifiants via nodemailer verify() (EHLO + AUTH + NOOP) puis jette tout.
// Aucun mot de passe n'est conservé — le test précède toujours l'enregistrement.

import { NextRequest, NextResponse } from "next/server"
import { getSessionUser } from "@/lib/auth"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { smtpTestSchema } from "@/lib/validators"
import { testSmtpConnection } from "@/lib/smtp"

export const runtime = "nodejs"
export const maxDuration = 30

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const rl = rateLimit(`email-accounts:test-smtp:${user.id}`, 10, 60_000)
  if (!rl.ok) return tooManyRequests(rl)

  const parsed = smtpTestSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }

  const result = await testSmtpConnection({
    host: parsed.data.smtpHost,
    port: parsed.data.smtpPort,
    secure: parsed.data.smtpSecure,
    username: parsed.data.username,
    password: parsed.data.password,
  })

  return NextResponse.json(result)
}
