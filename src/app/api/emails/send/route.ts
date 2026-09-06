// POST /api/emails/send — Envoyer un email via SMTP (compte configuré)
// ─────────────────────────────────────────────────────────────────────────────
// Flux : validation Zod → compte possédé → SMTP requis (409 sinon) → envoi
// nodemailer (TLS 465 / STARTTLS 587, mot de passe déchiffré en mémoire) →
// copie stockée en base (dossier SENT) pour la vue « Envoyés ».
//
// Sécurité :
//   • rate limit 50 envois/heure/utilisateur ;
//   • from = adresse du compte (usurpation impossible, le serveur SMTP valide) ;
//   • réponse (répondre à un email) : In-Reply-To/References propagés → fil ;
//   • AUCUN mot de passe loggé (cf. lib/smtp — logger:false) ;
//   • échec SMTP → 502 avec message FR actionnable (auth/relais/TLS).
//
// Gmail/Outlook : mot de passe d'APPLICATION requis (2FA) — cf. guide
// docs/email-imap-guide.md (§ SMTP). Identifiants SMTP laissés vides =
// identifiants IMAP réutilisés.

import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { sendEmailSchema } from "@/lib/validators"
import { sendEmailFromAccount } from "@/lib/smtp"
import { snippetFromText } from "@/lib/html-sanitize"
import { toEmailDto } from "@/lib/dto"

export const runtime = "nodejs"
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  // 50 envois / heure / utilisateur (anti-abus + anti-ban serveur SMTP)
  const rl = rateLimit(`emails:send:${user.id}`, 50, 3_600_000)
  if (!rl.ok) return tooManyRequests(rl)

  const parsed = sendEmailSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }
  const input = parsed.data

  const account = await db.emailAccount.findFirst({
    where: { id: input.accountId, userId: user.id },
  })
  if (!account) return NextResponse.json({ error: "Compte introuvable" }, { status: 404 })

  if (!account.smtpHost) {
    return NextResponse.json(
      {
        error:
          "Envoi non configuré pour ce compte — ajoutez le serveur SMTP (Réglages → Comptes email, section « Envoi SMTP »).",
      },
      { status: 409 }
    )
  }

  // Réponse : email parent (fil de discussion)
  let inReplyTo: string | undefined
  let references: string[] | undefined
  if (input.replyToEmailId) {
    const parent = await db.emailLog.findFirst({
      where: { id: input.replyToEmailId, userId: user.id },
      select: { messageId: true, threadId: true },
    })
    if (parent) {
      inReplyTo = `<${parent.messageId}>`
      references = [parent.threadId, parent.messageId]
        .filter((m): m is string => Boolean(m))
        .map((m) => `<${m}>`)
    }
  }

  try {
    const result = await sendEmailFromAccount(account, user.name ?? account.label, {
      to: input.to,
      cc: input.cc,
      bcc: input.bcc,
      subject: input.subject,
      text: input.bodyText,
      inReplyTo,
      references,
    })

    // Copie « Envoyés » (consultable dans le dossier SENT d'Orbit)
    const sent = await db.emailLog.create({
      data: {
        userId: user.id,
        accountId: account.id,
        messageId: result.messageId || `orbit-sent-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@orbit.local`,
        fromAddress: account.address,
        fromName: user.name ?? account.label ?? null,
        toAddresses: input.to,
        subject: input.subject,
        snippet: snippetFromText(input.bodyText),
        bodyText: input.bodyText.slice(0, 20_000),
        receivedAt: new Date(),
        sentAt: new Date(),
        isRead: true, // l'auteur a forcément « lu » son propre message
        isProcessed: true, // pas d'analyse IA sur ses propres envois
        folder: "SENT",
        threadId: references?.[0]?.replace(/[<>]/g, "") ?? inReplyTo?.replace(/[<>]/g, "") ?? null,
      },
    })

    return NextResponse.json({
      ok: true,
      messageId: result.messageId,
      rejected: result.rejected,
      email: toEmailDto(sent),
    })
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message || "Échec de l'envoi SMTP" },
      { status: 502 }
    )
  }
}
