// POST /api/ai/chat — Assistant Orbit (streaming)
// ───────────────────────────────────────────────────────────────────────────
// Le prompt système est enrichi du contexte réel de l'utilisateur (agenda +
// tâches), puis la génération est déléguée au micro-service IA
// (src/lib/ai-provider.ts : Ollama local → fallback SDK), qui renvoie déjà
// un flux texte brut. En production, brancher Ollama ne demande AUCUN
// changement ici : le micro-service route tout seul.
import { NextRequest, NextResponse } from "next/server"
import { addDays, format } from "date-fns"
import { fr } from "date-fns/locale"
import { db } from "@/lib/db"
import { getSessionUser } from "@/lib/auth"
import { chatSchema } from "@/lib/validators"
import { chatCompletionStream } from "@/lib/ai-provider"

export const runtime = "nodejs"
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const user = await getSessionUser()
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 })

  const parsed = chatSchema.safeParse(await req.json())
  if (!parsed.success) {
    return NextResponse.json({ error: "Données invalides" }, { status: 400 })
  }

  const messages = parsed.data.messages

  // ---- Contexte utilisateur (agenda 7 jours + tâches en cours) ----
  const now = new Date()
  const [events, tasks] = await Promise.all([
    db.event.findMany({
      where: {
        userId: user.id,
        startTime: { gte: addDays(now, -1), lte: addDays(now, 7) },
      },
      orderBy: { startTime: "asc" },
      take: 30,
    }),
    db.task.findMany({
      where: { userId: user.id, status: { not: "done" } },
      orderBy: [{ priority: "desc" }, { dueDate: "asc" }],
      take: 15,
    }),
  ])

  const agenda = events
    .map(
      (e) =>
        `- ${format(e.startTime, "EEE d MMM", { locale: fr })} ${format(e.startTime, "HH:mm")}–${format(e.endTime, "HH:mm")} : ${e.title}`
    )
    .join("\n")

  const taches = tasks
    .map(
      (t) =>
        `- [${t.status === "todo" ? "à faire" : "en cours"}] ${t.title}${t.dueDate ? ` (échéance ${format(t.dueDate, "EEE d MMM HH:mm", { locale: fr })})` : ""}`
    )
    .join("\n")

  const systemPrompt = [
    "Tu es Orbit, l'assistant personnel intelligent intégré à l'application éponyme.",
    "Tu aides l'utilisateur à organiser sa vie professionnelle et personnelle.",
    "Réponds toujours en français, de façon concise, structurée et actionnable.",
    "Tu connais l'agenda et les tâches de l'utilisateur : appuie-toi dessus pour tes réponses.",
    "Quand c'est pertinent, propose des créneaux concrets en évitant les conflits avec l'agenda existant.",
    "",
    `Date et heure actuelles : ${format(now, "EEEE d MMMM yyyy 'à' HH:mm", { locale: fr })}.`,
    "",
    "AGENDA (de hier à dans 7 jours) :",
    agenda || "(aucun événement)",
    "",
    "TÂCHES EN COURS :",
    taches || "(aucune tâche)",
  ].join("\n")

  try {
    // Délégation au micro-service IA (garde les 12 derniers messages pour
    // limiter le contexte).
    const stream = await chatCompletionStream(systemPrompt, messages.slice(-12))
    if (!stream) {
      return NextResponse.json({ error: "Réponse IA indisponible" }, { status: 502 })
    }

    return new Response(stream, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    })
  } catch (error) {
    console.error("[orbit:ai-chat]", error)
    return NextResponse.json(
      { error: "L'assistant est momentanément indisponible" },
      { status: 502 }
    )
  }
}
