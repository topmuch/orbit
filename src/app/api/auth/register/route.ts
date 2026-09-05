// POST /api/auth/register — Inscription
import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { hashPassword, setSessionCookie } from "@/lib/auth"
import { registerSchema } from "@/lib/validators"

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const parsed = registerSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Données invalides" },
        { status: 400 }
      )
    }
    const { name, email, password } = parsed.data

    const existing = await db.user.findUnique({ where: { email } })
    if (existing) {
      return NextResponse.json(
        { error: "Un compte existe déjà avec cet email" },
        { status: 409 }
      )
    }

    const user = await db.user.create({
      data: { email, name: name || null, passwordHash: hashPassword(password) },
      select: { id: true, email: true, name: true },
    })

    await setSessionCookie(user.id)
    return NextResponse.json({ user }, { status: 201 })
  } catch {
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 })
  }
}
