// GET/PATCH/DELETE /api/emails/[id] — Détail, actions, suppression définitive
// ─────────────────────────────────────────────────────────────────────────────
// GET    : email complet (bodyHtml nettoyé + pièces jointes + compte d'origine),
//          marqué LU automatiquement à l'ouverture (comme Gmail/Outlook) et
//          drapeau \Seen propagé au serveur IMAP (best-effort, silencieux).
// PATCH  : isRead / isStarred / folder / isProcessed — les changements d'état
//          lu/étoilé propagent \Seen/\Flagged côté IMAP (best-effort).
// DELETE : suppression DÉFINITIVE locale (fichiers joints compris). La corbeille
//          (dossier TRASH) est le chemin soft-delete ; DELETE est l'alternative
//          « effacer pour de vrai ».

import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { toEmailDto } from "@/lib/dto"
import { emailPatchSchema } from "@/lib/validators"
import { setEmailImapFlags } from "@/lib/imap"
import { recordTombstone } from "@/lib/sync-tombstones"
import { deleteEmailAttachments } from "@/lib/attachments"

export const runtime = "nodejs"

type Params = { params: Promise<{ id: string }> }

/** Propage \Seen/\Flagged au serveur IMAP (fire-and-forget, silencieux). */
function pushImapFlags(
  email: { accountId: string | null; uid: number | null },
  opts: { seen?: boolean; starred?: boolean }
): void {
  if (!email.accountId || email.uid == null) return
  void (async () => {
    const account = await db.emailAccount
      .findFirst({ where: { id: email.accountId! }, select: undefined })
      .catch(() => null)
    if (!account) return
    await setEmailImapFlags(account, [email.uid!], opts).catch(() => false)
  })()
}

export async function GET(_req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  const { id } = await params

  const email = await db.emailLog.findFirst({
    where: { id, userId: user.id },
    include: {
      account: { select: { address: true, label: true } },
      attachments: { orderBy: { createdAt: "asc" } },
    },
  })
  if (!email) return NextResponse.json({ error: "Email introuvable" }, { status: 404 })

  // Ouverture = lu (convention clients mail) + propagation serveur
  if (!email.isRead) {
    await db.emailLog.update({ where: { id: email.id }, data: { isRead: true } })
    email.isRead = true
    pushImapFlags(email, { seen: true })
  }

  // Images inline (cid:) → URL d'attachment signée par la session
  let bodyHtml = email.bodyHtml
  if (bodyHtml) {
    for (const att of email.attachments) {
      if (!att.contentId || !att.isInline) continue
      const inlineUrl = `/api/emails/attachments/${att.id}?inline=1`
      const cidPattern = new RegExp(
        `(src=["']cid:${att.contentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'])`,
        "gi"
      )
      bodyHtml = bodyHtml.replace(cidPattern, `src="${inlineUrl}"`)
    }
  }

  return NextResponse.json({ email: toEmailDto({ ...email, bodyHtml }, { detail: true }) })
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  const { id } = await params

  const existing = await db.emailLog.findFirst({ where: { id, userId: user.id } })
  if (!existing) return NextResponse.json({ error: "Email introuvable" }, { status: 404 })

  const parsed = emailPatchSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: "Données invalides" }, { status: 400 })
  }
  const input = parsed.data

  // Traiter un email (événement créé OU suggestion ignorée) efface la suggestion
  // pour éviter toute double action sur la carte IA.
  const clearSuggestion =
    input.isProcessed === true ? { suggestedEvent: Prisma.DbNull } : undefined

  const email = await db.emailLog.update({
    where: { id },
    data: {
      ...(input.isRead !== undefined ? { isRead: input.isRead } : {}),
      ...(input.isStarred !== undefined ? { isStarred: input.isStarred } : {}),
      ...(input.folder !== undefined ? { folder: input.folder } : {}),
      ...(input.isProcessed !== undefined ? { isProcessed: input.isProcessed } : {}),
      ...(clearSuggestion ? clearSuggestion : {}),
    },
    include: { account: { select: { address: true, label: true } } },
  })

  // Propagation IMAP best-effort (jamais bloquante, jamais en erreur)
  if (input.isRead !== undefined) pushImapFlags(email, { seen: input.isRead })
  if (input.isStarred !== undefined) pushImapFlags(email, { starred: input.isStarred })

  return NextResponse.json({ email: toEmailDto(email) })
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  const { id } = await params

  const existing = await db.emailLog.findFirst({ where: { id, userId: user.id } })
  if (!existing) return NextResponse.json({ error: "Email introuvable" }, { status: 404 })

  await db.emailLog.delete({ where: { id } })
  // Fichiers joints retirés du disque (métadonnées en cascade SQL)
  await deleteEmailAttachments(id)
  // Tombstone : propagation de la suppression aux caches offline (multi-appareils)
  await recordTombstone(user.id, "email", id)

  return NextResponse.json({ ok: true })
}
