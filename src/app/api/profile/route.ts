// PATCH /api/profile — Mise à jour du profil
import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"

const profileSchema = z.object({
  name: z.string().trim().min(2, "Nom trop court").max(60),
})

export async function PATCH(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const parsed = profileSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }

  const updated = await db.user.update({
    where: { id: user.id },
    data: { name: parsed.data.name },
    select: { id: true, email: true, name: true },
  })

  return NextResponse.json({ user: updated })
}
