// GET /api/emails — Boîte Orbit : liste filtrée + compteurs + comptes
// ─────────────────────────────────────────────────────────────────────────────
// Paramètres (tous optionnels — sans paramètre : compatibilité historique,
// tous dossiers confondus, 60 derniers) :
//   folder    INBOX | SENT | ARCHIVE | TRASH | STARRED | ALL (défaut ALL)
//   q         recherche sujet / expéditeur / corps (contains, insensible à la casse ASCII)
//   accountId limite à un compte IMAP précis
//   unread    "true" → uniquement les non lus
//   starred   "true" → uniquement les étoilés
//   page/limit pagination (défaut 25 en mode filtré, 60 en mode ALL)
//   sort      recent (défaut) | oldest
//
// Réponse : { emails, total, page, limit, counts, accounts } — les compteurs
// (dossiers + non lus par compte) alimentent la sidebar et les badges.
// Le payload liste est ALLÉGÉ : bodyHtml et pièces jointes ne sont renvoyés
// que par la route détail GET /api/emails/[id].

import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { toEmailDto } from "@/lib/dto"
import type { Prisma } from "@prisma/client"

export const runtime = "nodejs"

const FOLDERS = ["INBOX", "SENT", "ARCHIVE", "TRASH"] as const

export async function GET(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const sp = req.nextUrl.searchParams
  const folderParam = (sp.get("folder") ?? "ALL").toUpperCase()
  const folder =
    folderParam === "INBOX" ||
    folderParam === "SENT" ||
    folderParam === "ARCHIVE" ||
    folderParam === "TRASH" ||
    folderParam === "STARRED"
      ? folderParam
      : "ALL"
  const isFilteredMode = folder !== "ALL"

  const q = (sp.get("q") ?? "").trim().slice(0, 120)
  const accountId = sp.get("accountId")?.trim() || null
  const unread = sp.get("unread") === "true"
  const starred = sp.get("starred") === "true"
  const sort = sp.get("sort") === "oldest" ? "oldest" : "recent"
  const limit = Math.min(Math.max(Number(sp.get("limit")) || (isFilteredMode ? 25 : 60), 1), 100)
  const page = Math.min(Math.max(Number(sp.get("page")) || 1, 1), 200)

  // ── Filtre principal ───────────────────────────────────────────────────────
  const where: Prisma.EmailLogWhereInput = { userId: user.id }

  if (folder === "STARRED") {
    // Étoilés = suivi, tous dossiers sauf corbeille (convention Gmail)
    where.isStarred = true
    where.folder = { not: "TRASH" }
  } else if (folder !== "ALL") {
    where.folder = folder
  }
  if (accountId) where.accountId = accountId
  if (unread) where.isRead = false
  if (starred) where.isStarred = true
  if (q) {
    where.OR = [
      { subject: { contains: q } },
      { fromAddress: { contains: q } },
      { fromName: { contains: q } },
      { bodyText: { contains: q } },
    ]
  }

  const [emails, total, folderCounts, unreadCount, starredCount, accounts, unreadByAccount] =
    await Promise.all([
      db.emailLog.findMany({
        where,
        orderBy: { receivedAt: sort === "recent" ? "desc" : "asc" },
        skip: (page - 1) * limit,
        take: limit,
        include: { account: { select: { address: true, label: true } } },
      }),
      db.emailLog.count({ where }),
      // Compteurs sidebar (portée utilisateur, SANS les filtres courants)
      db.emailLog.groupBy({
        by: ["folder"],
        where: { userId: user.id },
        _count: { _all: true },
      }),
      db.emailLog.count({ where: { userId: user.id, folder: "INBOX", isRead: false } }),
      db.emailLog.count({ where: { userId: user.id, isStarred: true, folder: { not: "TRASH" } } }),
      db.emailAccount.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" },
        select: { id: true, address: true, label: true, smtpHost: true },
      }),
      db.emailLog.groupBy({
        by: ["accountId"],
        where: { userId: user.id, folder: "INBOX", isRead: false },
        _count: { _all: true },
      }),
    ])

  const countByFolder = new Map(folderCounts.map((g) => [g.folder, g._count._all]))
  const unreadMap = new Map(unreadByAccount.map((g) => [g.accountId, g._count._all]))

  return NextResponse.json({
    emails: emails.map((e) => toEmailDto(e)),
    total,
    page,
    limit,
    counts: {
      inbox: countByFolder.get("INBOX") ?? 0,
      inboxUnread: unreadCount,
      starred: starredCount,
      sent: countByFolder.get("SENT") ?? 0,
      archive: countByFolder.get("ARCHIVE") ?? 0,
      trash: countByFolder.get("TRASH") ?? 0,
      unread: unreadCount,
      all: FOLDERS.reduce((sum, f) => sum + (countByFolder.get(f) ?? 0), 0),
    },
    accounts: accounts.map((a) => ({
      id: a.id,
      address: a.address,
      label: a.label,
      unread: unreadMap.get(a.id) ?? 0,
      canSend: Boolean(a.smtpHost),
    })),
  })
}
