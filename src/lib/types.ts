// Orbit — Types partagés client/serveur (Phase 1)

export type SessionUser = {
  id: string
  email: string
  name: string | null
}

export type EventDto = {
  id: string
  title: string
  description: string | null
  startTime: string // ISO
  endTime: string // ISO
  source: EventSource
  createdAt: string
}

export type EventSource = "manual" | "email_extract" | "ai"

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
