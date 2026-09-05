// Orbit — Types partagés client/serveur (Phase 1)

export type SessionUser = {
  id: string
  email: string
  name: string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// Événements — types riches (récurrences, fuseaux, participants, rappels)
// ─────────────────────────────────────────────────────────────────────────────

export type EventSource = "manual" | "email_extract" | "ai" | "import"

/** Jour de semaine pour les récurrences hebdomadaires (0 = lundi … 6 = dimanche). */
export type WeekdayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** Règle de récurrence (stockée en JSON sur Event.recurrence).
 *  until/count : bornes de série ; byDays : jours visés (hebdo) ;
 *  nth : n-ième jour de semaine du mois (1..5, -1 = dernier) — mensuel. */
export type RecurrenceRule = {
  frequency: "daily" | "weekly" | "monthly"
  interval: number
  until?: string // ISO UTC — inclusif (date seule = fin de journée)
  count?: number
  byDays?: number[]
  nth?: number
}

export type EventAttendee = {
  email: string
  name?: string
  status: "pending" | "accepted" | "declined"
}

export type EventReminder = {
  minutes: number
  type: "push" | "email"
}

export type EventDto = {
  id: string
  title: string
  description: string | null
  location: string | null
  /** Instants UTC (ISO 8601, suffixe Z) — règle d'or : stockage/échange UTC. */
  startTime: string
  endTime: string
  allDay: boolean
  /** Fuseau IANA de référence de l'événement. */
  timezone: string
  /** Couleur hex (#RRGGBB) — null = couleur automatique par source. */
  color: string | null
  source: EventSource
  recurrence: RecurrenceRule | null
  attendees: EventAttendee[] | null
  reminders: EventReminder[] | null
  externalId: string | null
  createdAt: string
  /** true = occurrence expansée d'une série (non persistée en base). */
  isOccurrence: boolean
  /** Id du master quand isOccurrence (sinon null). */
  seriesId: string | null
  /** Début ISO UTC de l'occurrence (identifiant d'exception / scope « single »). */
  occurrenceStart: string | null
}

export type EventCreateInput = {
  title: string
  description?: string | null
  location?: string | null
  startTime: string
  endTime: string
  allDay?: boolean
  timezone?: string
  color?: string | null
  recurrence?: RecurrenceRule | null
  attendees?: EventAttendee[] | null
  reminders?: EventReminder[] | null
  source?: EventSource
  externalId?: string | null
}

export type EventUpdateInput = Partial<EventCreateInput> & {
  /** « single » = modifier/supprimer une occurrence (exception de série),
   *  « series » = appliquer à toute la série (défaut). */
  scope?: "single" | "series"
  /** Début ISO UTC de l'occurrence visée (requis si scope = "single"). */
  occurrenceStart?: string
}

export type EventConflicts = {
  events: EventDto[]
}

export type EventImportResult = {
  imported: number
  skipped: number
  events: EventDto[]
  warnings: string[]
}

export type TaskStatus = "todo" | "doing" | "done"

export type TaskDto = {
  id: string
  title: string
  description: string | null
  status: TaskStatus
  priority: number // 0 = basse, 1 = moyenne, 2 = haute
  dueDate: string | null
  aiPriority: number | null
  createdAt: string
  updatedAt: string
}

/** Suggestion d'événement extraite par l'IA depuis un email */
export type EventSuggestion = {
  title: string
  description: string
  startTime: string // ISO
  endTime: string // ISO
  confidence: number // 0..1
}

export type EmailDto = {
  id: string
  messageId: string
  fromAddress: string
  fromName: string | null
  subject: string
  bodyText: string
  receivedAt: string // ISO
  isRead: boolean
  isProcessed: boolean
  suggestedEvent: EventSuggestion | null
}

export type StatsDto = {
  eventsToday: number
  tasksTodo: number
  tasksDoing: number
  tasksDone: number
  tasksOverdue: number
  unreadEmails: number
  unprocessedEmails: number
  nextEvent: EventDto | null
  todayEvents: EventDto[]
  priorityTasks: TaskDto[]
  recentEmails: EmailDto[]
  weekLoad: { date: string; count: number }[]
}

export type ChatMessage = {
  role: "user" | "assistant"
  content: string
}

/** Vues navigables de l'application (navigation SPA côté client) */
export type OrbitView = "dashboard" | "calendar" | "tasks" | "emails" | "assistant" | "settings"
