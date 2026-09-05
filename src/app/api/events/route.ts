// GET/POST /api/events — Liste (avec plage optionnelle) + création
import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { toEventDto } from "@/lib/dto"
import { eventCreateSchema } from "@/lib/validators"

export async function GET(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const { searchParams } = new URL(req.url)
  const from = searchParams.get("from")
  const to = searchParams.get("to")

  const events = await db.event.findMany({
    where: {
      userId: user.id,
      ...(from || to
        ? {
            startTime: {
              ...(from ? { gte: new Date(from) } : {}),
              ...(to ? { lte: new Date(to) } : {}),
            },
          }
        : {}),
    },
    orderBy: { startTime: "asc" },
    take: 500,
  })

  return NextResponse.json({ events: events.map(toEventDto) })
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const parsed = eventCreateSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }
  const data = parsed.data

  if (new Date(data.endTime) <= new Date(data.startTime)) {
    return NextResponse.json(
      { error: "L'heure de fin doit être après l'heure de début" },
      { status: 400 }
    )
  }

  const event = await db.event.create({
    data: {
      userId: user.id,
      title: data.title,
      description: data.description || null,
      startTime: new Date(data.startTime),
      endTime: new Date(data.endTime),
      source: data.source ?? "manual",
    },
  })

  return NextResponse.json({ event: toEventDto(event) }, { status: 201 })
}
