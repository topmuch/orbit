// GET/PUT /api/notifications/preferences — Préférences de notifications
// ───────────────────────────────────────────────────────────────────────────
// GET → { preferences } (créées à la volée avec les défauts si absentes)
// PUT → { preferences } mise à jour partielle (upsert, Zod validé)
import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { notificationPreferencesSchema } from "@/lib/validators"
import { toNotificationPreferenceDto } from "@/lib/dto"

export const runtime = "nodejs"

async function getOrCreate(userId: string) {
  const existing = await db.notificationPreference.findUnique({ where: { userId } })
  if (existing) return existing
  return db.notificationPreference.create({ data: { userId } })
}

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const pref = await getOrCreate(user.id)
  return NextResponse.json({ preferences: toNotificationPreferenceDto(pref) })
}

export async function PUT(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const parsed = notificationPreferencesSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: "Données invalides" }, { status: 400 })
  }
  const input = parsed.data

  // Heures calmes : "" → null (désélection) ; cohérence des deux bornes
  // (une seule remplie → on complète avec les défauts 22:00/08:00).
  let quietStart: string | null | undefined = input.quietHoursStart
  let quietEnd: string | null | undefined = input.quietHoursEnd
  if (input.quietHoursEnabled) {
    if (quietStart === "" && quietEnd === "") {
      quietStart = null
      quietEnd = null
    } else {
      if (quietStart === "") quietStart = "22:00"
      if (quietEnd === "") quietEnd = "08:00"
    }
  }

  // Type explicite : Prisma accepte string | null pour les heures calmes
  const data: {
    eventReminder?: boolean
    taskDeadline?: boolean
    importantEmail?: boolean
    aiSuggestion?: boolean
    eventReminderTime?: number
    quietHoursEnabled?: boolean
    quietHoursStart?: string | null
    quietHoursEnd?: string | null
  } = {
    ...(input.eventReminder !== undefined ? { eventReminder: input.eventReminder } : {}),
    ...(input.taskDeadline !== undefined ? { taskDeadline: input.taskDeadline } : {}),
    ...(input.importantEmail !== undefined ? { importantEmail: input.importantEmail } : {}),
    ...(input.aiSuggestion !== undefined ? { aiSuggestion: input.aiSuggestion } : {}),
    ...(input.eventReminderTime !== undefined ? { eventReminderTime: input.eventReminderTime } : {}),
    ...(input.quietHoursEnabled !== undefined ? { quietHoursEnabled: input.quietHoursEnabled } : {}),
    ...(quietStart !== undefined ? { quietHoursStart: quietStart || null } : {}),
    ...(quietEnd !== undefined ? { quietHoursEnd: quietEnd || null } : {}),
  }

  const pref = await db.notificationPreference.upsert({
    where: { userId: user.id },
    update: data,
    create: { userId: user.id, ...data },
  })

  return NextResponse.json({ preferences: toNotificationPreferenceDto(pref) })
}
