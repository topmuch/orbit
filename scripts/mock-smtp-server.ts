// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Serveur SMTP de QA (mock) · port 2525 (plaintext, AUTH PLAIN/LOGIN)
// ───────────────────────────────────────────────────────────────────────────
// But : valider la chaîne d'ENVOI RÉELLE (nodemailer) en sandbox, sans serveur
// externe. Implémente le sous-ensemble SMTP suffisant :
//   EHLO (pipelining, AUTH PLAIN LOGIN, SIZE), HELO, AUTH PLAIN/LOGIN,
//   MAIL FROM, RCPT TO, DATA (terminaison <CRLF>.<CRLF>), NOOP, RSET, QUIT.
// Les messages reçus sont loggués (expéditeur/destinataires/taille/objet) —
// JAMAIS le contenu des trames AUTH (les mots de passe base64 ne sont pas
// loggués, uniquement comparés).
//
// Démarrage :  bun scripts/mock-smtp-server.ts
// Identifiants QA : qa@orbit.app / qa-smtp-pass
// Compte Orbit : SMTP 127.0.0.1:2525 · mode STARTTLS/587 décoché (TLS off)
// ═══════════════════════════════════════════════════════════════════════════

import * as net from "node:net"

const PORT = 2525
const QA_USER = "qa@orbit.app"
const QA_PASS = "qa-smtp-pass"

interface SmtpSession {
  socket: net.Socket
  buffer: string
  authenticated: boolean
  inData: boolean
  mailFrom: string | null
  recipients: string[]
  dataLines: string[]
  /** AUTH LOGIN : utilisateur décodé en attente du mot de passe. */
  authLoginStage: "user" | "pass" | null
  pendingAuthUser: string
}

const server = net.createServer((socket) => {
  const session: SmtpSession = {
    socket,
    buffer: "",
    authenticated: false,
    inData: false,
    mailFrom: null,
    recipients: [],
    dataLines: [],
    authLoginStage: null,
  }

  const write = (line: string) => socket.write(line.endsWith("\r\n") ? line : `${line}\r\n`)

  write("220 orbit-mock-smtp Orbit QA ready (ESMTP)")

  socket.on("data", (chunk: Buffer) => {
    session.buffer += chunk.toString("utf8")

    // Mode DATA : attendre la ligne point seule (fin de message)
    if (session.inData) {
      const endIdx = session.buffer.indexOf("\r\n.\r\n")
      if (endIdx !== -1) {
        const data = session.buffer.slice(0, endIdx)
        session.buffer = session.buffer.slice(endIdx + 5)
        handleEndData(session, data)
        // Potentielles commandes en attente derrière (pipelining)
        processBuffer(session, write)
      }
      return
    }

    processBuffer(session, write)
  })

  socket.on("error", () => {})
  socket.on("close", () => {})
})

function processBuffer(session: SmtpSession, write: (l: string) => void) {
  while (true) {
    const idx = session.buffer.indexOf("\r\n")
    if (idx === -1) return
    const line = session.buffer.slice(0, idx)
    session.buffer = session.buffer.slice(idx + 2)
    handleLine(session, line, write)
    if (session.inData) return // le reste part en mode données
  }
}

function handleLine(session: SmtpSession, line: string, write: (l: string) => void) {
  const trimmed = line.trim()
  if (!trimmed && !session.inData) return

  // ── AUTH LOGIN : étapes base64 utilisateur/mot de passe ──
  if (session.authLoginStage === "user") {
    session.pendingAuthUser = Buffer.from(trimmed, "base64").toString("utf8")
    session.authLoginStage = "pass"
    write("334 UGFzc3dvcmQ6") // "Password:"
    return
  }
  if (session.authLoginStage === "pass") {
    const pass = Buffer.from(trimmed, "base64").toString("utf8")
    session.authLoginStage = null
    if (session.pendingAuthUser === QA_USER && pass === QA_PASS) {
      session.authenticated = true
      write("235 Authentication successful")
    } else {
      write("535 Authentication credentials invalid")
    }
    return
  }

  const cmd = trimmed.split(/\s+/)[0].toUpperCase()
  const rest = trimmed.slice(cmd.length).trim()

  switch (cmd) {
    case "EHLO":
      write("250-orbit-mock-smtp greets you")
      write("250-PIPELINING")
      write("250-SIZE 26214400")
      write("250-AUTH PLAIN LOGIN")
      write("250 8BITMIME")
      break

    case "HELO":
      write("250 orbit-mock-smtp")
      break

    case "STARTTLS":
      // Pas de STARTTLS sur ce mock (QA plaintext) — annoncé ni dans EHLO
      write("454 TLS not available on this mock")
      break

    case "AUTH": {
      const method = rest.split(/\s+/)[0].toUpperCase()
      const arg = rest.slice(method.length).trim()
      if (method === "PLAIN") {
        try {
          const decoded = Buffer.from(arg, "base64").toString("utf8").split("\0")
          const user = decoded[1] ?? ""
          const pass = decoded[2] ?? ""
          if (user === QA_USER && pass === QA_PASS) {
            session.authenticated = true
            write("235 Authentication successful")
          } else {
            write("535 Authentication credentials invalid")
          }
        } catch {
          write("535 Authentication decode error")
        }
      } else if (method === "LOGIN") {
        session.authLoginStage = "user"
        session.pendingAuthUser = ""
        write("334 VXNlcm5hbWU6") // "Username:"
      } else {
        write("504 Unrecognized authentication type")
      }
      break
    }

    case "MAIL": {
      if (!session.authenticated) {
        write("530 Authentication required")
        break
      }
      const m = rest.match(/FROM:\s*<([^>]*)>/i)
      session.mailFrom = m?.[1] ?? ""
      session.recipients = []
      write("250 OK")
      break
    }

    case "RCPT": {
      const m = rest.match(/TO:\s*<([^>]*)>/i)
      if (m) {
        session.recipients.push(m[1])
        write("250 OK")
      } else {
        write("501 Bad recipient address syntax")
      }
      break
    }

    case "DATA": {
      if (!session.recipients.length) {
        write("554 No valid recipients")
        break
      }
      session.inData = true
      session.dataLines = []
      write("354 End data with <CR><LF>.<CR><LF>")
      break
    }

    case "NOOP":
      write("250 OK")
      break

    case "RSET":
      session.mailFrom = null
      session.recipients = []
      write("250 OK")
      break

    case "QUIT":
      write("221 orbit-mock-smtp closing connection")
      session.socket.end()
      break

    default:
      write(`502 Command not implemented (${cmd})`)
  }
}

// (fin des commandes)
function handleEndData(session: SmtpSession, data: string) {
  session.inData = false
  const size = Buffer.byteLength(data, "utf8")
  // Objet = première ligne Subject: (jamais le corps complet en log)
  const subject =
    data
      .split("\r\n")
      .find((l) => /^subject:/i.test(l))
      ?.slice(8)
      .trim() ?? "(sans objet)"
  console.log(
    `[orbit:mock-smtp] MESSAGE — from: ${session.mailFrom} → to: [${session.recipients.join(", ")}] · ${size} octets · « ${subject} »`
  )
  session.dataLines = []
  session.socket.write("250 OK: queued as QA-" + Math.random().toString(36).slice(2, 10).toUpperCase() + "\r\n")
}

server.listen(PORT, () => {
  console.log(`[orbit:mock-smtp] serveur SMTP de QA prêt sur localhost:${PORT}`)
  console.log(`[orbit:mock-smtp] identifiants : ${QA_USER} / ${QA_PASS}`)
  console.log(`[orbit:mock-smtp] plaintext (pas de STARTTLS) — TLS: false, port 2525 dans le compte Orbit`)
})
