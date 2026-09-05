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
import { loadExpandedEvents } from "@/lib/events-service"
import { formatInTz } from "@/lib/timezone"

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
  // Agenda expansé : les occurrences de séries récurrentes sont incluses,
  // chaque événement est présenté dans SON fuseau de référence.
  const now = new Date()
  const [events, tasks] = await Promise.all([
    loadExpandedEvents(user.id, addDays(now, -1), addDays(now, 7)).then((list) =>
      list.slice(0, 30)
    ),
    db.task.findMany({
      // Tâches actives (archivées exclues) — priorité triée en mémoire
      // (String LOW/MEDIUM/HIGH/URGENT : l'ordre alphabétique SQL est faux)
      where: { userId: user.id, status: { notIn: ["done", "archived"] } },
      take: 15,
    }),
  ])

  // Tri : URGENT d'abord, puis échéance la plus proche
  tasks.sort((a, b) => {
    const W = { LOW: 0, MEDIUM: 1, HIGH: 2, URGENT: 3 } as Record<string, number>
    const w = (W[b.priority] ?? 1) - (W[a.priority] ?? 1)
    if (w !== 0) return w
    const aDue = a.dueDate ? a.dueDate.getTime() : Infinity
    const bDue = b.dueDate ? b.dueDate.getTime() : Infinity
    return aDue - bDue
  })

  const agenda = events
    .map((e) => {
      const start = new Date(e.startTime)
      const end = new Date(e.endTime)
      const day = formatInTz(start, e.timezone, { weekday: "short", day: "numeric", month: "short" })
      const hours = e.allDay
        ? "journée entière"
        : `${formatInTz(start, e.timezone, { hour: "2-digit", minute: "2-digit" })}–${formatInTz(end, e.timezone, { hour: "2-digit", minute: "2-digit" })}`
      const tag = e.isOccurrence ? " (récurent)" : ""
      return `- ${day} ${hours}${tag} : ${e.title}`
    })
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
