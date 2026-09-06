// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Client SMTP (envoi réel via nodemailer) — serveur uniquement
// ───────────────────────────────────────────────────────────────────────────
// Envoi des emails depuis les comptes configurés (model EmailAccount, champs
// smtp*). Mêmes principes que l'IMAP :
//   • mot de passe déchiffré UNIQUEMENT en mémoire (AES-256-GCM, secret-box),
//     jamais loggé, jamais renvoyé ;
//   • port 465 = TLS implicite, 587 = STARTTLS (requireTLS) ;
//   • identifiants SMTP optionnels : à défaut, réutilisation des identifiants
//     IMAP (Gmail/Outlook utilisent les mêmes) ;
//   • erreurs traduites en FR actionnables (auth, réseau, TLS).
//   • rate limiting applicatif : cf. route /api/emails/send (50/h/utilisateur).
// ═══════════════════════════════════════════════════════════════════════════

import "server-only"
import nodemailer from "nodemailer"
import type { Transporter } from "nodemailer"
import type { EmailAccount } from "@prisma/client"
import { decryptSecret } from "@/lib/secret-box"

/** Timeout d'établissement de connexion SMTP. */
const CONNECT_TIMEOUT_MS = 15_000

/** Paramètres SMTP bruts (formulaires test + model). */
export interface SmtpConnectionConfig {
  host: string
  port: number
  /** true = TLS implicite (465) · false = STARTTLS (587) */
  secure: boolean
  username: string
  password: string
}

export interface SmtpTestResult {
  ok: boolean
  error?: string
}

/** Traduit une erreur nodemailer en message FR actionnable (sans secret). */
export function humanizeSmtpError(error: unknown): string {
  const err = error as { message?: string; response?: string; responseCode?: number }
  const raw = `${err?.message ?? String(error)} ${err?.response ?? ""}`.slice(0, 300)

  if (err?.responseCode === 535 || /AUTH|authentication|credentials|login/i.test(raw)) {
    return "Authentification SMTP refusée — vérifiez l'identifiant et le mot de passe (mot de passe d'application pour Gmail/Outlook)."
  }
  if (err?.responseCode === 550 || /relay|not permitted|rejected/i.test(raw)) {
    return "Envoi refusé par le serveur (relais interdit) — vérifiez que le compte est autorisé à envoyer."
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) {
    return "Serveur SMTP introuvable — vérifiez le nom d'hôte."
  }
  if (/ECONNREFUSED/i.test(raw)) {
    return "Connexion refusée — vérifiez le port SMTP (465 TLS, 587 STARTTLS)."
  }
  if (/ETIMEDOUT|timeout/i.test(raw)) {
    return "Délai dépassé — le serveur SMTP ne répond pas."
  }
  if (/certificate|self-signed|CERT|STARTTLS/i.test(raw)) {
    return "Négociation TLS impossible — vérifiez le mode (TLS 465 / STARTTLS 587) du serveur."
  }
  if (/recipient|address rejected|no valid/i.test(raw)) {
    return "Destinataire refusé par le serveur — vérifiez les adresses."
  }
  return raw || "Erreur SMTP inconnue"
}

/** Construit le transport nodemailer (AUCUN logger : trames sensibles). */
function makeTransport(cfg: SmtpConnectionConfig): Transporter {
  const isImplicitTls = cfg.secure || cfg.port === 465
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    // 465 → TLS implicite ; sinon STARTTLS (requis sur les ports de soumission
    // 587/25 — Gmail/Outlook l'exigent ; opportuniste sur les ports internes,
    // p.ex. relais QA 2525 sans STARTTLS)
    secure: isImplicitTls,
    requireTLS: !isImplicitTls && (cfg.port === 587 || cfg.port === 25),
    auth: { user: cfg.username, pass: cfg.password },
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: CONNECT_TIMEOUT_MS,
    socketTimeout: 60_000,
    // pool léger inutile ici : envois ponctuels, une connexion par envoi
    pool: false,
    logger: false, // JAMAIS de log nodemailer (peut contenir la trame AUTH)
    debug: false,
  })
}

/** Teste une connexion SMTP SANS rien envoyer (route /api/email/accounts/test-smtp). */
export async function testSmtpConnection(cfg: SmtpConnectionConfig): Promise<SmtpTestResult> {
  const transport = makeTransport(cfg)
  try {
    await transport.verify()
    return { ok: true }
  } catch (error) {
    return { ok: false, error: humanizeSmtpError(error) }
  } finally {
    transport.close()
  }
}

/** Résout la configuration SMTP effective d'un compte (avec replis IMAP). */
function resolveAccountSmtp(account: EmailAccount): SmtpConnectionConfig | null {
  if (!account.smtpHost) return null
  let password: string
  try {
    // Priorité : mot de passe SMTP dédié → sinon identifiants IMAP (Gmail…)
    password = account.smtpPasswordEnc
      ? decryptSecret(account.smtpPasswordEnc)
      : decryptSecret(account.passwordEnc)
  } catch {
    // Chiffrement altéré : l'appelant traduira via humanizeSmtpError
    throw new Error("Mot de passe SMTP illisible (chiffrement altéré ou AUTH_SECRET changé)")
  }
  return {
    host: account.smtpHost,
    port: account.smtpPort ?? 587,
    secure: account.smtpSecure,
    username: account.smtpUsername ?? account.username,
    password,
  }
}

/** true si le compte peut envoyer (hôte SMTP présent). */
export function accountCanSend(account: EmailAccount): boolean {
  return Boolean(account.smtpHost)
}

/** Payload d'envoi (validé en amont par Zod côté route). */
export interface SendEmailPayload {
  to: string[]
  cc?: string[]
  bcc?: string[]
  subject: string
  text: string
  /** Message-ID parent pour le fil de discussion (réponse). */
  inReplyTo?: string
  references?: string[]
}

export interface SendEmailResult {
  messageId: string
  accepted: string[]
  rejected: string[]
}

/**
 * Envoie un email depuis un compte configuré.
 * Lève une Error avec message FR en cas d'échec (route → 502/400).
 */
export async function sendEmailFromAccount(
  account: EmailAccount,
  fromName: string | null,
  payload: SendEmailPayload
): Promise<SendEmailResult> {
  const cfg = resolveAccountSmtp(account)
  if (!cfg) {
    throw new Error("Envoi non configuré pour ce compte — ajoutez le serveur SMTP dans les Réglages.")
  }

  const transport = makeTransport(cfg)
  try {
    const info = await transport.sendMail({
      // De : adresse du compte (spoofing impossible — le serveur SMTP valide)
      from: fromName ? `"${fromName.replace(/["\\]/g, "")}" <${account.address}>` : account.address,
      to: payload.to,
      cc: payload.cc?.length ? payload.cc : undefined,
      bcc: payload.bcc?.length ? payload.bcc : undefined,
      subject: payload.subject,
      text: payload.text,
      // Fil de discussion : In-Reply-To + References (client mail regroupe)
      inReplyTo: payload.inReplyTo,
      references: payload.references?.length ? payload.references : undefined,
      headers: {
        "X-Mailer": "Orbit (personal OS)",
        "X-Orbit-Account": account.address,
      },
    })

    return {
      messageId: (info.messageId ?? "").replace(/[<>]/g, ""),
      accepted: ((info.accepted ?? []) as unknown[]).map((a) =>
        typeof a === "string" ? a : String((a as { address?: string }).address ?? "")
      ),
      rejected: ((info.rejected ?? []) as unknown[]).map((a) =>
        typeof a === "string" ? a : String((a as { address?: string }).address ?? "")
      ),
    }
  } catch (error) {
    throw new Error(humanizeSmtpError(error))
  } finally {
    transport.close()
  }
}

/** Test SMTP à partir du compte stocké (bouton « Tester SMTP » d'un compte enregistré). */
export async function testAccountSmtp(account: EmailAccount): Promise<SmtpTestResult> {
  try {
    const cfg = resolveAccountSmtp(account)
    if (!cfg) return { ok: false, error: "Aucun serveur SMTP configuré pour ce compte." }
    return await testSmtpConnection(cfg)
  } catch (error) {
    return { ok: false, error: humanizeSmtpError(error) }
  }
}
