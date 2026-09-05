// GET /api/emails — Inbox
import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { toEmailDto } from "@/lib/dto"

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const emails = await db.emailLog.findMany({
    where: { userId: user.id },
    orderBy: { receivedAt: "desc" },
    take: 60,
  })

  return NextResponse.json({ emails: emails.map(toEmailDto) })
}
