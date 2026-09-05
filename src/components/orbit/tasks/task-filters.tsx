"use client";

// Orbit — TaskFilters : barre de filtres/recherche des tâches (Kanban + Liste).
// ─────────────────────────────────────────────────────────────────────────────
// Filtrage 100 % CÔTÉ CLIENT sur les tâches chargées (volume personnel) :
// réaction instantanée à la frappe, aucun aller-retour serveur. Le serveur
// expose les mêmes critères en query params, mais on n'y recourt pas ici.
// Composants : Input+Search, Popover Statut/Priorité (checkboxes), Select Tag
// et Échéance, Badge compteur de filtres actifs + bouton reset.

import { ChevronDown, Search, SlidersHorizontal, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  foldText,
  isTaskOverdue,
} from "@/lib/tasks"
import type { TagWithCount } from "@/lib/api-client"
import type { TaskDto, TaskPriority, TaskStatus } from "@/lib/types"
import { PRIORITY_COLORS } from "@/components/orbit/tasks/priority-badge"

// ─────────────────────────────────────────────────────────────────────────────
// État de filtres + filtrage pur
// ─────────────────────────────────────────────────────────────────────────────

/** Filtres d'échéance (libellés FR dans DUE_OPTIONS). */
export type TaskDueFilter = "all" | "today" | "week" | "overdue" | "none"

/** État complet des filtres de la vue Tâches. */
export type TaskFilterState = {
  search: string
  /** Vide = tous les statuts. */
  statuses: TaskStatus[]
  /** Vide = toutes les priorités. */
  priorities: TaskPriority[]
  /** Nom du tag (null = tous). */
  tag: string | null
  due: TaskDueFilter
}

export const EMPTY_TASK_FILTERS: TaskFilterState = {
  search: "",
  statuses: [],
  priorities: [],
  tag: null,
  due: "all",
}

const MS_PER_DAY = 86_400_000

/** Indique si l'échéance tombe « aujourd'hui » (jour calendaire local). */
function isDueToday(due: string): boolean {
  const d = new Date(due)
  const now = new Date()
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  )
}

/** Applique tous les filtres à une liste de tâches (ordre conservé). */
export function filterTasks(tasks: TaskDto[], filters: TaskFilterState): TaskDto[] {
  const query = foldText(filters.search.trim())
  return tasks.filter((task) => {
    if (filters.statuses.length > 0 && !filters.statuses.includes(task.status)) {
      return false
    }
    if (filters.priorities.length > 0 && !filters.priorities.includes(task.priority)) {
      return false
    }
    if (filters.tag !== null && !task.tags.some((t) => t.name === filters.tag)) {
      return false
    }
    switch (filters.due) {
      case "today":
        if (task.dueDate === null || !isDueToday(task.dueDate)) return false
        break
      case "week":
        if (
          task.dueDate === null ||
          new Date(task.dueDate).getTime() - Date.now() > 7 * MS_PER_DAY
        ) {
          return false
        }
        break
      case "overdue":
        if (!isTaskOverdue(task)) return false
        break
      case "none":
        if (task.dueDate !== null) return false
        break
      case "all":
      default:
        break
    }
    if (query) {
      const haystack =
        foldText(task.title) +
        " " +
        foldText(task.description ?? "") +
        " " +
        task.tags.map((t) => foldText(t.name)).join(" ")
      if (!haystack.includes(query)) return false
    }
    return true
  })
}

/** Nombre de catégories actives (recherche, statut, priorité, tag, échéance). */
export function countActiveFilters(filters: TaskFilterState): number {
  let count = 0
  if (filters.search.trim() !== "") count += 1
  if (filters.statuses.length > 0) count += 1
  if (filters.priorities.length > 0) count += 1
  if (filters.tag !== null) count += 1
  if (filters.due !== "all") count += 1
  return count
}

// ─────────────────────────────────────────────────────────────────────────────
// Composants d'affichage
// ─────────────────────────────────────────────────────────────────────────────

const DUE_OPTIONS: { value: TaskDueFilter; label: string }[] = [
  { value: "all", label: "Toutes échéances" },
  { value: "today", label: "Aujourd'hui" },
  { value: "week", label: "Cette semaine" },
  { value: "overdue", label: "En retard" },
  { value: "none", label: "Sans échéance" },
]

/** Petit trigger de Popover avec libellé + compte (aspect « bouton filtre »). */
function FilterTriggerButton({
  label,
  count,
  active,
  className,
}: {
  label: string
  count?: number
  active: boolean
  className?: string
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn(
        "h-9 gap-1.5 px-3 font-medium",
        active && "border-primary/50 bg-primary/10 text-primary",
        className
      )}
    >
      {label}
      {count ? <Badge className="px-1.5 text-[10px] tabular-nums">{count}</Badge> : null}
      <ChevronDown className="size-3.5 opacity-60" aria-hidden="true" />
    </Button>
  )
}

/**
 * Barre de filtres complète (recherche incluse). Contrôlée : le parent porte
 * l'état (partagé entre Kanban et vue liste) et reçoit les changements.
 */
function TaskFilters({
  value,
  onChange,
  tags,
  className,
}: {
  value: TaskFilterState
  onChange: (next: TaskFilterState) => void
  /** Tags disponibles (pour le Select — passés par le parent via useTags). */
  tags: TagWithCount[]
  className?: string
}) {
  const activeCount = countActiveFilters(value)
  const patch = (partial: Partial<TaskFilterState>) => onChange({ ...value, ...partial })

  const toggleStatus = (status: TaskStatus, checked: boolean) => {
    const set = new Set(value.statuses)
    if (checked) set.add(status)
    else set.delete(status)
    patch({ statuses: [...set] })
  }

  const togglePriority = (priority: TaskPriority, checked: boolean) => {
    const set = new Set(value.priorities)
    if (checked) set.add(priority)
    else set.delete(priority)
    patch({ priorities: [...set] })
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      {/* Recherche instantanée (titre, description, tags — insensible aux accents) */}
      <div className="relative w-full sm:w-auto sm:min-w-48 sm:flex-1 sm:max-w-xs">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          type="search"
          value={value.search}
          onChange={(e) => patch({ search: e.target.value })}
          placeholder="Rechercher une tâche…"
          className="h-9 pl-9"
          aria-label="Rechercher une tâche par titre, description ou tag"
        />
      </div>

      {/* Popover Statut */}
      <Popover>
        <PopoverTrigger asChild>
          <div>
            <FilterTriggerButton
              label="Statut"
              count={value.statuses.length || undefined}
              active={value.statuses.length > 0}
            />
          </div>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-44 p-1">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            Filtrer par statut
          </div>
          {TASK_STATUSES.map((status) => (
            <Label
              key={status}
              htmlFor={`filter-status-${status}`}
              className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm font-normal transition-colors hover:bg-accent"
            >
              <Checkbox
                id={`filter-status-${status}`}
                checked={value.statuses.includes(status)}
                onCheckedChange={(checked) => toggleStatus(status, checked === true)}
              />
              {TASK_STATUS_LABELS[status]}
            </Label>
          ))}
        </PopoverContent>
      </Popover>

      {/* Popover Priorité */}
      <Popover>
        <PopoverTrigger asChild>
          <div>
            <FilterTriggerButton
              label="Priorité"
              count={value.priorities.length || undefined}
              active={value.priorities.length > 0}
            />
          </div>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-44 p-1">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            Filtrer par priorité
          </div>
          {TASK_PRIORITIES.map((priority) => (
            <Label
              key={priority}
              htmlFor={`filter-priority-${priority}`}
              className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm font-normal transition-colors hover:bg-accent"
            >
              <Checkbox
                id={`filter-priority-${priority}`}
                checked={value.priorities.includes(priority)}
                onCheckedChange={(checked) => togglePriority(priority, checked === true)}
              />
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: PRIORITY_COLORS[priority] }}
                aria-hidden="true"
              />
              {TASK_PRIORITY_LABELS[priority]}
            </Label>
          ))}
        </PopoverContent>
      </Popover>

      {/* Select Tag */}
      <Select
        value={value.tag ?? "__all__"}
        onValueChange={(v) => patch({ tag: v === "__all__" ? null : v })}
      >
        <SelectTrigger
          className="h-9 w-auto gap-1.5 font-medium data-[placeholder]:text-foreground"
          aria-label="Filtrer par tag"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">Tous les tags</SelectItem>
          {tags.map((tag) => (
            <SelectItem key={tag.id} value={tag.name}>
              <span className="flex items-center gap-2">
                <span
                  className="size-2 rounded-full"
                  style={{ backgroundColor: tag.color }}
                  aria-hidden="true"
                />
                {tag.name}
                <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">
                  {tag.taskCount}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Select Échéance */}
      <Select value={value.due} onValueChange={(v) => patch({ due: v as TaskDueFilter })}>
        <SelectTrigger className="h-9 w-auto gap-1.5 font-medium" aria-label="Filtrer par échéance">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DUE_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Compteur + reset (visible dès qu'un filtre actif) */}
      {activeCount > 0 ? (
        <div
          className="flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs text-primary"
          role="status"
        >
          <SlidersHorizontal className="size-3" aria-hidden="true" />
          <span className="tabular-nums">
            {activeCount} filtre{activeCount > 1 ? "s" : ""} actif{activeCount > 1 ? "s" : ""}
          </span>
          <button
            type="button"
            onClick={() => onChange(EMPTY_TASK_FILTERS)}
            className="ml-0.5 inline-flex size-6 items-center justify-center rounded-full transition-colors hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Réinitialiser tous les filtres"
          >
            <X className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      ) : null}
    </div>
  )
}

export { TaskFilters }
