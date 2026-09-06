// PATCH /api/emails/bulk — Actions groupées (sélection multiple)
// ─────────────────────────────────────────────────────────────────────────────
// Actions : read | unread | star | unstar | archive | trash | restore | delete
// • Ownership garanti par le filtre userId (updateMany) — jamais de ids d'autrui ;
// • delete = suppression DÉFINITIVE (fichiers joints compris) — le soft-delete
//   passe par trash ;
// • read/unread/star/unstar propagent les drapeaux IMAP (best-effort, silencieux
//   — l'état local prime, la sync suivante réaligne le serveur).

import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { emailBulkActionSchema } from "@/lib/validators"
import { setEmailImapFlags, imapTargets } from "@/lib/imap"
import { deleteEmailAttachments } from "@/lib/attachments"

export const runtime = "nodejs"

export async function PATCH(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const rl = rateLimit(`emails:bulk:${user.id}`, 30, 60_000)
  if (!rl.ok) return tooManyRequests(rl)

  const parsed = emailBulkActionSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }
  const { ids, action } = parsed.data

  // Emails possédés (relecture : propriété + infos IMAP pour les drapeaux)
  const owned = await db.emailLog.findMany({
    where: { id: { in: ids }, userId: user.id },
    select: { id: true, accountId: true, uid: true },
  })
  if (!owned.length)
    return NextResponse.json({ error: "Aucun email correspondant" }, { status: 404 })
  const ownedIds = owned.map((e) => e.id)

  let updated = 0

  switch (action) {
    case "read":
    case "unread": {
      const isRead = action === "read"
      const res = await db.emailLog.updateMany({
        where: { id: { in: ownedIds }, userId: user.id },
        data: { isRead },
      })
      updated = res.count
      void pushFlagsBulk(owned, { seen: isRead })
      break
    }
    case "star":
    case "unstar": {
      const isStarred = action === "star"
      const res = await db.emailLog.updateMany({
        where: { id: { in: ownedIds }, userId: user.id },
        data: { isStarred },
      })
      updated = res.count
      void pushFlagsBulk(owned, { starred: isStarred })
      break
    }
    case "archive":
      updated = (
        await db.emailLog.updateMany({
          where: { id: { in: ownedIds }, userId: user.id },
          data: { folder: "ARCHIVE" },
        })
      ).count
      break
    case "trash":
      updated = (
        await db.emailLog.updateMany({
          where: { id: { in: ownedIds }, userId: user.id },
          data: { folder: "TRASH" },
        })
      ).count
      break
    case "restore":
      updated = (
        await db.emailLog.updateMany({
          where: { id: { in: ownedIds }, userId: user.id },
          data: { folder: "INBOX" },
        })
      ).count
      break
    case "delete": {
      // Suppression définitive : emails (cascade métadonnées PJ) puis fichiers
      const res = await db.emailLog.deleteMany({
        where: { id: { in: ownedIds }, userId: user.id },
      })
      updated = res.count
      for (const id of ownedIds) await deleteEmailAttachments(id)
      break
    }
  }

  return NextResponse.json({ updated })
}

/** Propagation IMAP groupée par compte (fire-and-forget, ≤ 5 comptes). */
async function pushFlagsBulk(
  emails: Array<{ accountId: string | null; uid: number | null }>,
  opts: { seen?: boolean; starred?: boolean }
): Promise<void> {
  const targets = imapTargets(emails).slice(0, 5)
  for (const target of targets) {
    const account = await db.emailAccount
      .findFirst({ where: { id: target.accountId } })
      .catch(() => null)
    if (!account) continue
    await setEmailImapFlags(account, target.uids, opts).catch(() => false)
  }
}
