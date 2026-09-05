// GET/POST /api/tasks — Liste + création
import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { toTaskDto } from "@/lib/dto"
import { taskCreateSchema } from "@/lib/validators"

export async function GET() {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const tasks = await db.task.findMany({
    where: { userId: user.id },
    orderBy: [{ createdAt: "desc" }],
    take: 300,
  })

  return NextResponse.json({ tasks: tasks.map(toTaskDto) })
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const parsed = taskCreateSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Données invalides" },
      { status: 400 }
    )
  }
  const data = parsed.data

  const task = await db.task.create({
    data: {
      userId: user.id,
      title: data.title,
      description: data.description || null,
      status: data.status ?? "todo",
      priority: data.priority ?? 1,
      dueDate: data.dueDate ? new Date(data.dueDate) : null,
    },
  })

  return NextResponse.json({ task: toTaskDto(task) }, { status: 201 })
}
