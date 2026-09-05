// Orbit — Sérialisation DTO (Prisma → API)
// ─────────────────────────────────────────────────────────────────────────────
// Lecture défensive des champs JSON (attendus de la validation Zod, mais
// potentiellement corrompus/hérités) : toute valeur invalide est ignorée.

import type { Event, Task, EmailLog, Tag, SubTask } from "@prisma/client"
import type {
  EventDto,
  TaskDto,
  EmailDto,
  EventSuggestion,
  RecurrenceRule,
  EventAttendee,
  EventReminder,
  TaskPriority,
  TaskStatus,
} from "@/lib/types"
import type { Occurrence } from "@/lib/calendar"

/** Tâche Prisma avec relations chargées (tags + subtasks). */
export type TaskWithRelations = Task & { tags: Tag[]; subtasks: SubTask[] }

// ─────────────────────────────────────────────────────────────────────────────
// Lecteurs JSON défensifs
// ─────────────────────────────────────────────────────────────────────────────

export function parseRecurrence(raw: unknown): RecurrenceRule | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (r.frequency !== "daily" && r.frequency !== "weekly" && r.frequency !== "monthly") return null
  const interval = typeof r.interval === "number" && r.interval >= 1 ? Math.floor(r.interval) : 1
  const out: RecurrenceRule = { frequency: r.frequency, interval }
  if (typeof r.until === "string" && !Number.isNaN(Date.parse(r.until))) out.until = r.until
  if (typeof r.count === "number" && r.count >= 1) out.count = Math.floor(r.count)
  if (Array.isArray(r.byDays)) {
    const days = r.byDays.filter((d): d is number => typeof d === "number" && d >= 0 && d <= 6)
    if (days.length) out.byDays = days
  }
  if (typeof r.nth === "number" && (r.nth === -1 || (r.nth >= 1 && r.nth <= 5))) out.nth = r.nth
  return out
}

export function parseAttendees(raw: unknown): EventAttendee[] | null {
  if (!Array.isArray(raw)) return null
  const out: EventAttendee[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const a = item as Record<string, unknown>
    if (typeof a.email !== "string" || !a.email.includes("@")) continue
    out.push({
      email: a.email,
      name: typeof a.name === "string" ? a.name : undefined,
      status:
        a.status === "accepted" || a.status === "declined" ? a.status : "pending",
    })
  }
  return out.length ? out : null
}

export function parseReminders(raw: unknown): EventReminder[] | null {
  if (!Array.isArray(raw)) return null
  const out: EventReminder[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") continue
    const r = item as Record<string, unknown>
    if (typeof r.minutes !== "number" || r.minutes < 0) continue
    if (r.type !== "push" && r.type !== "email") continue
    out.push({ minutes: Math.floor(r.minutes), type: r.type })
  }
  return out.length ? out : null
}

export function parseStringArray(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const out = raw.filter((s): s is string => typeof s === "string" && !Number.isNaN(Date.parse(s)))
  return out.length ? out : null
}

// ─────────────────────────────────────────────────────────────────────────────
// Sérialiseurs
// ─────────────────────────────────────────────────────────────────────────────

/** Événement master (persisté) → DTO complet. */
export function toEventDto(e: Event): EventDto {
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    location: e.location,
    startTime: e.startTime.toISOString(),
    endTime: e.endTime.toISOString(),
    allDay: e.allDay,
    timezone: e.timezone || "UTC",
    color: e.color,
    source: (e.source as EventDto["source"]) ?? "manual",
    recurrence: parseRecurrence(e.recurrence),
    attendees: parseAttendees(e.attendees),
    reminders: parseReminders(e.reminders),
    externalId: e.externalId,
    createdAt: e.createdAt.toISOString(),
    isOccurrence: false,
    seriesId: null,
    occurrenceStart: null,
  }
}

/** Occurrence expansée d'une série → DTO virtuel (id = master, métadonnées d'occurrence). */
export function toOccurrenceDto(e: Event, occ: Occurrence): EventDto {
  return {
    ...toEventDto(e),
    startTime: occ.start.toISOString(),
    endTime: occ.end.toISOString(),
    isOccurrence: true,
    seriesId: e.id,
    occurrenceStart: occ.start.toISOString(),
  }
}

/** Priorité valide depuis la base (défensif : valeurs héritées "1"/"2" → MEDIUM). */
function toPriority(raw: string | null | undefined): TaskPriority {
  return raw === "LOW" || raw === "MEDIUM" || raw === "HIGH" || raw === "URGENT"
    ? raw
    : "MEDIUM"
}

/** Statut valide depuis la base (défensif). */
function toTaskStatus(raw: string | null | undefined): TaskStatus {
  return raw === "todo" || raw === "doing" || raw === "done" || raw === "archived"
    ? raw
    : "todo"
}

export function toTaskDto(t: TaskWithRelations): TaskDto {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    status: toTaskStatus(t.status),
    priority: toPriority(t.priority),
    position: t.position,
    dueDate: t.dueDate ? t.dueDate.toISOString() : null,
    completedAt: t.completedAt ? t.completedAt.toISOString() : null,
    tags: (t.tags ?? []).map((tag) => ({ id: tag.id, name: tag.name, color: tag.color })),
    subtasks: (t.subtasks ?? [])
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((s) => ({
        id: s.id,
        title: s.title,
        completed: s.completed,
        position: s.position,
        createdAt: s.createdAt.toISOString(),
      })),
    aiSuggestedPriority:
      t.aiSuggestedPriority === "LOW" ||
      t.aiSuggestedPriority === "MEDIUM" ||
      t.aiSuggestedPriority === "HIGH" ||
      t.aiSuggestedPriority === "URGENT"
        ? t.aiSuggestedPriority
        : null,
    aiConfidence: typeof t.aiConfidence === "number" ? t.aiConfidence : null,
    eventId: t.eventId,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  }
}

export function toEmailDto(e: EmailLog): EmailDto {
  const raw = e.suggestedEvent as EventSuggestion | null
  let suggested: EventSuggestion | null = null
  if (raw && typeof raw === "object" && raw.title && raw.startTime) {
    suggested = {
      title: String(raw.title),
      description: String(raw.description ?? ""),
      startTime: String(raw.startTime),
      endTime: String(raw.endTime ?? raw.startTime),
      confidence: Number(raw.confidence ?? 0.5),
    }
  }
  return {
    id: e.id,
    messageId: e.messageId,
    fromAddress: e.fromAddress,
    fromName: e.fromName,
    subject: e.subject,
    bodyText: e.bodyText,
    receivedAt: e.receivedAt.toISOString(),
    isRead: e.isRead,
    isProcessed: e.isProcessed,
    suggestedEvent: suggested,
  }
}

// ── Notifications (historique + préférences) ────────────────────────────────

import type { Notification, NotificationPreference } from "@prisma/client"
import type { NotificationDto, NotificationPreferenceDto, NotificationTargetView, NotificationType } from "@/lib/types"

const NOTIF_TYPES: readonly string[] = [
  "EVENT_REMINDER",
  "TASK_DEADLINE",
  "IMPORTANT_EMAIL",
  "AI_SUGGESTION",
  "SYSTEM",
  "CUSTOM",
]
const NOTIF_VIEWS: readonly string[] = ["calendar", "tasks", "emails"]

/**
 * Notification → DTO. Le champ data est BLANCHI : seuls view + les ids
 * utiles au deep link (eventId/taskId/emailId/notificationId) sont exposés —
 * jamais de contenu arbitraire vers le client.
 */
export function toNotificationDto(n: Notification): NotificationDto {
  const raw = (n.data ?? {}) as Record<string, unknown>
  const data: NotificationDto["data"] = {}
  if (typeof raw.view === "string" && NOTIF_VIEWS.includes(raw.view)) {
    data.view = raw.view as NotificationTargetView
  }
  for (const key of ["eventId", "taskId", "emailId", "notificationId"]) {
    if (typeof raw[key] === "string") data[key] = raw[key]
  }
  return {
    id: n.id,
    type: (NOTIF_TYPES.includes(n.type) ? n.type : "SYSTEM") as NotificationType,
    title: n.title,
    body: n.body,
    data: Object.keys(data).length ? data : null,
    isRead: n.isRead,
    isSent: n.isSent,
    createdAt: n.createdAt.toISOString(),
  }
}

/** Préférences → DTO (heures calmes nettoyées). */
export function toNotificationPreferenceDto(p: NotificationPreference): NotificationPreferenceDto {
  return {
    eventReminder: p.eventReminder,
    taskDeadline: p.taskDeadline,
    importantEmail: p.importantEmail,
    aiSuggestion: p.aiSuggestion,
    eventReminderTime: p.eventReminderTime,
    quietHoursEnabled: p.quietHoursEnabled,
    quietHoursStart: typeof p.quietHoursStart === "string" ? p.quietHoursStart : null,
    quietHoursEnd: typeof p.quietHoursEnd === "string" ? p.quietHoursEnd : null,
  }
}
