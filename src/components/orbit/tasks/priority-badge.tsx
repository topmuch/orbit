"use client";

// Orbit — PriorityBadge : priorité de tâche (LOW/MEDIUM/HIGH/URGENT).
// ─────────────────────────────────────────────────────────────────────────────
// Palette explicite demandée par l'utilisateur (points colorés, hex bruts) :
//   Basse #22C55E · Moyenne #3B82F6 · Haute #F97316 · Urgente #EF4444
// Le point URGENT pulse (animate-pulse) pour capter l'œil.
// Exporte aussi PRIORITY_COLORS (hex) pour les bordures de cartes Kanban.

import { cn } from "@/lib/utils";
import { TASK_PRIORITY_LABELS } from "@/lib/tasks";
import type { TaskPriority } from "@/lib/types";

/** Couleurs hex des priorités (spec utilisateur — ne pas dériver du thème). */
export const PRIORITY_COLORS: Record<TaskPriority, string> = {
  LOW: "#22C55E",
  MEDIUM: "#3B82F6",
  HIGH: "#F97316",
  URGENT: "#EF4444",
};

/** Style inline de la bordure gauche d'une carte Kanban (4px priorité). */
export function priorityBorderStyle(priority: TaskPriority): React.CSSProperties {
  return { borderLeftColor: PRIORITY_COLORS[priority] };
}

/** Priorité inconnue → repli neutre silencieux (données défensives). */
const FALLBACK_COLOR = "#9CA3AF";

function PriorityBadge({
  priority,
  size = "md",
  className,
  title,
}: {
  priority: TaskPriority
  /** sm = texte compact (cartes Kanban) · md = vue liste. */
  size?: "sm" | "md"
  className?: string
  /** title par défaut : « Priorité : Haute ». */
  title?: string
}) {
  const color = PRIORITY_COLORS[priority] ?? FALLBACK_COLOR;
  const label = TASK_PRIORITY_LABELS[priority] ?? "Priorité";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 font-medium",
        size === "sm" ? "text-[11px]" : "text-xs",
        className
      )}
      title={title ?? `Priorité : ${label}`}
    >
      {/* Point coloré — pulse pour URGENT (spec) */}
      <span
        className={cn("size-2 shrink-0 rounded-full", priority === "URGENT" && "animate-pulse")}
        style={{ backgroundColor: color }}
        aria-hidden="true"
      />
      <span className="text-muted-foreground">{label}</span>
      <span className="sr-only">Priorité {label.toLowerCase()}</span>
    </span>
  );
}

export { PriorityBadge }
