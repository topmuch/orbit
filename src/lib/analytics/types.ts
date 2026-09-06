// Orbit — Analytics : DTO partagé serveur ⇄ client
// ─────────────────────────────────────────────────────────────────────────────
// Ce fichier est VOLONTAIREMENT sans "server-only" : les composants client
// (StatsCards, DashboardCharts) importent le type depuis ici, tandis que
// queries.ts (server-only) le ré-exporte pour la couche serveur.
//
// Conventions :
//  • `date` = clé "yyyy-MM-dd" du jour calendaire DANS LE FUSEAU DU PROFIL
//    (bucketing serveur via Intl "en-CA" — cf. lib/timezone.ts dayKeyInTz).
//    À consommer côté client sans reparsing Date naïf (split("-") ou
//    parseISO = minuit locale, sans décalage de fuseau).
//  • `label` = forme courte "MM-dd" fournie par défaut ; le CLIENT
//    reconstruit le jour de semaine localisé (date-fns + locale i18n).

/** Statuts représentés dans la répartition (archivé exclu — soft delete). */
export type AnalyticsStatus = "todo" | "doing" | "done";

/** Priorités de tâches (spec Kanban). */
export type AnalyticsPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

export type AnalyticsDto = {
  totals: {
    /** Tâches à faire + en cours (status in todo|doing). */
    activeTasks: number;
    /** completedAt dans la semaine courante (lundi → dimanche, fuseau profil). */
    completedThisWeek: number;
    /** dueDate < now, statut ni done ni archivé. */
    overdue: number;
    /** Emails non lus du dossier INBOX. */
    unreadEmails: number;
    /** 0..1 : done / (todo + doing + done) — archivé exclu. */
    completionRate: number;
    /** Événements (occurrences expansées incluses) chevauchant la semaine. */
    eventsThisWeek: number;
  };
  /** 14 derniers jours (aujourd'hui en dernier) — complétions par jour. */
  productivity: { date: string; label: string; completed: number }[];
  /** Répartition des tâches non archivées par statut. */
  byStatus: { status: AnalyticsStatus; count: number }[];
  /** Répartition des tâches non archivées par priorité. */
  byPriority: { priority: AnalyticsPriority; count: number }[];
  /** 14 derniers jours (aujourd'hui en dernier) — emails INBOX reçus/jour. */
  emailsPerDay: { date: string; label: string; count: number }[];
};
