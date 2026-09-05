// Orbit — Helpers dates d'échéance (tâches)
// ─────────────────────────────────────────────────────────────────────────────
// Libellés humains FR : « Aujourd'hui · 18:00 », « Demain », « Dans 3 jours »,
// « En retard de 2 jours »… Détection « en retard » (< maintenant) et
// « imminent » (< 24 h) pour les alertes visuelles.

import { differenceInCalendarDays, format } from "date-fns"
import { fr } from "date-fns/locale"

/** État visuel d'une échéance. */
export type DueState = "overdue" | "today" | "soon" | "later" | "none"

const MS_PER_DAY = 86_400_000

/** Jour calendaire local de l'instant (minuit). */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Nombre de jours calendaires entre deux instants (négatif = passé). */
function calendarDays(from: Date, to: Date): number {
  return differenceInCalendarDays(startOfDay(to), startOfDay(from))
}

/**
 * Classe une échéance : overdue (passée + non terminée), today, soon (< 24 h),
 * later, none. `done` exclut l'état overdue (une tâche terminée n'est plus
 * « en retard »).
 */
export function dueState(
  due: string | Date | null | undefined,
  opts: { completed?: boolean } = {},
  now: Date = new Date()
): DueState {
  if (due === null || due === undefined) return "none"
  const date = typeof due === "string" ? new Date(due) : due
  if (Number.isNaN(date.getTime())) return "none"
  if (!opts.completed && date.getTime() < now.getTime()) return "overdue"
  const days = calendarDays(now, date)
  if (days === 0) return date.getTime() < now.getTime() && opts.completed ? "today" : "today"
  if (days > 0 && date.getTime() - now.getTime() < MS_PER_DAY) return "soon"
  return "later"
}

/** Couleurs d'alerte selon l'état (noms de classes Tailwind). */
export const DUE_STATE_CLASSES: Record<DueState, string> = {
  overdue: "text-red-500",
  today: "text-orange-500",
  soon: "text-orange-500",
  later: "text-muted-foreground",
  none: "text-muted-foreground",
}

/** Couleur hex brute selon l'état (bordures de cartes, jauges). */
export const DUE_STATE_HEX: Record<DueState, string | null> = {
  overdue: "#EF4444",
  today: "#F97316",
  soon: "#F97316",
  later: null,
  none: null,
}

/**
 * Libellé humain d'une échéance :
 * « En retard de 2 jours », « Aujourd'hui · 18:00 », « Hier · 09:00 »,
 * « Demain · 09:00 », « Dans 3 jours · 14:30 », « 12 sept. · 08:00 »…
 * `completed` : tâche terminée → formulation neutre pour une date passée
 * (« Il y a 2 jours ») — une tâche terminée n'est plus « en retard ».
 */
export function formatDueDate(
  due: string | Date | null | undefined,
  opts: { completed?: boolean } = {}
): string {
  if (due === null || due === undefined) return ""
  const date = typeof due === "string" ? new Date(due) : due
  if (Number.isNaN(date.getTime())) return ""

  const now = new Date()
  const days = calendarDays(now, date)
  const time = format(date, "HH:mm")

  if (days === 0) {
    const late = date.getTime() < now.getTime()
    return late ? `Aujourd'hui (passé) · ${time}` : `Aujourd'hui · ${time}`
  }
  if (days === 1) return `Demain · ${time}`
  if (days === -1) return `Hier · ${time}`
  if (days < 0) {
    if (opts.completed) {
      return days === -1 ? `Hier · ${time}` : `Il y a ${Math.abs(days)} jours · ${time}`
    }
    return `En retard de ${Math.abs(days)} j · ${time}`
  }
  if (days <= 7) return `Dans ${days} jours · ${time}`
  return `${format(date, "d MMM", { locale: fr })} · ${time}`
}

/** Libellé long (title/aria) : « mardi 12 septembre 2026 à 18:00 ». */
export function formatDueDateLong(due: string | Date | null | undefined): string {
  if (due === null || due === undefined) return ""
  const date = typeof due === "string" ? new Date(due) : due
  if (Number.isNaN(date.getTime())) return ""
  return format(date, "EEEE d MMMM yyyy 'à' HH:mm", { locale: fr })
}

/** Titre de statut a11y : « Échéance dépassée » quand en retard. */
export function dueStateLabel(state: DueState): string | null {
  switch (state) {
    case "overdue":
      return "Échéance dépassée"
    case "today":
      return "Échéance aujourd'hui"
    case "soon":
      return "Échéance imminente (moins de 24 h)"
    default:
      return null
  }
}
