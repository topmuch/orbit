// GET /api/emails/attachments/[id] — Servir une pièce jointe (fichier disque)
// ─────────────────────────────────────────────────────────────────────────────
// • Auth session + propriété vérifiée (l'email appartient à l'utilisateur) ;
// • ?inline=1 → rendu dans le corps (Content-Disposition: inline, images cid:) ;
//   sinon téléchargement (attachment) ;
// • chemin contrôlé par lib/attachments (anti-traversal) ;
// • nosniff activé : jamais d'exécution de contenu servi comme HTML.

import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { readAttachmentFile } from "@/lib/attachments"

export const runtime = "nodejs"

type Params = { params: Promise<{ id: string }> }

/** Types sûrs en rendu inline (le reste est toujours téléchargé). */
const INLINE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml", // assaini par le navigateur en <img> — jamais exécuté
  "image/bmp",
  "text/plain",
  "application/pdf",
])

export async function GET(req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const { id } = await params

  const attachment = await db.emailAttachment.findFirst({
    where: { id, email: { userId: user.id } },
  })
  if (!attachment) return NextResponse.json({ error: "Pièce jointe introuvable" }, { status: 404 })

  const file = await readAttachmentFile(attachment.storagePath)
  if (!file) {
    // Fichier absent (nettoyage disque / restauration) : la métadonnée reste
    return NextResponse.json(
      { error: "Fichier introuvable sur le disque (nettoyé ou restauré)" },
      { status: 410 }
    )
  }

  const wantsInline = req.nextUrl.searchParams.get("inline") === "1"
  const contentType = attachment.contentType || "application/octet-stream"
  const safeType = INLINE_TYPES.has(contentType) && wantsInline ? contentType : "application/octet-stream"
  const disposition = safeType === "application/octet-stream" || !wantsInline ? "attachment" : "inline"
  // Nom de fichier : encodage RFC 5987 (accents français préservés)
  const encodedName = encodeURIComponent(attachment.filename)

  return new NextResponse(new Uint8Array(file), {
    headers: {
      "Content-Type": safeType,
      "Content-Length": String(file.length),
      "Content-Disposition": `${disposition}; filename*=UTF-8''${encodedName}`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, max-age=3600",
    },
  })
}
