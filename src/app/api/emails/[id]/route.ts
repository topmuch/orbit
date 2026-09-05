// PATCH/DELETE /api/emails/[id] — Marquer lu/traité, suppression
import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { toEmailDto } from "@/lib/dto"
import { emailPatchSchema } from "@/lib/validators"

type Params = { params: Promise<{ id: string }> }

export async function PATCH(req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  const { id } = await params

  const existing = await db.emailLog.findFirst({ where: { id, userId: user.id } })
  if (!existing) return NextResponse.json({ error: "Email introuvable" }, { status: 404 })

  const parsed = emailPatchSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: "Données invalides" }, { status: 400 })
  }

  // Traiter un email (événement créé OU suggestion ignorée) efface la suggestion
  // pour éviter toute double action sur la carte IA.
  const clearSuggestion =
    parsed.data.isProcessed === true ? { suggestedEvent: Prisma.DbNull } : {}

  const email = await db.emailLog.update({
    where: { id },
    data: {
      ...(parsed.data.isRead !== undefined ? { isRead: parsed.data.isRead } : {}),
      ...(parsed.data.isProcessed !== undefined
        ? { isProcessed: parsed.data.isProcessed }
        : {}),
      ...clearSuggestion,
    },
  })

  return NextResponse.json({ email: toEmailDto(email) })
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })
  const { id } = await params

  const existing = await db.emailLog.findFirst({ where: { id, userId: user.id } })
  if (!existing) return NextResponse.json({ error: "Email introuvable" }, { status: 404 })

  await db.emailLog.delete({ where: { id } })
  return NextResponse.json({ ok: true })
}
