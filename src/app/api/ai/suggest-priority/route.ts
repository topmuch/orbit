// POST /api/ai/suggest-priority — Suggestion IA de priorité pour une tâche
// ───────────────────────────────────────────────────────────────────────────
// Chaîne complète : auth → rate limit (10/min) → Zod → contexte DB (tâche +
// charge de travail réelle de l'utilisateur) → micro-service IA → bornes →
// persistance (aiSuggestedPriority/aiConfidence) en mode édition.
//
// Deux modes :
//   { taskId }              → tâche existante (ownership vérifié), suggestion
//                             PERSISTÉE jusqu'à application/refus ;
//   { title, description? } → tâche en cours de création, suggestion jetable
//                             (aucune persistance — la tâche n'existe pas).
import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { suggestPrioritySchema } from "@/lib/validators"
import { rateLimit, tooManyRequests } from "@/lib/rate-limit"
import { getLastAiProvider, suggestTaskPriority } from "@/lib/ai-provider"

export const runtime = "nodejs"
export const maxDuration = 60

/** Limite anti-abus : 10 suggestions par minute et par utilisateur. */
const RATE_LIMIT_MAX = 10

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const rl = rateLimit(`ai:suggest:${user.id}`, RATE_LIMIT_MAX, 60_000)
  if (!rl.ok) return tooManyRequests(rl)

  const parsed = suggestPrioritySchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: "Données invalides" }, { status: 400 })
  }
  const { taskId, title, description, dueDate } = parsed.data

  // ── Tâche existante (ownership) OU entrée libre (création) ───────────────
  const task = taskId
    ? await db.task.findFirst({ where: { id: taskId, userId: user.id } })
    : null
  if (taskId && !task) {
    return NextResponse.json({ error: "Tâche introuvable" }, { status: 404 })
  }

  // ── Contexte de charge réel de l'utilisateur ─────────────────────────────
  const now = new Date()
  const [totalTasks, urgentTasks, overdueTasks] = await Promise.all([
    db.task.count({ where: { userId: user.id, status: { notIn: ["done", "archived"] } } }),
    db.task.count({
      where: { userId: user.id, status: { notIn: ["done", "archived"] }, priority: "URGENT" },
    }),
    db.task.count({
      where: {
        userId: user.id,
        status: { notIn: ["done", "archived"] },
        dueDate: { lt: now },
      },
    }),
  ])

  // ── Inférence (micro-service IA → fallback SDK) ─────────────────────────
  const suggestion = await suggestTaskPriority({
    title: task?.title ?? title ?? "",
    description: task?.description ?? description ?? null,
    dueDate: task?.dueDate?.toISOString() ?? dueDate ?? null,
    userContext: { totalTasks, urgentTasks, overdueTasks },
  })

  if (!suggestion) {
    console.error(`[orbit:ai-suggest] provider=${getLastAiProvider()} → aucune suggestion exploitable`)
    return NextResponse.json(
      { error: "Le moteur IA n'a pas pu suggérer de priorité pour cette tâche" },
      { status: 502 }
    )
  }

  // ── Persistance (mode édition uniquement) ────────────────────────────────
  let persisted = false
  if (task) {
    await db.task.update({
      where: { id: task.id },
      data: {
        aiSuggestedPriority: suggestion.priority,
        aiConfidence: suggestion.confidence,
      },
    })
    persisted = true
  }

  console.log(
    `[orbit:ai-suggest] provider=${getLastAiProvider()} → ${suggestion.priority} (${Math.round(suggestion.confidence * 100)} %)${persisted ? " [persisté]" : " [jetable]"}`
  )

  return NextResponse.json({
    suggestion: {
      priority: suggestion.priority,
      confidence: suggestion.confidence,
      reasoning: suggestion.reasoning,
      persisted,
    },
  })
}
