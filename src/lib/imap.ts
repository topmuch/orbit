// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Connecteur IMAP réel (lecture seule) — usage serveur uniquement
// ───────────────────────────────────────────────────────────────────────────
// Récupère les emails des comptes IMAP configurés (model EmailAccount) et les
// insère dans EmailLog (upsert par Message-ID, dédoublonné par utilisateur).
//
// Principes :
//   • LECTURE SEULE : jamais de STORE/EXPUNGE — les drapeaux \Seen du serveur
//     ne sont jamais modifiés (BODY.PEEK[] via imapflow).
//   • Mot de passe déchiffré UNIQUEMENT en mémoire au moment de la connexion
//     (AES-256-GCM, cf. lib/secret-box) — jamais loggé, jamais renvoyé.
//   • Anti-doublon : upsert sur @@unique([userId, messageId]) → re-synchroniser
//     deux fois ne crée jamais de copie.
//   • Fenêtre de récupération : depuis lastSyncAt (recouvrement de 10 min)
//     ou, à la première sync, les `fetchDays` derniers jours. Bornes strictes
//     de messages par passe (maxMessages) pour protéger SQLite.
//   • Déclencheurs : manuel (session) ou automatique (reminder-service :3032
//     → POST /api/notify {type:"email-sync"} toutes les 60 s, la route ne
//     traitant que les comptes ÉCHUS).
// ═══════════════════════════════════════════════════════════════════════════

import "server-only"
import { ImapFlow } from "imapflow"
import { simpleParser } from "mailparser"
import { db } from "@/lib/db"
import { decryptSecret } from "@/lib/secret-box"
import type { EmailAccount } from "@prisma/client"

/** Bornes de protection (corps tronqué, jamais de email géant en base). */
const BODY_MAX_CHARS = 20_000
/** Recouvrement entre deux sync (les dates IMAP sont approximatives). */
const SYNC_OVERLAP_MS = 10 * 60 * 1000
/** Timeout de connexion IMAP (serveur injoignable ≠ blocage de la route). */
const CONNECT_TIMEOUT_MS = 15_000
const SOCKET_TIMEOUT_MS = 60_000

/** Paramètres de connexion (formulaires + model). */
export interface ImapConnectionConfig {
  host: string
  port: number
  secure: boolean
  username: string
  password: string
  allowSelfSigned: boolean
}

/** Résultat d'un test de connexion (aucun secret, jamais d'email). */
export interface ImapTestResult {
  ok: boolean
  mailboxes: string[]
  messageCount: number | null
  error?: string
}

function imapClient(cfg: ImapConnectionConfig): ImapFlow {
  return new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.username, pass: cfg.password },
    tls: {
      // QA/serveurs internes : certificat auto-signé accepté explicitement.
      rejectUnauthorized: !cfg.allowSelfSigned,
    },
    logger: false, // JAMAIS de log imapflow : les trames peuvent contenir des données sensibles
    connectionTimeout: CONNECT_TIMEOUT_MS,
    greetingTimeout: 15_000,
    socketTimeout: SOCKET_TIMEOUT_MS,
    disableAutoIdle: true, // sync ponctuelle, pas de veille
  })
}

/** Ferme proprement un client IMAP (idempotent). */
async function closeClient(client: ImapFlow): Promise<void> {
  try {
    if (client.usable) await client.logout()
    else client.close()
  } catch {
    client.close()
  }
}

/** Teste une connexion IMAP SANS rien stocker (route /api/email/accounts/test). */
export async function testImapConnection(cfg: ImapConnectionConfig): Promise<ImapTestResult> {
  const client = imapClient(cfg)
  try {
    await client.connect()
    const mailboxes = (await client.list()).map((m) => String(m.path)).slice(0, 30)
    let messageCount: number | null = null
    try {
      const lock = await client.getMailboxLock("INBOX")
      try {
        messageCount = client.mailbox ? client.mailbox.exists : null
      } finally {
        lock.release()
      }
    } catch {
      // INBOX absente (boîte exotique) : la connexion reste valide
    }
    return { ok: true, mailboxes, messageCount }
  } catch (error) {
    return {
      ok: false,
      mailboxes: [],
      messageCount: null,
      // Message technique court, sans identifiants (imapflow ne les inclut pas
      // dans les messages d'erreur, on re-tranche par sécurité).
      error: humanizeImapError(error),
    }
  } finally {
    await closeClient(client)
  }
}

/** Traduit une erreur imapflow en message FR actionnable. */
function humanizeImapError(error: unknown): string {
  const err = error as { message?: string; response?: string }
  // imapflow : message générique (« Command failed ») + réponse serveur dans
  // .response (« 1 NO [AUTHENTICATIONFAILED] … ») — jamais de mot de passe
  // (la trame LOGIN est masquée côté imapflow, re-tranché par sécurité).
  const raw = `${err?.message ?? String(error)} ${err?.response ?? ""}`.slice(0, 300)
  const text = raw
  if (/AUTHENTICATIONFAILED|LOGIN failed|invalid credentials|authentication/i.test(text)) {
    return "Authentification refusée — vérifiez l'identifiant et le mot de passe (et l'authentification à 2 facteurs pour Gmail/Outlook : utilisez un mot de passe d'application)."
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) {
    return "Serveur introuvable — vérifiez le nom d'hôte IMAP."
  }
  if (/ECONNREFUSED/i.test(text)) {
    return "Connexion refusée — vérifiez le port IMAP (993 en TLS, 143 en STARTTLS)."
  }
  if (/ETIMEDOUT|CONNECT_TIMEOUT|timeout/i.test(text)) {
    return "Délai dépassé — le serveur ne répond pas (pare-feu ?)."
  }
  if (/certificate|self-signed|CERT/i.test(text)) {
    return "Certificat TLS invalide ou auto-signé — activez l'option « Certificat auto-signé » si ce serveur est le vôtre."
  }
  if (/ECONNRESET/i.test(text)) {
    return "Connexion réinitialisée par le serveur."
  }
  return text
}

/** Résultat d'une synchronisation (aucun contenu d'email). */
export interface AccountSyncResult {
  accountId: string
  address: string
  ok: boolean
  created: number
  fetched: number
  error?: string
}

/** HTML → texte brut approximatif (secours quand le message n'a pas de partie texte). */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

/** Garde-fou anti-concurrence : un même compte n'est jamais sync deux fois. */
const syncing = new Set<string>()

/**
 * Synchronise UN compte : connexion, INBOX, recherche des messages reçus
 * depuis la dernière sync (ou fetchDays j), parse MIME, upsert EmailLog.
 */
export async function syncEmailAccount(account: EmailAccount): Promise<AccountSyncResult> {
  const base: AccountSyncResult = {
    accountId: account.id,
    address: account.address,
    ok: false,
    created: 0,
    fetched: 0,
  }

  if (syncing.has(account.id)) {
    return { ...base, ok: true, error: "Synchronisation déjà en cours" }
  }
  syncing.add(account.id)

  const now = new Date()
  // Fenêtre : première sync → fetchDays j · sinon lastSyncAt - recouvrement
  const fallbackStart = new Date(now.getTime() - account.fetchDays * 24 * 3600 * 1000)
  const since = account.lastSyncAt
    ? new Date(Math.min(account.lastSyncAt.getTime() - SYNC_OVERLAP_MS, fallbackStart.getTime()))
    : fallbackStart

  let password: string
  try {
    password = decryptSecret(account.passwordEnc)
  } catch {
    const error = "Mot de passe illisible (chiffrement ALTÉRÉ ou AUTH_SECRET changé) — ressaisissez-le."
    await markSync(account, now, { status: "error", error })
    return { ...base, error }
  }

  const client = imapClient({
    host: account.imapHost,
    port: account.imapPort,
    secure: account.imapSecure,
    username: account.username,
    password,
    allowSelfSigned: account.allowSelfSigned,
  })

  try {
    await client.connect()

    let created = 0
    let fetched = 0

    const lock = await client.getMailboxLock("INBOX")
    try {
      // Recherche par date de réception interne (précision jour — d'où le
      // recouvrement et le dédoublonnage par upsert). `search` peut renvoyer
      // false (aucun résultat) → tableau vide.
      const uids = (await client.search({ since }, { uid: true })) || []
      const selection = uids.slice(-account.maxMessages)

      if (selection.length) {
        for await (const msg of client.fetch(
          selection,
          { uid: true, internalDate: true, source: true },
          { uid: true }
        )) {
          fetched++
          if (!msg.source) continue
          try {
            const parsed = await simpleParser(msg.source)
            // Message-ID, avec repli stable par UID (messages mal formés)
            const messageId =
              (parsed.messageId ?? `imap-${account.id}-${msg.uid}`).replace(/[<>]/g, "").trim() ||
              `imap-${account.id}-${msg.uid}`
            const from = parsed.from?.value?.[0]
            const body =
              (parsed.text ?? "").trim() ||
              htmlToText(typeof parsed.html === "string" ? parsed.html : "")
            const received = parsed.date ?? msg.internalDate ?? now

            const existing = await db.emailLog.findUnique({
              where: { userId_messageId: { userId: account.userId, messageId } },
              select: { id: true },
            })
            if (existing) continue // déjà synchronisé (upsert idempotent)

            await db.emailLog.create({
              data: {
                userId: account.userId,
                accountId: account.id,
                messageId,
                fromAddress: from?.address ?? "inconnu@inconnu",
                fromName: from?.name?.trim() || null,
                subject: (parsed.subject ?? "").trim() || "(sans objet)",
                bodyText: body.slice(0, BODY_MAX_CHARS),
                receivedAt: received instanceof Date ? received : new Date(received),
              },
            })
            created++
          } catch {
            // Un message illisible n'échoue jamais toute la sync
          }
        }
      }
    } finally {
      lock.release()
    }

    await markSync(account, now, { status: "ok", count: created })
    return { ...base, ok: true, created, fetched }
  } catch (error) {
    const errorText = humanizeImapError(error)
    await markSync(account, now, { status: "error", error: errorText })
    return { ...base, error: errorText }
  } finally {
    syncing.delete(account.id)
    await closeClient(client)
  }
}

/** Met à jour la télémétrie de sync (jamais de contenu). */
async function markSync(
  account: EmailAccount,
  at: Date,
  result: { status: "ok" | "error"; count?: number; error?: string }
): Promise<void> {
  await db.emailAccount
    .update({
      where: { id: account.id },
      data: {
        lastSyncAt: at,
        lastSyncStatus: result.status,
        lastSyncError: result.error ?? null,
        lastSyncCount: result.count ?? 0,
      },
    })
    .catch(() => {})
}

/** Synchronise tous les comptes ACTIFS d'un utilisateur (bouton « Synchroniser »). */
export async function syncUserAccounts(userId: string): Promise<AccountSyncResult[]> {
  const accounts = await db.emailAccount.findMany({ where: { userId, isActive: true } })
  const results: AccountSyncResult[] = []
  for (const account of accounts) {
    results.push(await syncEmailAccount(account))
  }
  return results
}

/**
 * Comptes dus pour la synchronisation automatique : actifs dont l'intervalle
 * est écoulé (ou jamais synchronisés). Appelé par le cycle reminder-service.
 */
export async function syncDueAccounts(): Promise<{ due: number; results: AccountSyncResult[] }> {
  const now = Date.now()
  const accounts = await db.emailAccount.findMany({ where: { isActive: true }, take: 50 })
  const due = accounts.filter(
    (a) =>
      !a.lastSyncAt ||
      now - a.lastSyncAt.getTime() >= Math.max(5, a.syncIntervalMin) * 60_000
  )
  const results: AccountSyncResult[] = []
  // Séquentiel : une passerelle IMAP = un flux à la fois, erreurs isolées
  for (const account of due) {
    results.push(await syncEmailAccount(account))
  }
  return { due: due.length, results }
}
