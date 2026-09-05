"use client";

// Orbit — DueDateBadge : échéance de tâche (libellé humain + couleur d'état).
// ─────────────────────────────────────────────────────────────────────────────
// Utilise exclusivement lib/dates : « Aujourd'hui · 18:00 », « Demain · 09:00 »,
// « En retard de 2 j »… Couleur : rouge (retard) / orange (< 24 h ou aujourd'hui)
// / neutre. `completed` neutralise l'état « en retard » (une tâche terminée
// n'est plus en retard). Pas d'échéance → rien n'est rendu.

import { CalendarClock } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  DUE_STATE_CLASSES,
  dueState,
  dueStateLabel,
  formatDueDate,
  formatDueDateLong,
} from "@/lib/dates"

function DueDateBadge({
  due,
  completed,
  className,
}: {
  /** ISO UTC (dueDate du TaskDto). */
  due: string | null
  /** true si la tâche parente est terminée/archivée. */
  completed?: boolean
  className?: string
}) {
  if (due === null) return null

  const state = dueState(due, { completed })
  const short = formatDueDate(due, { completed })
  const long = formatDueDateLong(due)
  const stateLabel = dueStateLabel(state)
  if (!short) return null

  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 text-xs font-medium tabular-nums",
        DUE_STATE_CLASSES[state],
        className
      )}
      title={[long, stateLabel].filter(Boolean).join(" — ")}
    >
      <CalendarClock className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{short}</span>
      <span className="sr-only">
        Échéance : {long}
        {stateLabel ? `, ${stateLabel.toLowerCase()}` : ""}
      </span>
    </span>
  )
}

export { DueDateBadge }
