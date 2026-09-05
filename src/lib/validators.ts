// Orbit — Validation Zod des entrées API

import { z } from "zod"
import { isValidTimezone } from "@/lib/timezone"

export const registerSchema = z.object({
  name: z.string().trim().min(2, "Nom trop court").max(60).optional().or(z.literal("")),
  email: z.string().trim().toLowerCase().email("Email invalide"),
  password: z.string().min(6, "Mot de passe : 6 caractères minimum").max(100),
})

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email("Email invalide"),
  password: z.string().min(1, "Mot de passe requis"),
})

const isoDate = z.string().refine((v) => !Number.isNaN(Date.parse(v)), "Date invalide")

// ─────────────────────────────────────────────────────────────────────────────
// Événements — validation riche (fuseaux, récurrences, participants, rappels)
// ─────────────────────────────────────────────────────────────────────────────

const hexColor = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Couleur invalide (format #RRGGBB)")
const timezone = z
  .string()
  .max(64)
  .refine(isValidTimezone, "Fuseau horaire invalide (format IANA attendu, ex. Europe/Paris)")

const attendeeSchema = z.object({
  email: z.string().trim().toLowerCase().email("Email participant invalide"),
  name: z.string().trim().max(120).optional(),
  status: z.enum(["pending", "accepted", "declined"]).default("pending"),
})

const reminderSchema = z.object({
  // 0 (à l'heure) → 14 jours de avance
  minutes: z.number().int().min(0).max(20160),
  type: z.enum(["push", "email"]),
})

const recurrenceSchema = z
  .object({
    frequency: z.enum(["daily", "weekly", "monthly"]),
    interval: z
      .number()
      .int()
      .min(1, "L'intervalle de récurrence doit être ≥ 1")
      .max(365, "L'intervalle de récurrence doit être ≤ 365"),
    until: isoDate.optional(),
    count: z.number().int().min(1).max(500).optional(),
    byDays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
    nth: z
      .number()
      .int()
      .refine((v) => v === -1 || (v >= 1 && v <= 5), "nth invalide (-1 ou 1..5)")
      .optional(),
  })
  .refine(
    (r) => (r.byDays ? r.frequency === "weekly" || r.frequency === "monthly" : true),
    { message: "byDays n'est autorisé que pour les récurrences weekly/monthly", path: ["byDays"] }
  )
  .refine((r) => (r.nth !== undefined ? r.frequency === "monthly" : true), {
    message: "nth n'est autorisé que pour la récurrence mensuelle",
    path: ["nth"],
  })
  .refine((r) => !(r.count !== undefined && r.until !== undefined), {
    message: "count et until sont mutuellement exclusifs",
    path: ["count"],
  })

export const eventCreateSchema = z
  .object({
    title: z.string().trim().min(1, "Le titre est requis").max(200),
    description: z.string().trim().max(5000).optional().or(z.literal("")),
    location: z.string().trim().max(500).optional().or(z.literal("")),
    startTime: isoDate,
    endTime: isoDate,
    allDay: z.boolean().default(false),
    timezone: timezone.default("UTC"),
    color: hexColor.nullable().optional(),
    recurrence: recurrenceSchema.nullable().optional(),
    attendees: z.array(attendeeSchema).max(20).nullable().optional(),
    reminders: z.array(reminderSchema).max(5).nullable().optional(),
    source: z.enum(["manual", "email_extract", "ai", "import"]).optional(),
    externalId: z.string().trim().max(250).nullable().optional(),
  })
  .refine((data) => new Date(data.endTime) > new Date(data.startTime), {
    message: "L'heure de fin doit être après l'heure de début",
    path: ["endTime"],
  })

export const eventUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    location: z.string().trim().max(500).nullable().optional(),
    startTime: isoDate.optional(),
    endTime: isoDate.optional(),
    allDay: z.boolean().optional(),
    timezone: timezone.optional(),
    color: hexColor.nullable().optional(),
    recurrence: recurrenceSchema.nullable().optional(),
    attendees: z.array(attendeeSchema).max(20).nullable().optional(),
    reminders: z.array(reminderSchema).max(5).nullable().optional(),
    scope: z.enum(["single", "series"]).optional(),
    occurrenceStart: isoDate.optional(),
  })
  .refine(
    (data) =>
      data.endTime === undefined ||
      data.startTime === undefined ||
      new Date(data.endTime) > new Date(data.startTime),
    { message: "L'heure de fin doit être après l'heure de début", path: ["endTime"] }
  )
  .refine(
    (data) =>
      !(data.scope === "single" && data.recurrence !== undefined && data.recurrence !== null),
    {
      message: "Une occurrence détachée ne peut pas être récurrente (modifiez la série)",
      path: ["recurrence"],
    }
  )

/** Import iCal : JSON { ics: "…" } (l'upload multipart est accepté par la route). */
export const icsJsonSchema = z.object({
  ics: z.string().min(1, "Contenu iCal vide").max(1_000_000),
})

// ─────────────────────────────────────────────────────────────────────────────
// Tâches — validation riche (statuts, priorités, tags, sous-tâches)
// ─────────────────────────────────────────────────────────────────────────────

const taskStatus = z.enum(["todo", "doing", "done", "archived"], {
  message: "Statut invalide (todo | doing | done | archived)",
})
const taskPriority = z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"], {
  message: "Priorité invalide (LOW | MEDIUM | HIGH | URGENT)",
})

/** Limite de sécurité : sous-tâches par tâche. */
export const SUBTASKS_MAX = 50
/** Limite de sécurité : tags par tâche. */
export const TASK_TAGS_MAX = 10

/** Tag en entrée de création/édition de tâche : identifié par nom (upsert). */
const taskTagInput = z.object({
  name: z.string().trim().min(1, "Nom de tag requis").max(50, "Nom de tag trop long (50 max)"),
  color: hexColor.optional(),
})

const subtaskInput = z.object({
  title: z.string().trim().min(1, "Le titre de la sous-tâche est requis").max(200),
})

export const taskCreateSchema = z.object({
  title: z.string().trim().min(1, "Le titre est requis").max(200, "Titre trop long (200 max)"),
  // null accepté (champ vidé côté UI) — cohérent avec taskUpdateSchema
  description: z.string().trim().max(10000, "Description trop longue (10 000 max)").nullable().optional(),
  status: taskStatus.optional(),
  priority: taskPriority.optional(),
  dueDate: isoDate.nullable().optional(),
  tags: z.array(taskTagInput).max(TASK_TAGS_MAX, `Trop de tags (${TASK_TAGS_MAX} max par tâche)`).optional(),
  subtasks: z
    .array(subtaskInput)
    .max(SUBTASKS_MAX, `Trop de sous-tâches (${SUBTASKS_MAX} max par tâche)`)
    .optional(),
  eventId: z.string().trim().min(1).nullable().optional(),
})

export const taskUpdateSchema = z.object({
  title: z.string().trim().min(1, "Le titre est requis").max(200).optional(),
  description: z.string().trim().max(10000).nullable().optional(),
  status: taskStatus.optional(),
  priority: taskPriority.optional(),
  dueDate: isoDate.nullable().optional(),
  position: z.number().int().min(0).optional(),
  tags: z.array(taskTagInput).max(TASK_TAGS_MAX).optional(),
  subtasks: z.array(subtaskInput).max(SUBTASKS_MAX).optional(),
  eventId: z.string().trim().min(1).nullable().optional(),
  aiSuggestedPriority: taskPriority.nullable().optional(),
})

/** Déplacement Kanban : { status, position } — position = indice cible (0-based). */
export const taskMoveSchema = z.object({
  status: taskStatus,
  position: z
    .number({ message: "Position requise (indice cible)" })
    .int("Position invalide (entier attendu)")
    .min(0, "Position invalide (≥ 0)"),
})

export const subtaskCreateSchema = z.object({
  title: z.string().trim().min(1, "Le titre de la sous-tâche est requis").max(200),
})

export const subtaskUpdateSchema = z.object({
  title: z.string().trim().min(1, "Le titre de la sous-tâche est requis").max(200).optional(),
  completed: z.boolean().optional(),
  /** Indice cible dans la liste (renormalisation serveur). */
  position: z.number().int().min(0).optional(),
})

// ─────────────────────────────────────────────────────────────────────────────
// Tags — validation
// ─────────────────────────────────────────────────────────────────────────────

export const tagCreateSchema = z.object({
  name: z.string().trim().min(1, "Le nom du tag est requis").max(50, "Nom trop long (50 max)"),
  color: hexColor.default("#00D4FF"),
})

export const tagUpdateSchema = z.object({
  name: z.string().trim().min(1, "Le nom du tag est requis").max(50).optional(),
  color: hexColor.optional(),
})

export const emailPatchSchema = z.object({
  isRead: z.boolean().optional(),
  isProcessed: z.boolean().optional(),
})

export const pushSubscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
})

export const chatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(8000),
      })
    )
    .min(1)
    .max(30),
})

export const analyzeSchema = z.object({
  emailId: z.string().min(1),
})
