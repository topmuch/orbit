// Orbit — Sérialisation DTO (Prisma → API)

import type { Event, Task, EmailLog } from "@prisma/client"
import type { EventDto, TaskDto, EmailDto, EventSuggestion } from "@/lib/types"

export function toEventDto(e: Event): EventDto {
  return {
    id: e.id,
    title: e.title,
    description: e.description,
    startTime: e.startTime.toISOString(),
    endTime: e.endTime.toISOString(),
    source: (e.source as EventDto["source"]) ?? "manual",
    createdAt: e.createdAt.toISOString(),
  }
}

export function toTaskDto(t: Task): TaskDto {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    status: (t.status as TaskDto["status"]) ?? "todo",
    priority: t.priority,
    dueDate: t.dueDate ? t.dueDate.toISOString() : null,
    aiPriority: t.aiPriority,
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
