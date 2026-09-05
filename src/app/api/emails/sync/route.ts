// POST /api/emails/sync — Simulation de récupération IMAP
// (Phase 3 : brancher un vrai connecteur IMAP ici — l'API reste identique côté client)
import { NextResponse } from "next/server"
import { getSessionUser } from "@/lib/auth"
import { generateIncomingEmails } from "@/lib/demo"

export async function POST() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const count = await generateIncomingEmails(user.id, 2 + Math.floor(Math.random() * 2))
  return NextResponse.json({ ok: true, count })
}
