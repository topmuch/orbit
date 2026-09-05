// Orbit — Seed de tâches de démonstration (10+ tâches riches)
// ─────────────────────────────────────────────────────────────────────────────
// Usage : bun run scripts/seed-demo-tasks.mts [email]
//
// Remplace les tâches de l'utilisateur (par défaut le compte démo) par un jeu
// de données complet : statuts todo/doing/done + 1 archivée, priorités LOW →
// URGENT, échéances relatives (en retard / aujourd'hui / demain / sans date),
// tags colorés, sous-tâches, une suggestion IA (placeholder Phase 4) et un
// lien vers un événement existant du calendrier.
//
// Les tags existants sont upsertés (aucun doublon userId+name).

import { PrismaClient } from "@prisma/client"
import { addDays, setHours, setMinutes, subDays, subHours } from "date-fns"

const db = new PrismaClient()

const email = process.argv[2] ?? "demo@orbit.app"

function at(base: Date, hour: number, minute: number): Date {
  return setMinutes(setHours(base, hour), minute)
}

async function main() {
  const user = await db.user.findUnique({ where: { email } })
  if (!user) {
    console.error(`Utilisateur introuvable : ${email}`)
    process.exit(1)
  }

  // Purge des tâches existantes (données legacy priorités Int invalides)
  const deleted = await db.task.deleteMany({ where: { userId: user.id } })
  console.log(`Tâches supprimées : ${deleted.count}`)

  // ── Tags (upsert) ────────────────────────────────────────────────────────
  const tagDefs = [
    { name: "Travail", color: "#00D4FF" },
    { name: "Perso", color: "#22C55E" },
    { name: "Urgent", color: "#EF4444" },
    { name: "Design", color: "#F97316" },
    { name: "Finance", color: "#A78BFA" },
    { name: "Santé", color: "#14B8A6" },
  ]
  const tags: { id: string; name: string }[] = []
  for (const t of tagDefs) {
    const tag = await db.tag.upsert({
      where: { userId_name: { userId: user.id, name: t.name } },
      create: { userId: user.id, name: t.name, color: t.color },
      update: { color: t.color },
    })
    tags.push({ id: tag.id, name: tag.name })
  }
  const tagIds = (names: string[]) =>
    names
      .map((n) => tags.find((t) => t.name === n)?.id)
      .filter((id): id is string => Boolean(id))
      .map((id) => ({ id }))

  // ── Événement à lier (premier événement futur de l'utilisateur) ──────────
  const linkedEvent = await db.event.findFirst({
    where: { userId: user.id, startTime: { gte: new Date() } },
    orderBy: { startTime: "asc" },
    select: { id: true, title: true, startTime: true },
  })

  const now = new Date()

  type SeedTask = {
    title: string
    description?: string
    status: "todo" | "doing" | "done" | "archived"
    priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT"
    dueDate?: Date | null
    tags: string[]
    subtasks?: { title: string; completed?: boolean }[]
    completedAt?: Date | null
    aiSuggestedPriority?: "LOW" | "MEDIUM" | "HIGH" | "URGENT"
    aiConfidence?: number
    eventId?: string | null
  }

  const tasks: SeedTask[] = [
    {
      title: "Préparer la présentation Orbit",
      description: "Slides + démo live pour le comité de direction.",
      status: "todo",
      priority: "URGENT",
      dueDate: at(addDays(now, 1), 18, 0),
      tags: ["Travail", "Urgent"],
      subtasks: [
        { title: "Structurer le plan (intro, démo, roadmap)" },
        { title: "Préparer les captures d'écran" },
        { title: "Répéter la démo live", completed: true },
      ],
      // Placeholder IA (Phase 4) — démo de la section « L'IA suggère »
      aiSuggestedPriority: "HIGH",
      aiConfidence: 0.87,
    },
    {
      title: "Répondre au client Dupont",
      description: "Question sur les délais de livraison du lot 3.",
      status: "todo",
      priority: "HIGH",
      dueDate: at(now, 18, 0),
      tags: ["Travail", "Urgent"],
    },
    {
      title: "Réserver un restaurant pour samedi",
      description: "Table pour 6, italien de préférence.",
      status: "todo",
      priority: "MEDIUM",
      dueDate: at(addDays(now, 2), 12, 0),
      tags: ["Perso"],
      subtasks: [
        { title: "Comparer 2-3 adresses" },
        { title: "Appeler pour réserver", completed: true },
      ],
    },
    {
      title: "Trier la boîte de réception",
      description: "Appliquer Inbox Zero, archiver les newsletters.",
      status: "todo",
      priority: "LOW",
      dueDate: null,
      tags: ["Perso"],
    },
    {
      title: "Régler la facture d'électricité",
      description: "Prélèvement à vérifier sur le compte.",
      status: "todo",
      priority: "HIGH",
      dueDate: subDays(now, 1), // en retard — alerte visuelle
      tags: ["Finance"],
    },
    {
      title: "Rédiger le cahier des charges",
      description: "Sections architecture + sécurité.",
      status: "doing",
      priority: "HIGH",
      dueDate: at(addDays(now, 3), 17, 0),
      tags: ["Travail"],
      subtasks: [
        { title: "Contexte et objectifs", completed: true },
        { title: "Architecture technique", completed: true },
        { title: "Exigences de sécurité" },
        { title: "Planning de livraison" },
        { title: "Annexes" },
      ],
    },
    {
      title: "Maquettes de la vue Kanban",
      description: "Colonnes, cartes, badges de priorité — déclinaison mobile.",
      status: "doing",
      priority: "MEDIUM",
      dueDate: at(addDays(now, 2), 15, 0),
      tags: ["Travail", "Design"],
      subtasks: [
        { title: "Desktop 3 colonnes", completed: true },
        { title: "Mobile : tabs entre statuts" },
      ],
    },
    {
      title: "Découvrir Ollama en local",
      description: "Installer Llama 3 8B quantifié et tester.",
      status: "doing",
      priority: "MEDIUM",
      dueDate: null,
      tags: ["Perso"],
    },
    {
      title: `Préparer ${linkedEvent?.title ?? "le prochain événement"}`,
      description: linkedEvent
        ? `Tâche liée à l'événement du calendrier (${linkedEvent.startTime.toISOString()}).`
        : "Tâche liée au calendrier.",
      status: "todo",
      priority: "MEDIUM",
      dueDate: linkedEvent ? subHours(linkedEvent.startTime, 24) : null,
      tags: ["Travail"],
      eventId: linkedEvent?.id ?? null,
    },
    {
      title: "Mettre à jour le CV",
      description: "Ajouter le projet Orbit et les skills IA.",
      status: "done",
      priority: "MEDIUM",
      dueDate: null,
      tags: ["Perso"],
      completedAt: subDays(now, 2),
    },
    {
      title: "Payer la facture internet",
      description: "Facture de novembre.",
      status: "done",
      priority: "HIGH",
      dueDate: at(addDays(now, -2), 12, 0),
      tags: ["Finance"],
      completedAt: subDays(now, 4),
    },
    {
      title: "Configurer l'environnement de dev",
      description: "Next.js, Prisma, Docker.",
      status: "done",
      priority: "MEDIUM",
      dueDate: null,
      tags: ["Travail"],
      completedAt: subDays(now, 6),
    },
    {
      title: "Séance de sport",
      description: "Haut du corps — BasicFit.",
      status: "done",
      priority: "LOW",
      dueDate: at(addDays(now, -1), 18, 0),
      tags: ["Santé"],
      completedAt: subDays(now, 1),
    },
    {
      title: "Ancien projet site vitrine",
      description: "Terminé puis archivé — masqué par défaut dans le Kanban.",
      status: "archived",
      priority: "LOW",
      dueDate: null,
      tags: ["Perso"],
      completedAt: subDays(now, 10),
    },
  ]

  // Positions espacées par colonne
  const counters: Record<string, number> = {}
  let created = 0
  for (const t of tasks) {
    const index = (counters[t.status] ?? 0) + 1
    counters[t.status] = index
    await db.task.create({
      data: {
        userId: user.id,
        title: t.title,
        description: t.description ?? null,
        status: t.status,
        priority: t.priority,
        position: index * 1000,
        dueDate: t.dueDate ?? null,
        completedAt: t.completedAt ?? (t.status === "done" ? now : null),
        aiSuggestedPriority: t.aiSuggestedPriority ?? null,
        aiConfidence: t.aiConfidence ?? null,
        eventId: t.eventId ?? null,
        tags: { connect: tagIds(t.tags) },
        ...(t.subtasks?.length
          ? {
              subtasks: {
                create: t.subtasks.map((s, i) => ({
                  title: s.title,
                  completed: s.completed ?? false,
                  position: (i + 1) * 1000,
                })),
              },
            }
          : {}),
      },
    })
    created++
  }

  console.log(`✅ ${created} tâches créées pour ${email}`)
  console.log(
    `   Tags : ${tagDefs.length} · Sous-tâches : ${tasks.reduce((n, t) => n + (t.subtasks?.length ?? 0), 0)}`
  )
  if (linkedEvent) console.log(`   Lien calendrier : « ${linkedEvent.title} »`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => db.$disconnect())
