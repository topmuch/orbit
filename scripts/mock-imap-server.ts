// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Serveur IMAP de QA (mock) · port 3993 (TLS auto-signé)
// ───────────────────────────────────────────────────────────────────────────
// But : valider la chaîne IMAP RÉELLE (imapflow + mailparser) en sandbox,
// sans serveur externe. Parle un sous-ensemble suffisant d'IMAP4rev1 :
//   greeting + CAPABILITY, LOGIN, LIST, SELECT/EXAMINE, STATUS, NOOP, ID,
//   UID SEARCH (SINCE), UID/FETCH (UID INTERNALDATE BODY.PEEK[]), LOGOUT.
// 3 messages MIME : ASCII simple, UTF-8 accents (base64), texte long.
//
// Démarrage :  bun scripts/mock-imap-server.ts
// Identifiants QA : utilisateur "qa@orbit.app" / mot de passe "qa-imap-pass"
// Compte Orbit : host 127.0.0.1 · port 3993 · TLS ✓ · auto-signé ✓
// ═══════════════════════════════════════════════════════════════════════════

import * as tls from "node:tls"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const PORT = 3993
const CERT_DIR = join(dirname(fileURLToPath(import.meta.url)), "certs")

const QA_USER = "qa@orbit.app"
const QA_PASS = "qa-imap-pass"

// ── Messages MIME servis par le mock ────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

function imapDate(d: Date): string {
  return `${String(d.getUTCDate()).padStart(1, "0")}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()}`
}
function imapDateTime(d: Date): string {
  const hh = String(d.getUTCHours()).padStart(2, "0")
  const mm = String(d.getUTCMinutes()).padStart(2, "0")
  const ss = String(d.getUTCSeconds()).padStart(2, "0")
  return `${imapDate(d)} ${hh}:${mm}:${ss} +0000`
}
function rfc2822(d: Date): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  return `${days[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${imapDateTime(d).split(" ")[1]} +0000`
}

const now = Date.now()
const hoursAgo = (h: number) => new Date(now - h * 3600_000)

// Corps UTF-8 encodé base64 (accents, signatures multi-lignes)
const utf8Body = Buffer.from(
  `Bonjour,

La réunion produit de mardi est confirmée en salle Kepler.
Au programme : roadmap T4, revue des retours utilisateurs, point sur le budget.

Merci de préparer vos chiffres avant lundi 18 h.

Bien cordialement,
Élodie Martin
Cheffe de produit — Orbit
Tél. : +33 1 23 45 67 89`,
  "utf8"
).toString("base64")

interface MockMessage {
  uid: number
  internalDate: Date
  flags: string[]
  raw: Buffer
}

function message(uid: number, date: Date, headers: string, body: string, bodyEncoding?: string): MockMessage {
  const mime =
    `From: ${headers.split("\n")[0]}\r\n` +
    `To: ${QA_USER}\r\n` +
    `Subject: ${headers.split("\n")[1]}\r\n` +
    `Date: ${rfc2822(date)}\r\n` +
    `Message-ID: <mock-${uid}-${date.getTime()}@orbit-qa.local>\r\n` +
    `MIME-Version: 1.0\r\n` +
    `Content-Type: text/plain; charset=${bodyEncoding ? "utf-8" : "us-ascii"}\r\n` +
    (bodyEncoding ? `Content-Transfer-Encoding: ${bodyEncoding}\r\n` : "") +
    `\r\n` +
    body
  return { uid, internalDate: date, flags: uid === 3 ? ["\\Seen"] : [], raw: Buffer.from(mime, "utf8") }
}

const MESSAGES: MockMessage[] = [
  message(
    1,
    hoursAgo(5),
    `"Cabinet Dentaire Voltaire" <contact@voltaire-dentaire.fr>\nRappel - rendez-vous chez le dentiste`,
    `Bonjour,

Nous vous confirmons votre rendez-vous de contrôle le jeudi 10 septembre a 14 h 30
au 22 avenue Voltaire, 75011 Paris.

Duree prevue : 45 minutes. Merci d'arriver 10 minutes avant.

Cabinet Dentaire Voltaire`
  ),
  message(
    2,
    hoursAgo(26),
    `=?UTF-8?B?w4lsb2RpZSBNYXJ0aW4=?= <elodie.martin@orbit-qa.local>\n=?UTF-8?B?UsOpdW5pb24gw6lxdWlwZSBwcm9kdWl0?=`,
    utf8Body,
    "base64"
  ),
  message(
    3,
    hoursAgo(50),
    `"Facturation Orange" <facturation@orange.fr>\nVotre facture Orange de septembre est disponible`,
    `Bonjour,

Votre facture du mois de septembre est disponible dans votre espace client.
Montant : 46,90 euros. Prelevement le 15 du mois.

Service Facturation Orange`
  ),
]

// ── Mini-serveur IMAP ───────────────────────────────────────────────────────

interface Session {
  socket: tls.TLSSocket
  tag: string
  authenticated: boolean
  selected: boolean
  buffer: string
}

const server = tls.createServer(
  {
    key: readFileSync(join(CERT_DIR, "mock-key.pem")),
    cert: readFileSync(join(CERT_DIR, "mock-cert.pem")),
  },
  (socket) => {
    const session: Session = {
      socket,
      tag: "",
      authenticated: false,
      selected: false,
      buffer: "",
    }

    const write = (line: string) => socket.write(line.endsWith("\r\n") ? line : `${line}\r\n`)

    // Greeting avec capacités (imapflow s'appuie dessus)
    write(`* OK [CAPABILITY IMAP4rev1 UIDPLUS MOVE] Orbit mock IMAP ready (QA)`)

    socket.on("data", (chunk: Buffer) => {
      session.buffer += chunk.toString("binary")

      while (true) {
        const idx = session.buffer.indexOf("\r\n")
        if (idx === -1) return
        const line = session.buffer.slice(0, idx)
        session.buffer = session.buffer.slice(idx + 2)
        handleLine(session, line)
      }
    })

    socket.on("error", () => {})
    socket.on("close", () => {})
  }
)

function handleLine(session: Session, line: string) {
  const write = (l: string) => session.socket.write(l.endsWith("\r\n") ? l : `${l}\r\n`)
  const trimmed = line.trim()
  if (!trimmed) return

  const parts = trimmed.split(" ")
  const tag = parts[0]
  const command = (parts[1] ?? "").toUpperCase()

  switch (command) {
    case "CAPABILITY":
      write(`* CAPABILITY IMAP4rev1 UIDPLUS MOVE`)
      write(`${tag} OK CAPABILITY completed`)
      break

    case "ID":
      write(`* ID ("name" "Orbit Mock IMAP" "version" "1.0")`)
      write(`${tag} OK ID completed`)
      break

    case "NOOP":
      write(`${tag} OK NOOP completed`)
      break

    case "LOGIN": {
      // LOGIN user pass (éventuellement entre guillemets)
      const m = trimmed.match(/^(\S+)\s+LOGIN\s+(?:"([^"]*)"|(\S+))\s+(?:"([^"]*)"|(\S+))$/i)
      const user = m ? (m[2] ?? m[3]) : null
      const pass = m ? (m[4] ?? m[5]) : null
      if (user === QA_USER && pass === QA_PASS) {
        session.authenticated = true
        write(`${tag} OK [CAPABILITY IMAP4rev1 UIDPLUS] LOGIN completed`)
      } else {
        write(`${tag} NO [AUTHENTICATIONFAILED] Authentication failed`)
      }
      break
    }

    case "AUTHENTICATE":
      write(`${tag} NO [AUTHENTICATIONFAILED] AUTH mechanisms not supported — use LOGIN`)
      break

    case "LIST":
      write(`* LIST (\\HasNoChildren) "/" "INBOX"`)
      write(`${tag} OK LIST completed`)
      break

    case "SELECT":
    case "EXAMINE": {
      if (!session.authenticated) {
        write(`${tag} NO Not authenticated`)
        break
      }
      session.selected = true
      write(`* ${MESSAGES.length} EXISTS`)
      write(`* 0 RECENT`)
      write(`* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)`)
      write(`* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)] Flags permitted`)
      write(`* OK [UIDVALIDITY 1757116800] UIDs valid`)
      write(`* OK [UIDNEXT ${MESSAGES.length + 1}] Predicted next UID`)
      write(`${tag} OK [READ-WRITE] ${command} completed`)
      break
    }

    case "STATUS": {
      write(`* STATUS "INBOX" (MESSAGES ${MESSAGES.length} RECENT 0)`)
      write(`${tag} OK STATUS completed`)
      break
    }

    case "UID":
    case "FETCH": {
      if (!session.authenticated || !session.selected) {
        write(`${tag} NO No mailbox selected`)
        break
      }
      const isUid = command === "UID"
      const rest = trimmed.slice(tag.length + (isUid ? 5 : 1)).trim()
      // rest = "SEARCH SINCE 1-Sep-2026" | "FETCH 1,2,3 (…)"
      const sub = rest.split(/\s+/)[0].toUpperCase()
      const remainder = rest.slice(sub.length).trim()

      if (sub === "SEARCH") {
        // UID SEARCH SINCE <date> (et variantes avec ALL)
        const sinceMatch = remainder.match(/SINCE\s+(\d{1,2}-\w{3}-\d{4})/i)
        let ids = MESSAGES.map((m) => m.uid)
        if (sinceMatch) {
          const since = Date.parse(`${sinceMatch[1].replace(/-(\d)-/, "-0$1-")} 00:00:00 UTC`)
          if (!Number.isNaN(since)) {
            ids = MESSAGES.filter((m) => m.internalDate.getTime() >= since).map((m) => m.uid)
          }
        }
        write(`* SEARCH ${ids.join(" ")}`.trimEnd())
        write(`${tag} OK SEARCH completed`)
        break
      }

      if (sub === "FETCH") {
        // Range "1,2,3" | "1:3" | "1:*" + query "(UID INTERNALDATE BODY.PEEK[])"
        const rangePart = remainder.split(/\s+/)[0]
        const uids = parseRange(rangePart)
        for (const uid of uids) {
          const msg = MESSAGES.find((m) => m.uid === uid)
          if (!msg) continue
          const seq = MESSAGES.indexOf(msg) + 1
          const flags = msg.flags.length ? `FLAGS (${msg.flags.join(" ")})` : ""
          // Littéral BODY[] : {N}\r\n<octets bruts>)\r\n
          const head =
            `* ${seq} FETCH (UID ${msg.uid} ${flags} INTERNALDATE "${imapDateTime(msg.internalDate)}" BODY[] {${msg.raw.length}}\r\n`
          session.socket.write(head)
          session.socket.write(msg.raw)
          session.socket.write(")\r\n")
        }
        write(`${tag} OK FETCH completed`)
        break
      }

      write(`${tag} BAD Unknown subcommand ${sub}`)
      break
    }

    case "CLOSE":
      session.selected = false
      write(`${tag} OK CLOSE completed`)
      break

    case "LOGOUT":
      write(`* BYE Orbit mock IMAP closing`)
      write(`${tag} OK LOGOUT completed`)
      session.socket.end()
      break

    case "ENABLE":
    case "UNSELECT":
    case "EXPUNGE":
    case "CHECK":
      write(`${tag} OK ${command} completed`)
      break

    default:
      write(`${tag} BAD Unknown command ${command}`)
  }
}

/** "1,2,3" | "1:3" | "1:*" | "4" → liste d'UIDs. */
function parseRange(range: string): number[] {
  const out: number[] = []
  for (const part of range.split(",")) {
    const m = part.trim().match(/^(\d+):(\*|\d+)$/)
    if (m) {
      const start = Number(m[1])
      const end = m[2] === "*" ? MESSAGES[MESSAGES.length - 1].uid : Number(m[2])
      for (let i = start; i <= end; i++) out.push(i)
    } else if (/^\d+$/.test(part.trim())) {
      out.push(Number(part.trim()))
    }
  }
  return out.filter((uid) => MESSAGES.some((m) => m.uid === uid))
}

server.listen(PORT, () => {
  console.log(`[orbit:mock-imap] serveur IMAP de QA prêt sur imaps://localhost:${PORT}`)
  console.log(`[orbit:mock-imap] identifiants : ${QA_USER} / ${QA_PASS}`)
  console.log(`[orbit:mock-imap] ${MESSAGES.length} messages dans INBOX`)
  console.log(`[orbit:mock-imap] certificat auto-signé : activer « Certificat auto-signé » dans le compte Orbit`)
})
