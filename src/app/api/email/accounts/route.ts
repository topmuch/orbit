// GET/POST /api/email/accounts — Comptes email IMAP + SMTP de l'utilisateur
// ─────────────────────────────────────────────────────────────────────────────
// GET  : comptes (DTO SANS mot de passe) + nombre d'emails synchronisés.
// POST : création — teste d'abord la connexion IMAP (sauf test:false explicite),
//        puis le SMTP si fourni (sauf testSmtp:false), chiffre les mots de
//        passe (AES-256-GCM) AVANT tout stockage. 409 si l'adresse est déjà
//        configurée pour cet utilisateur.

import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { emailAccountCreateSchema } from "@/lib/validators"
import { encryptSecret } from "@/lib/secret-box"
import { testImapConnection } from "@/lib/imap"
import { testSmtpConnection } from "@/lib/smtp"
import { toEmailAccountDto } from "@/lib/dto"

export const runtime = "nodejs"
export const maxDuration = 60

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const accounts = await db.emailAccount.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { emails: true } } },
  })

  return NextResponse.json({
    accounts: accounts.map((a) => toEmailAccountDto({ ...a, emailCount: a._count.emails })),
  })
}

export async function POST(req: Request) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const rl = rateLimit(`email-accounts:create:${user.id}`, 10, 60_000)
  if (!rl.ok) return tooManyRequests(rl)

  const parsed = emailAccountCreateSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }
  const input = parsed.data

  const existing = await db.emailAccount.findFirst({
    where: { userId: user.id, address: input.address },
    select: { id: true },
  })
  if (existing) {
    return NextResponse.json(
      { error: "Cette adresse email est déjà configurée" },
      { status: 409 }
    )
  }

  // Test de connexion PRÉALABLE (défaut) : aucun stockage si l'IMAP refuse.
  if (input.test) {
    const test = await testImapConnection({
      host: input.imapHost,
      port: input.imapPort,
      secure: input.imapSecure,
      username: input.username,
      password: input.password,
      allowSelfSigned: input.allowSelfSigned,
    })
    if (!test.ok) {
      return NextResponse.json({ error: test.error ?? "Connexion IMAP impossible" }, { status: 400 })
    }
  }

  // SMTP fourni ? Test préalable également (identifiants dédiés ou repli IMAP)
  const smtpHost = input.smtpHost?.trim() || null
  if (smtpHost && input.testSmtp) {
    const smtpTest = await testSmtpConnection({
      host: smtpHost,
      port: input.smtpPort ?? 587,
      secure: input.smtpSecure ?? true,
      username: input.smtpUsername?.trim() || input.username,
      password: input.smtpPassword || input.password, // repli IMAP si vide
    })
    if (!smtpTest.ok) {
      return NextResponse.json(
        { error: smtpTest.error ?? "Connexion SMTP impossible" },
        { status: 400 }
      )
    }
  }

  // Chiffrement AVANT stockage — les mots de passe ne transitent jamais en
  // clair vers la base (AES-256-GCM, clé dérivée de AUTH_SECRET).
  const smtpPassword = input.smtpPassword?.trim() || null
  const account = await db.emailAccount.create({
    data: {
      userId: user.id,
      label: input.label ?? null,
      address: input.address,
      imapHost: input.imapHost,
      imapPort: input.imapPort,
      imapSecure: input.imapSecure,
      username: input.username,
      passwordEnc: encryptSecret(input.password),
      allowSelfSigned: input.allowSelfSigned,
      syncIntervalMin: input.syncIntervalMin,
      fetchDays: input.fetchDays,
      maxMessages: input.maxMessages,
      // SMTP : null = envoi non configuré ; mot de passe dédié chiffré sinon
      // (null = repli sur les identifiants IMAP à l'envoi)
      smtpHost,
      smtpPort: smtpHost ? (input.smtpPort ?? 587) : null,
      smtpSecure: input.smtpSecure ?? true,
      smtpUsername: input.smtpUsername?.trim() || null,
      smtpPasswordEnc: smtpPassword ? encryptSecret(smtpPassword) : null,
    },
  })

  return NextResponse.json({ account: toEmailAccountDto({ ...account, emailCount: 0 }) }, { status: 201 })
}
