// POST /api/auth/logout — Déconnexion
import { NextResponse } from "next/server"
import { clearSessionCookie } from "@/lib/auth"

export async function POST() {
  await clearSessionCookie()
  return NextResponse.json({ ok: true })
}
