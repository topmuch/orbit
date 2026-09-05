// POST /api/auth/demo — Connexion instantanée au compte de démonstration
import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { setSessionCookie } from "@/lib/auth"
import { ensureDemoUser } from "@/lib/demo"

export async function POST() {
  try {
    const userId = await ensureDemoUser()
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true },
    })
    if (!user) return NextResponse.json({ error: "Erreur démo" }, { status: 500 })
    await setSessionCookie(user.id)
    return NextResponse.json({ user })
  } catch {
    return NextResponse.json({ error: "Erreur serveur" }, { status: 500 })
  }
}
