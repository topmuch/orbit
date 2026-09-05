"use client"

// Orbit — État de vue calendrier PUR (aucune donnée, aucun effet réseau)
// ─────────────────────────────────────────────────────────────────────────────
// viewMode + cursor + plage calculée. Semaine Lundi→Dimanche (weekStartsOn 1),
// mois = 6 semaines pleines depuis le lundi de la 1re semaine du mois,
// jour = 00:00→24:00, agenda = [début du jour du curseur, +14 jours].
// Convention des plages : [start, end) — fin EXCLUSIVE.
// Les plages sont destinées à alimenter useEventsRange() (Task 12-c).

import { useCallback, useMemo, useState } from "react"
import { addDays, addMonths, addWeeks, startOfDay, startOfMonth, startOfWeek } from "date-fns"

export type CalendarViewMode = "month" | "week" | "day" | "agenda"

const WEEK_OPTIONS = { weekStartsOn: 1 } as const

export type CalendarRange = { start: Date; end: Date }

export type UseCalendar = {
  /** Mode d'affichage courant. */
  viewMode: CalendarViewMode
  /** Date curseur (jour référent de la vue). */
  cursor: Date
  /** Plage visible [start, end) selon le mode. */
  range: CalendarRange
  setMode: (mode: CalendarViewMode) => void
  setCursor: (cursor: Date) => void
  /** Replace le curseur sur aujourd'hui. */
  goToday: () => void
  /** Recule d'un pas selon le mode (mois/semaine/jour/14 jours). */
  prev: () => void
    /** Avance d'un pas selon le mode (mois/semaine/jour/14 jours). */
  next: () => void
}

/** Décale le curseur d'un pas (±1) selon le mode d'affichage. */
function shiftCursor(cursor: Date, mode: CalendarViewMode, direction: 1 | -1): Date {
  switch (mode) {
    case "month":
      return addMonths(cursor, direction)
    case "week":
      return addWeeks(cursor, direction)
    case "day":
      return addDays(cursor, direction)
    case "agenda":
      return addDays(cursor, 14 * direction)
  }
}

export function useCalendar(initial?: {
  mode?: CalendarViewMode
  cursor?: Date
}): UseCalendar {
  const [viewMode, setMode] = useState<CalendarViewMode>(initial?.mode ?? "month")
  const [cursor, setCursor] = useState<Date>(initial?.cursor ?? new Date())

  const range = useMemo<CalendarRange>(() => {
    switch (viewMode) {
      case "week": {
        // Lundi 00:00 → lundi suivant 00:00 (dimanche inclus, fin exclusive).
        const start = startOfWeek(cursor, WEEK_OPTIONS)
        return { start, end: addDays(start, 7) }
      }
      case "month": {
        // 6 semaines pleines depuis le lundi de la semaine du 1er du mois.
        const start = startOfWeek(startOfMonth(cursor), WEEK_OPTIONS)
        return { start, end: addDays(start, 42) }
      }
      case "day": {
        // 00:00 → 24:00 (fin exclusive).
        const start = startOfDay(cursor)
        return { start, end: addDays(start, 1) }
      }
      case "agenda": {
        // Début du jour du curseur → +14 jours.
        const start = startOfDay(cursor)
        return { start, end: addDays(start, 14) }
      }
    }
  }, [viewMode, cursor])

  const goToday = useCallback(() => setCursor(new Date()), [])
  const prev = useCallback(
    () => setCursor((c) => shiftCursor(c, viewMode, -1)),
    [viewMode]
  )
  const next = useCallback(
    () => setCursor((c) => shiftCursor(c, viewMode, 1)),
    [viewMode]
  )

  return { viewMode, cursor, range, setMode, setCursor, goToday, prev, next }
}
