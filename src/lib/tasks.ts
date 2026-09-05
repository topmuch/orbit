// Orbit — Helpers tâches (contrats partagés client/serveur)
// ─────────────────────────────────────────────────────────────────────────────
// Statuts kanban, priorités, poids de tri, calcul de positions espacées,
// progression des sous-tâches. Aucune dépendance — utilisable partout.

import type { TaskDto, TaskPriority, TaskStatus } from "@/lib/types"

// ─────────────────────────────────────────────────────────────────────────────
// Statuts & priorités
// ─────────────────────────────────────────────────────────────────────────────

/** Statuts du Kanban — « archived » = soft delete (masqué par défaut). */
export const TASK_STATUSES: TaskStatus[] = ["todo", "doing", "done", "archived"]

/** Colonnes visibles par défaut dans le Kanban (archivé exclu). */
export const ACTIVE_TASK_STATUSES: TaskStatus[] = ["todo", "doing", "done"]

/** Priorités par poids croissant (LOW = 0 … URGENT = 3). */
export const TASK_PRIORITIES: TaskPriority[] = ["LOW", "MEDIUM", "HIGH", "URGENT"]

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  URGENT: 3,
}

/** Poids de priorité (tri décroissant = URGENT d'abord) ; valeur inconnue → MEDIUM. */
export function priorityWeight(priority: string | null | undefined): number {
  const p = (priority ?? "MEDIUM") as TaskPriority
  return PRIORITY_WEIGHT[p] ?? PRIORITY_WEIGHT.MEDIUM
}

/** Libellés FR des statuts. */
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  todo: "À faire",
  doing: "En cours",
  done: "Terminé",
  archived: "Archivé",
}

/** Libellés FR des priorités. */
export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
  LOW: "Basse",
  MEDIUM: "Moyenne",
  HIGH: "Haute",
  URGENT: "Urgente",
}

/** Libellés FR des statuts de sous-tâche (OK / KO). */
export const SUBTASK_DEFAULT_COLOR = "#00D4FF"

// ─────────────────────────────────────────────────────────────────────────────
// Positions espacées (convention 1000, 2000, 3000…)
// ─────────────────────────────────────────────────────────────────────────────

/** Pas d'espacement entre positions consécutives. */
export const POSITION_STEP = 1000

/**
 * Position pour un ajout en FIN de colonne/liste.
 * 0 si la liste est vide ; sinon max(position) + POSITION_STEP.
 */
export function endPosition(positions: number[]): number {
  return positions.length ? Math.max(...positions) + POSITION_STEP : 0
}

/**
 * Position d'insertion entre deux voisins (entiers espacés).
 * - après `above` uniquement : above + POSITION_STEP
 * - avant `below` uniquement : below - POSITION_STEP
 * - entre les deux : moyenne ; si l'écart est épuisé (< 2), renvoie null
 *   → l'appelant doit renormaliser toute la liste (voir normalizePositions).
 */
export function insertPosition(above: number | null, below: number | null): number | null {
  if (above === null && below === null) return 0
  if (above === null) return (below as number) - POSITION_STEP
  if (below === null) return above + POSITION_STEP
  if (below - above > 1) return Math.floor((above + below) / 2)
  return null // espace épuisé → renormaliser
}

/**
 * Renormalise une liste ordonnée en positions espacées propres :
 * [1000, 2000, 3000…]. Retourne les paires {id, position} à persister.
 */
export function normalizePositions(ids: string[]): { id: string; position: number }[] {
  return ids.map((id, index) => ({ id, position: (index + 1) * POSITION_STEP }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Sous-tâches : progression
// ─────────────────────────────────────────────────────────────────────────────

/** Progression des sous-tâches : {done, total, percent}. */
export function subtaskProgress(task: Pick<TaskDto, "subtasks">) {
  const total = task.subtasks.length
  const done = task.subtasks.filter((s) => s.completed).length
  return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tri & filtres (vue liste)
// ─────────────────────────────────────────────────────────────────────────────

export type TaskSortField = "position" | "dueDate" | "priority" | "createdAt" | "title"
export type SortOrder = "asc" | "desc"

/** Comparateur générique d'une liste de tâches. */
export function sortTasks(
  tasks: TaskDto[],
  sortBy: TaskSortField,
  order: SortOrder = "asc"
): TaskDto[] {
  const dir = order === "desc" ? -1 : 1
  const sorted = [...tasks].sort((a, b) => {
    switch (sortBy) {
      case "dueDate": {
        const aDue = a.dueDate ? new Date(a.dueDate).getTime() : Infinity
        const bDue = b.dueDate ? new Date(b.dueDate).getTime() : Infinity
        return (aDue - bDue) * dir
      }
      case "priority":
        return (priorityWeight(a.priority) - priorityWeight(b.priority)) * dir
      case "title":
        return a.title.localeCompare(b.title, "fr") * dir
      case "createdAt":
        return (new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()) * dir
      case "position":
      default: {
        if (a.status !== b.status) return a.status.localeCompare(b.status) * dir
        return (a.position - b.position) * dir
      }
    }
  })
  return sorted
}

/** Recherche insensible à la casse et aux accents (É → e). */
export function foldText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
}

/** true si la tâche est en retard (échéance passée, non terminée, non archivée). */
export function isTaskOverdue(task: Pick<TaskDto, "dueDate" | "status">, now = new Date()): boolean {
  return (
    task.status !== "done" &&
    task.status !== "archived" &&
    task.dueDate !== null &&
    new Date(task.dueDate).getTime() < now.getTime()
  )
}
