// PATCH/DELETE /api/email/accounts/[id] — Modifier / supprimer un compte IMAP+SMTP
// ─────────────────────────────────────────────────────────────────────────────
// PATCH   : réglages (label, intervalle, fenêtre, actif…) ; si l'hôte, le port,
//          l'identifiant OU le mot de passe change → test de connexion préalable
//          (test:true demandé par l'UI) puis re-chiffrement du mot de passe.
//          SMTP : smtpHost null = désactiver l'envoi ; mot de passe SMTP vide =
//          inchangé (ou repli IMAP) ; testSmtp:true → vérification à l'enregistrement.
//          LE MOT DE PASSE N'EST JAMAIS RENVOYÉ (champ vide = inchangé).
// DELETE  : supprime le compte. Les emails DÉJÀ synchronisés restent
//          consultables (relation SetNull) — seul le lien disparaît.

import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { emailAccountPatchSchema } from "@/lib/validators"
import { encryptSecret, decryptSecret } from "@/lib/secret-box"
import { testImapConnection } from "@/lib/imap"
import { testSmtpConnection } from "@/lib/smtp"
import { toEmailAccountDto } from "@/lib/dto"

export const runtime = "nodejs"
export const maxDuration = 60

type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(req: Request, ctx: Ctx) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const rl = rateLimit(`email-accounts:patch:${user.id}`, 20, 60_000)
  if (!rl.ok) return tooManyRequests(rl)

  const { id } = await ctx.params
  const account = await db.emailAccount.findFirst({ where: { id, userId: user.id } })
  if (!account) return NextResponse.json({ error: "Compte introuvable" }, { status: 404 })

  const parsed = emailAccountPatchSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }
  const input = parsed.data

  // Paramètres de connexion modifiés ? (mot de passe, hôte, port, identifiant)
  const connectionChanged =
    input.password !== undefined ||
    input.imapHost !== undefined ||
    input.imapPort !== undefined ||
    input.imapSecure !== undefined ||
    input.username !== undefined

  if (connectionChanged && input.test) {
    // Test avec les NOUVEAUX paramètres (mot de passe existant si non fourni)
    let password: string
    try {
      password = input.password ?? decryptSecret(account.passwordEnc)
    } catch {
      return NextResponse.json(
        { error: "Mot de passe actuel illisible (AUTH_SECRET changé ?) — ressaisissez-le." },
        { status: 400 }
      )
    }
    const test = await testImapConnection({
      host: input.imapHost ?? account.imapHost,
      port: input.imapPort ?? account.imapPort,
      secure: input.imapSecure ?? account.imapSecure,
      username: input.username ?? account.username,
      password,
      allowSelfSigned: input.allowSelfSigned ?? account.allowSelfSigned,
    })
    if (!test.ok) {
      return NextResponse.json({ error: test.error ?? "Connexion IMAP impossible" }, { status: 400 })
    }
  }

  const data: Record<string, unknown> = {
    label: input.label === undefined ? undefined : input.label,
    imapHost: input.imapHost,
    imapPort: input.imapPort,
    imapSecure: input.imapSecure,
    username: input.username,
    allowSelfSigned: input.allowSelfSigned,
    syncIntervalMin: input.syncIntervalMin,
    fetchDays: input.fetchDays,
    maxMessages: input.maxMessages,
    isActive: input.isActive,
  }
  // Re-chiffrement du mot de passe si fourni
  if (input.password !== undefined) data.passwordEnc = encryptSecret(input.password)

  // ── SMTP : configuration effective après fusion (entrée ⊕ état actuel) ──
  const effectiveSmtpHost =
    input.smtpHost === undefined ? account.smtpHost : input.smtpHost?.trim() || null
  const effectiveSmtpPort = input.smtpPort ?? account.smtpPort ?? 587
  const effectiveSmtpSecure = input.smtpSecure ?? account.smtpSecure
  const effectiveSmtpUsername =
    input.smtpUsername === undefined
      ? account.smtpUsername
      : input.smtpUsername?.trim() || null
  // Mot de passe SMTP effectif : saisi > SMTP stocké (déchiffré) > IMAP (repli)
  let effectiveSmtpPassword: string | null = null
  if (input.smtpPassword !== undefined && input.smtpPassword !== "") {
    effectiveSmtpPassword = input.smtpPassword
  } else if (account.smtpPasswordEnc) {
    effectiveSmtpPassword = decryptSecret(account.smtpPasswordEnc)
  }

  // Test SMTP si demandé ET configuration SMTP présente ET modifiée
  const smtpChanged =
    input.smtpHost !== undefined ||
    input.smtpPort !== undefined ||
    input.smtpSecure !== undefined ||
    input.smtpUsername !== undefined ||
    (input.smtpPassword !== undefined && input.smtpPassword !== "")
  if (effectiveSmtpHost && input.testSmtp && smtpChanged) {
    const smtpTest = await testSmtpConnection({
      host: effectiveSmtpHost,
      port: effectiveSmtpPort,
      secure: effectiveSmtpSecure,
      username: effectiveSmtpUsername ?? account.username,
      password: effectiveSmtpPassword ?? decryptSecret(account.passwordEnc),
    })
    if (!smtpTest.ok) {
      return NextResponse.json(
        { error: smtpTest.error ?? "Connexion SMTP impossible" },
        { status: 400 }
      )
    }
  }

  data.smtpHost = effectiveSmtpHost
  data.smtpPort = effectiveSmtpHost ? effectiveSmtpPort : null
  data.smtpSecure = effectiveSmtpSecure
  data.smtpUsername = effectiveSmtpUsername
  // Mot de passe SMTP : saisi → chiffré · null explicite → repli IMAP ·
  // absent → conserver le stock actuel
  if (input.smtpPassword !== undefined && input.smtpPassword !== "") {
    data.smtpPasswordEnc = encryptSecret(input.smtpPassword)
  } else if (input.smtpHost === null) {
    data.smtpPasswordEnc = null // envoi désactivé → secret inutile
  }

  const updated = await db.emailAccount.update({
    where: { id: account.id },
    data,
    include: { _count: { select: { emails: true } } },
  })

  return NextResponse.json({
    account: toEmailAccountDto({ ...updated, emailCount: updated._count.emails }),
  })
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const { id } = await ctx.params
  const account = await db.emailAccount.findFirst({
    where: { id, userId: user.id },
    select: { id: true },
  })
  if (!account) return NextResponse.json({ error: "Compte introuvable" }, { status: 404 })

  // Les emails synchronisés sont conservés (accountId → null)
  await db.emailAccount.delete({ where: { id: account.id } })

  return NextResponse.json({ ok: true })
}
