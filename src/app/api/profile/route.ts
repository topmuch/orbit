// PATCH /api/profile — Mise à jour du profil (nom, fuseau horaire d'affichage)
import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { isValidTimezone } from "@/lib/timezone"

const profileSchema = z
  .object({
    name: z.string().trim().min(2, "Nom trop court").max(60).optional(),
    timezone: z
      .string()
      .max(64)
      .refine(isValidTimezone, "Fuseau horaire invalide (format IANA)")
      .optional(),
  })
  .refine((d) => d.name !== undefined || d.timezone !== undefined, {
    message: "Rien à mettre à jour",
  })

export async function PATCH(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const parsed = profileSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }
  const data = parsed.data

  const updated = await db.user.update({
    where: { id: user.id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
    },
    select: { id: true, email: true, name: true, timezone: true },
  })

  return NextResponse.json({ user: updated })
}
