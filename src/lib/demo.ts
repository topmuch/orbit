// Orbit — Données de démonstration
// Crée/synchronise le compte démo avec des données réalistes (dates relatives à aujourd'hui).

import "server-only"
import { v4 as uuid } from "uuid"
import {
  addDays,
  addHours,
  setHours,
  setMinutes,
  subDays,
  subHours,
  format,
} from "date-fns"
import { fr } from "date-fns/locale"
import { db } from "@/lib/db"
import { hashPassword } from "@/lib/auth"

export const DEMO_EMAIL = "demo@orbit.app"
export const DEMO_PASSWORD = "orbit2024"

function at(base: Date, hour: number, minute: number): Date {
  return setMinutes(setHours(base, hour), minute)
}

const frDate = (d: Date) => format(d, "EEEE d MMMM", { locale: fr })
const frTime = (d: Date) => format(d, "HH'h'mm", { locale: fr })

/** Assure l'existence du compte démo + données ; retourne l'id utilisateur */
export async function ensureDemoUser(): Promise<string> {
  const passwordHash = hashPassword(DEMO_PASSWORD)
  let user = await db.user.findUnique({ where: { email: DEMO_EMAIL } })

  if (!user) {
    user = await db.user.create({
      data: { email: DEMO_EMAIL, name: "Alex Martin", passwordHash },
    })
  }

  const eventCount = await db.event.count({ where: { userId: user.id } })
  if (eventCount === 0) await seedDemoData(user.id)

  return user.id
}

export async function seedDemoData(userId: string): Promise<void> {
  const now = new Date()

  // ---------- Événements ----------
  const events = [
    // Aujourd'hui
    { title: "Réunion d'équipe hebdo", description: "Point hebdomadaire de l'équipe produit.", start: at(now, 9, 30), end: at(now, 10, 30) },
    { title: "Déjeuner avec Claire", description: "Restaurant Le Bistrot, 14 rue des Lilas.", start: at(now, 12, 30), end: at(now, 14, 0) },
    { title: "Point projet Orbit", description: "Revue des maquettes et priorités sprint 2.", start: at(now, 16, 0), end: at(now, 17, 0) },
    // Demain
    { title: "Rendez-vous dentiste", description: "Cabinet Dr. Lefèvre — contrôle annuel.", start: at(addDays(now, 1), 14, 30), end: at(addDays(now, 1), 15, 15), source: "email_extract" },
    { title: "Sport — musculation", description: "Salle BasicFit, séance haut du corps.", start: at(addDays(now, 1), 18, 0), end: at(addDays(now, 1), 19, 0) },
    // Cette semaine
    { title: "Webinar : IA locale & confidentialité", description: "Présentation en ligne — Ollama et Llama 3.", start: at(addDays(now, 2), 11, 0), end: at(addDays(now, 2), 12, 0) },
    { title: "Dîner anniversaire Marc", description: "Chez Marc, apéro à partir de 20h.", start: at(addDays(now, 3), 20, 0), end: at(addDays(now, 3), 23, 0) },
    { title: "Atelier productivité", description: "Méthode PARA et revue hebdomadaire.", start: at(addDays(now, 5), 10, 0), end: at(addDays(now, 5), 12, 30) },
    // Passé
    { title: "Rétrospective sprint 12", description: "Ce qui a marché / à améliorer.", start: at(addDays(now, -1), 15, 0), end: at(addDays(now, -1), 16, 0) },
    { title: "Consultation médecin", description: "Bilan annuel, Dr. Ngoy.", start: at(addDays(now, -3), 11, 0), end: at(addDays(now, -3), 11, 45) },
  ]

  await db.event.createMany({
    data: events.map((e) => ({
      userId,
      title: e.title,
      description: e.description,
      startTime: e.start,
      endTime: e.end,
      source: e.source ?? "manual",
    })),
  })

  // ---------- Tags ----------
  const tagDefs = [
    { name: "Travail", color: "#00D4FF" },
    { name: "Perso", color: "#22C55E" },
    { name: "Urgent", color: "#EF4444" },
    { name: "Design", color: "#F97316" },
    { name: "Finance", color: "#A78BFA" },
    { name: "Santé", color: "#14B8A6" },
  ]
  const tags = await Promise.all(
    tagDefs.map((t) =>
      db.tag.upsert({
        where: { userId_name: { userId, name: t.name } },
        create: { userId, name: t.name, color: t.color },
        update: {},
      })
    )
  )
  const tagByName = (name: string) => {
    const tag = tags.find((t) => t.name === name)
    return tag ? [{ id: tag.id }] : []
  }

  // ---------- Tâches (statuts, priorités, tags, sous-tâches, positions) ----------
  type DemoTask = {
    title: string
    description?: string
    status: "todo" | "doing" | "done"
    priority: "LOW" | "MEDIUM" | "HIGH" | "URGENT"
    dueDate: Date | null
    tagNames?: string[]
    subtasks?: { title: string; completed?: boolean }[]
    completedDaysAgo?: number
  }

  const demoTasks: DemoTask[] = [
    {
      title: "Préparer la présentation Orbit",
      description: "Slides + démo live pour le comité de direction.",
      status: "todo",
      priority: "URGENT",
      dueDate: at(addDays(now, 1), 18, 0),
      tagNames: ["Travail", "Urgent"],
      subtasks: [
        { title: "Structurer le plan (intro, démo, roadmap)" },
        { title: "Préparer les captures d'écran" },
        { title: "Répéter la démo live", completed: true },
      ],
    },
    {
      title: "Répondre au client Dupont",
      description: "Question sur les délais de livraison du lot 3.",
      status: "todo",
      priority: "HIGH",
      dueDate: at(now, 18, 0),
      tagNames: ["Travail", "Urgent"],
    },
    {
      title: "Réserver un restaurant pour samedi",
      description: "Table pour 6, italien de préférence.",
      status: "todo",
      priority: "MEDIUM",
      dueDate: at(addDays(now, 2), 12, 0),
      tagNames: ["Perso"],
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
      tagNames: ["Perso"],
    },
    {
      title: "Régler la facture d'électricité",
      description: "Prélèvement à vérifier sur le compte.",
      status: "todo",
      priority: "HIGH",
      dueDate: subDays(now, 1), // en retard — alerte visuelle
      tagNames: ["Finance"],
    },
    {
      title: "Rédiger le cahier des charges",
      description: "Sections architecture + sécurité.",
      status: "doing",
      priority: "HIGH",
      dueDate: at(addDays(now, 3), 17, 0),
      tagNames: ["Travail"],
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
      tagNames: ["Travail", "Design"],
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
      tagNames: ["Perso"],
    },
    {
      title: "Mettre à jour le CV",
      description: "Ajouter le projet Orbit et les skills IA.",
      status: "done",
      priority: "MEDIUM",
      dueDate: null,
      tagNames: ["Perso"],
      completedDaysAgo: 2,
    },
    {
      title: "Payer la facture internet",
      description: "Facture de novembre.",
      status: "done",
      priority: "HIGH",
      dueDate: at(addDays(now, -2), 12, 0),
      tagNames: ["Finance"],
      completedDaysAgo: 4,
    },
    {
      title: "Configurer l'environnement de dev",
      description: "Next.js, Prisma, Docker.",
      status: "done",
      priority: "MEDIUM",
      dueDate: null,
      tagNames: ["Travail"],
      completedDaysAgo: 6,
    },
    {
      title: "Séance de sport",
      description: "Haut du corps — BasicFit.",
      status: "done",
      priority: "LOW",
      dueDate: at(addDays(now, -1), 18, 0),
      tagNames: ["Santé"],
      completedDaysAgo: 1,
    },
  ]

  // Position par colonne (entiers espacés)
  const columnCounters: Record<string, number> = {}
  for (const t of demoTasks) {
    const index = (columnCounters[t.status] ?? 0) + 1
    columnCounters[t.status] = index
    await db.task.create({
      data: {
        userId,
        title: t.title,
        description: t.description ?? null,
        status: t.status,
        priority: t.priority,
        position: index * 1000,
        dueDate: t.dueDate,
        completedAt:
          t.completedDaysAgo !== undefined ? subDays(now, t.completedDaysAgo) : t.status === "done" ? now : null,
        tags: { connect: (t.tagNames ?? []).flatMap(tagByName) },
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
  }

  // ---------- Emails ----------
  const emails = [
    {
      fromAddress: "contact@cabinet-dentaire-lefevre.fr",
      fromName: "Cabinet Dr. Lefèvre",
      subject: "Confirmation de votre rendez-vous",
      bodyText: `Bonjour,\n\nNous vous confirmons votre rendez-vous de contrôle annuel.\n\nDate : ${frDate(addDays(now, 1))}\nHeure : ${frTime(at(addDays(now, 1), 14, 30))}\nDurée : 45 minutes\nAdresse : 22 avenue Voltaire, 75011 Paris\n\nMerci d'arriver 10 minutes en avance. En cas d'empêchement, prévenez-nous au moins 24h à l'avance.\n\nCordialement,\nLe secrétariat du Dr. Lefèvre`,
      isRead: false,
    },
    {
      fromAddress: "facturation@orange.fr",
      fromName: "Orange Facturation",
      subject: "Votre facture de ${mois} est disponible",
      bodyText: `Chère cliente, cher client,\n\nVotre facture est disponible dans votre espace client.\n\nMontant : 46,90 €\nDate d'échéance : ${frDate(addDays(now, 6))}\nPrélèvement automatique : OUI\n\nVous pouvez consulter le détail de vos consommations depuis votre application Orange et moi.\n\nL'équipe Orange`,
      isRead: false,
    },
    {
      fromAddress: "marc.dupont@gmail.com",
      fromName: "Marc Dupont",
      subject: "Dîner samedi soir ?",
      bodyText: `Salut !\n\nÇa te dirait qu'on se fasse un dîner samedi soir pour fêter ma promotion ? J'ai pensé à la nouvelle italienne du quartier, La Trattoria.\n\nJe pensais réserver pour 20h, ils font des pânes incroyables d'après les avis.\n\nDis-moi si tu es dispo !\n\nMarc`,
      isRead: false,
    },
    {
      fromAddress: "billetterie@theatre-municipal.fr",
      fromName: "Théâtre Municipal",
      subject: "Votre réservation est confirmée",
      bodyText: `Bonjour,\n\nVotre réservation pour la pièce « Les Choix d'Éléonore » est confirmée.\n\nReprésentation : ${frDate(addDays(now, 4))} à 20h00\nSalle : Grande scène (salle 12)\nPlaces : F14, F15\n\nLes portes ouvrent 30 minutes avant le début de la représentation.\n\nÀ bientôt au théâtre !`,
      isRead: false,
    },
    {
      fromAddress: "equipe@startup-nova.io",
      fromName: "Équipe Nova",
      subject: "Compte-rendu de la réunion produit",
      bodyText: `Bonjour à tous,\n\nVoici le compte-rendu de la réunion produit de la semaine dernière :\n\n1. Roadmap T3 validée, priorité au module collaboration\n2. Recrutement : 2 postes ouverts (backend, design)\n3. Prochaine réunion : lundi 9h30, salle Vega\n\nLe détail complet est disponible sur le wiki.\n\nBonne journée,\nL'équipe Nova`,
      isRead: true,
    },
    {
      fromAddress: "security@github.com",
      fromName: "GitHub",
      subject: "Alerte de sécurité : nouvelle connexion",
      bodyText: `Bonjour,\n\nNous avons détecté une nouvelle connexion à votre compte GitHub.\n\nAppareil : MacBook Pro\nLocalisation : Dakar, Sénégal\nDate : ${frDate(subDays(now, 1))} à ${frTime(subHours(now, 26))}\n\nSi c'était bien vous, aucune action n'est nécessaire. Sinon, réinitialisez votre mot de passe immédiatement.\n\nL'équipe GitHub`,
      isRead: true,
    },
    {
      fromAddress: "no-reply@linkedin.com",
      fromName: "LinkedIn",
      subject: "Vous apparaissez dans 5 recherches",
      bodyText: `Bonjour Alex,\n\nVotre profil a été vu 17 fois cette semaine et vous apparaissez dans 5 recherches de recruteurs.\n\nConsultez qui a consulté votre profil depuis votre tableau de bord.\n\nÀ bientôt,\nL'équipe LinkedIn`,
      isRead: true,
    },
  ]

  await db.emailLog.createMany({
    data: emails.map((e, i) => ({
      userId,
      messageId: uuid(),
      fromAddress: e.fromAddress,
      fromName: e.fromName,
      subject: e.subject.replace("${mois}", format(now, "MMMM", { locale: fr })),
      bodyText: e.bodyText,
      receivedAt: subHours(now, 3 + i * 7),
      isRead: e.isRead,
    })),
  })
}

/** Génère de nouveaux emails entrants (simulation de synchro IMAP) */
export async function generateIncomingEmails(userId: string, count = 3): Promise<number> {
  const now = new Date()
  const pool = [
    {
      fromAddress: "rh@societe-generale-interne.fr",
      fromName: "RH — Portail interne",
      subject: "Entretien annuel à planifier",
      bodyText: `Bonjour,\n\nVotre entretien annuel doit être planifié avant la fin du mois.\n\nNous vous proposons un créneau : ${frDate(addDays(now, 3))} à ${frTime(at(addDays(now, 3), 10, 0))} (durée 1h), salle Confiance, 3e étage.\n\nConfirmez votre présence via le portail RH.\n\nLe service des ressources humaines`,
    },
    {
      fromAddress: "support@ldlc.com",
      fromName: "LDLC",
      subject: "Votre commande a été expédiée",
      bodyText: `Bonjour,\n\nBonne nouvelle : votre commande #LD4471203 a été expédiée !\n\nLivraison estimée : entre le ${frDate(addDays(now, 2))} et le ${frDate(addDays(now, 4))}.\n\nSuivez votre colis avec le numéro : 6A12478900321.\n\nMerci pour votre confiance,\nL'équipe LDLC`,
    },
    {
      fromAddress: "coach@basicfit.fr",
      fromName: "BasicFit",
      subject: "Rappel : votre séance de coaching",
      bodyText: `Salut !\n\nPetit rappel : ta séance de coaching personnel est prévue ${frDate(addDays(now, 2))} à ${frTime(at(addDays(now, 2), 17, 30))}.\n\nPense à apporter ta serviette et ta gourde. On bosse les jambes aujourd'hui ! 💪\n\nÀ demain,\nTon coach Sami`,
    },
    {
      fromAddress: "ne-pas-repondre@impots.gouv.fr",
      fromName: "DGFiP",
      subject: "Déclaration : pièce justificative manquante",
      bodyText: `Bonjour,\n\nNous avons reçu votre déclaration. Une pièce justificative est manquante pour le traitement de votre dossier.\n\nVous avez jusqu'au ${frDate(addDays(now, 7))} pour la téléverser depuis votre espace personnel « impots.gouv.fr ».\n\nCordialement,\nLa direction générale des finances publiques`,
    },
    {
      fromAddress: "reservation@lamaisonduverre.fr",
      fromName: "La Maison du Verre",
      subject: "Demande de réservation en attente",
      bodyText: `Bonjour,\n\nNous avons bien reçu votre demande de réservation pour ${frDate(addDays(now, 5))} à ${frTime(at(addDays(now, 5), 20, 0))} — 4 personnes.\n\nNous vous confirmons la table dans les plus brefs délais.\n\nLa Maison du Verre — 9 rue Oberkampf`,
    },
    {
      fromAddress: "admin@meetup-prod.fr",
      fromName: "Meetup Product Paris",
      subject: "Ton événement demain : Product Coffee",
      bodyText: `Hello !\n\nRappel : tu es inscrit(e) au Product Coffee de demain, ${frDate(addDays(now, 1))} à ${frTime(at(addDays(now, 1), 8, 30))}, Café Marlette (Le Marais).\n\nAu programme : retours d'expérience sur les roadmaps 2025.\n\nÀ demain !\nL'équipe Meetup`,
    },
  ]

  const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, count)
  await db.emailLog.createMany({
    data: shuffled.map((e, i) => ({
      userId,
      messageId: uuid(),
      fromAddress: e.fromAddress,
      fromName: e.fromName,
      subject: e.subject,
      bodyText: e.bodyText,
      receivedAt: subMinutes(now, 2 + i),
      isRead: false,
    })),
  })
  return shuffled.length
}

function subMinutes(d: Date, n: number): Date {
  return new Date(d.getTime() - n * 60_000)
}
