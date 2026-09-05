// Orbit — Validation Zod des entrées API

import { z } from "zod"

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

export const eventCreateSchema = z.object({
  title: z.string().trim().min(2, "Titre requis").max(120),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  startTime: isoDate,
  endTime: isoDate,
  source: z.enum(["manual", "email_extract", "ai"]).optional(),
})

export const eventUpdateSchema = z.object({
  title: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  startTime: isoDate.optional(),
  endTime: isoDate.optional(),
})

export const taskCreateSchema = z.object({
  title: z.string().trim().min(2, "Titre requis").max(120),
  description: z.string().trim().max(2000).optional().or(z.literal("")),
  status: z.enum(["todo", "doing", "done"]).optional(),
  priority: z.number().int().min(0).max(2).optional(),
  dueDate: isoDate.nullable().optional(),
})

export const taskUpdateSchema = z.object({
  title: z.string().trim().min(2).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(["todo", "doing", "done"]).optional(),
  priority: z.number().int().min(0).max(2).optional(),
  dueDate: isoDate.nullable().optional(),
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
