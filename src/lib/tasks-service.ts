// Orbit — Service tâches côté serveur : tags, positions, complétion
// ─────────────────────────────────────────────────────────────────────────────
// Point d'entrée partagé par toutes les routes tasks/* : upsert des tags par
// (userId, name), calcul de completedAt selon le statut, renormalisation des
// positions de colonne (entiers espacés), chargement avec ownership.

import { db } from "@/lib/db"
import { Prisma, type Tag, type Task } from "@prisma/client"
import { toTaskDto, type TaskWithRelations } from "@/lib/dto"
import { endPosition, normalizePositions } from "@/lib/tasks"
import type { TaskDto, TaskStatus } from "@/lib/types"
import type { z } from "zod"
import type { taskCreateSchema, taskUpdateSchema } from "@/lib/validators"

/** Include Prisma standard pour toute lecture de tâche (tags + sous-tâches). */
export const TASK_INCLUDE = { tags: true, subtasks: true } as const

/** Charge une tâche avec relations + vérification d'ownership. */
export async function loadOwnedTask(
  userId: string,
  id: string
): Promise<TaskWithRelations | null> {
  return db.task.findFirst({
    where: { id, userId },
    include: TASK_INCLUDE,
  })
}

/**
 * Upsert des tags par (userId, name) : jamais de doublon — un tag existant
 * est réutilisé (sa couleur peut être mise à jour si fournie). Retourne la
 * liste dédupliquée des tags à connecter.
 */
export async function upsertTags(
  userId: string,
  inputs: { name: string; color?: string }[]
): Promise<Tag[]> {
  // Déduplication par nom (casse préservée : la clé est insensible à la casse
  // via une comparaison normalisée)
  const byName = new Map<string, { name: string; color?: string }>()
  for (const input of inputs) {
    const key = input.name.trim().toLowerCase()
    if (!key || byName.has(key)) continue
    byName.set(key, { name: input.name.trim(), color: input.color })
  }

  const out: Tag[] = []
  for (const { name, color } of byName.values()) {
    const tag = await db.tag.upsert({
      where: { userId_name: { userId, name } },
      create: { userId, name, color: color ?? "#00D4FF" },
      // Couleur fournie → on rafraîchit le tag existant (édition à la volée)
      update: color ? { color } : {},
    })
    out.push(tag)
  }
  return out
}

/** À la CRÉATION : connecte les tags (ids seuls — nested create). */
export function tagConnect(tags: Tag[]): { tags: { connect: { id: string }[] } } {
  return { tags: { connect: tags.map((t) => ({ id: t.id })) } }
}

/** À la MISE À JOUR : remplace l'ensemble des tags connectés (ids seuls). */
export function tagSet(tags: Tag[]): { tags: { set: { id: string }[] } } {
  return { tags: { set: tags.map((t) => ({ id: t.id })) } }
}

/**
 * Règle completedAt : passage à « done » → horodatage (si pas déjà) ;
 * sortie de « done » → null. Statistiques de complétion hebdomadaire.
 */
export function completedAtValue(
  current: { status: string; completedAt: Date | null },
  nextStatus: TaskStatus | undefined
): Date | null | undefined {
  if (nextStatus === undefined) return undefined // pas de changement de statut
  if (nextStatus === "done") return current.completedAt ?? new Date()
  // Sortie de « done » (nextStatus ≠ done ici) → reset
  if (current.status === "done") return null
  return undefined
}

/**
 * Position d'un nouvel ajout en fin de colonne (max + 1000).
 */
export async function nextEndPosition(userId: string, status: TaskStatus): Promise<number> {
  const last = await db.task.findFirst({
    where: { userId, status },
    orderBy: { position: "desc" },
    select: { position: true },
  })
  return last ? last.position + 1000 : 0
}

/**
 * Renormalise TOUTE une colonne après un déplacement : positions propres
 * 1000, 2000, 3000… dans une transaction. Retourne la liste ordonnée.
 * `movingId`/`targetIndex` : insère la tâche déplacée à l'indice demandé.
 */
export async function moveTaskWithinColumn(
  userId: string,
  task: Task,
  targetStatus: TaskStatus,
  targetIndex: number
): Promise<TaskWithRelations> {
  const result = await db.$transaction(async (tx) => {
    // Liste courante de la colonne cible, sans la tâche déplacée
    const others = await tx.task.findMany({
      where: { userId, status: targetStatus, id: { not: task.id } },
      orderBy: { position: "asc" },
      select: { id: true },
    })
    const ids = others.map((o) => o.id)
    const index = Math.max(0, Math.min(targetIndex, ids.length))
    ids.splice(index, 0, task.id)

    // Renormalisation complète (entiers espacés, atomique)
    for (const { id, position } of normalizePositions(ids)) {
      await tx.task.update({
        where: { id },
        data: {
          position,
          ...(id === task.id
            ? {
                status: targetStatus,
                completedAt: completedAtValue(task, targetStatus) ?? null,
              }
            : {}),
        },
      })
    }

    return tx.task.findUniqueOrThrow({
      where: { id: task.id },
      include: TASK_INCLUDE,
    })
  })
  return result
}

/**
 * Création transactionnelle : tâche + tags (upsert) + sous-tâches.
 * Position = fin de colonne. Retourne la tâche avec relations.
 */
export async function createTaskWithRelations(
  userId: string,
  input: z.infer<typeof taskCreateSchema>
): Promise<TaskWithRelations> {
  const status: TaskStatus = input.status ?? "todo"
  const position = await nextEndPosition(userId, status)
  const tags = input.tags?.length ? await upsertTags(userId, input.tags) : []

  return db.task.create({
    data: {
      userId,
      title: input.title,
      description: input.description || null,
      status,
      priority: input.priority ?? "MEDIUM",
      position,
      dueDate: input.dueDate ? new Date(input.dueDate) : null,
      completedAt: status === "done" ? new Date() : null,
      eventId: input.eventId || null,
      ...(tags.length ? tagConnect(tags) : {}),
      ...(input.subtasks?.length
        ? {
            subtasks: {
              create: input.subtasks.map((s, i) => ({
                title: s.title,
                position: (i + 1) * 1000,
              })),
            },
          }
        : {}),
    },
    include: TASK_INCLUDE,
  })
}

/**
 * Mise à jour : champs scalaires + remplacement éventuel des tags/sous-tâches.
 * Tableaux fournis = remplacement complet (sémantique « put » des collections).
 */
export async function updateTaskWithRelations(
  task: Task,
  input: z.infer<typeof taskUpdateSchema>
): Promise<TaskWithRelations> {
  const completedAt = completedAtValue(task, input.status)

  // Tags fournis → upsert + remplacement de l'ensemble connecté
  const tags = input.tags ? await upsertTags(task.userId, input.tags) : null

  // Sous-tâches fournies → remplacement complet (les id ne sont pas conservés :
  // sémantique « set », conforme au contrat TaskUpdateInput du frontend)
  const subtasksInput = input.subtasks
    ? {
        deleteMany: {},
        create: input.subtasks.map((s, i) => ({
          title: s.title,
          position: (i + 1) * 1000,
        })),
      }
    : undefined

  return db.task.update({
    where: { id: task.id },
    data: {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.priority !== undefined ? { priority: input.priority } : {}),
      ...(input.dueDate !== undefined
        ? { dueDate: input.dueDate ? new Date(input.dueDate) : null }
        : {}),
      ...(input.position !== undefined ? { position: input.position } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
      ...(input.eventId !== undefined ? { eventId: input.eventId || null } : {}),
      ...(input.aiSuggestedPriority !== undefined
        ? { aiSuggestedPriority: input.aiSuggestedPriority ?? null }
        : {}),
      ...(tags !== null ? tagSet(tags) : {}),
      ...(subtasksInput !== undefined ? { subtasks: subtasksInput } : {}),
    },
    include: TASK_INCLUDE,
  })
}

/** Requête de listage standard (inclut relations). */
export function listTasks(userId: string, where: Prisma.TaskWhereInput) {
  return db.task.findMany({ where: { ...where, userId }, include: TASK_INCLUDE })
}

/** DTO avec relations. */
export function taskDto(task: TaskWithRelations): TaskDto {
  return toTaskDto(task)
}
