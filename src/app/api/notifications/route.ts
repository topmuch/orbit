// GET /api/notifications — Historique des notifications de l'utilisateur
// ───────────────────────────────────────────────────────────────────────────
// Query : ?limit=50 (max 100) &unreadOnly=true
// Réponse : { notifications: NotificationDto[], unreadCount }
// Les données internes (data JSON) sont filtrées : seuls view + ids
// indispensables au deep link sont exposés (jamais de contenu arbitraire).
import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { toNotificationDto } from "@/lib/dto"

export const runtime = "nodejs"

export async function GET(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const limit = Math.min(100, Math.max(1, Number(searchParams.get("limit") ?? 50) || 50))
  const unreadOnly = searchParams.get("unreadOnly") === "true"

  const [notifications, unreadCount] = await Promise.all([
    db.notification.findMany({
      where: { userId: user.id, ...(unreadOnly ? { isRead: false } : {}) },
      orderBy: { createdAt: "desc" },
      take: limit,
    }),
    db.notification.count({ where: { userId: user.id, isRead: false } }),
  ])

  return NextResponse.json({
    notifications: notifications.map(toNotificationDto),
    unreadCount,
  })
}
