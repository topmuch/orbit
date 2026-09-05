"use client";

// Orbit — TaskCard : carte de tâche (Kanban) — visuel + wrapper sortable.
// ─────────────────────────────────────────────────────────────────────────────
// Carte : bordure gauche 4px colorée par priorité, titre (barré si terminée),
// description tronquée, badges de tags (max 3 + « +N »), PriorityBadge,
// DueDateBadge (couleur d'état), progression des sous-tâches, indicateur IA,
// lien calendrier (eventId), menu contextuel (modifier / déplacer / archiver /
// supprimer), poignée GripVertical. Clic simple (seuil 6px = drag) → édition.
// `overlay` : version rendue dans le DragOverlay (rotate-2, sans interactions).

import { useRef } from "react"
import type {
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react"
import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from "@dnd-kit/core"
import { useSortable } from "@dnd-kit/sortable"
import {
  Archive,
  ArchiveRestore,
  Bot,
  CalendarDays,
  CheckCircle2,
  Circle,
  GripVertical,
  MoreVertical,
  Pencil,
  Timer,
  Trash2,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import { TASK_STATUSES, TASK_STATUS_LABELS, subtaskProgress } from "@/lib/tasks"
import type { TaskDto, TaskStatus } from "@/lib/types"
import {
  PriorityBadge,
  priorityBorderStyle,
} from "@/components/orbit/tasks/priority-badge"
import { DueDateBadge } from "@/components/orbit/tasks/due-date-badge"

/** Seuil (px) au-delà duquel un pointerdown+click est considéré comme un drag. */
const DRAG_CLICK_THRESHOLD = 6

/** Élargit la zone cliquable des petits boutons (~44px) sans gonfler le design. */
const HIT_AREA =
  "relative before:absolute before:-inset-2 before:rounded-md before:content-['']"

/** Icônes des statuts pour le menu « Déplacer vers ». */
const STATUS_ICONS: Record<TaskStatus, React.ElementType> = {
  todo: Circle,
  doing: Timer,
  done: CheckCircle2,
  archived: Archive,
}

// ─────────────────────────────────────────────────────────────────────────────
// Actions transmises à la vue (orchestrateur)
// ─────────────────────────────────────────────────────────────────────────────

export type TaskCardActions = {
  onEdit?: (task: TaskDto) => void
  /** Menu « Déplacer vers » — la vue/board calcule l'indice cible. */
  onMoveTo?: (task: TaskDto, status: TaskStatus) => void
  /** Archiver (active) / Désarchiver (archivée). */
  onArchiveToggle?: (task: TaskDto) => void
  onDelete?: (task: TaskDto) => void
}

type TaskCardContentProps = TaskCardActions & {
  task: TaskDto
  /** Attributs/listeners dnd-kit — absents pour la version DragOverlay. */
  attributes?: DraggableAttributes
  listeners?: DraggableSyntheticListeners
  overlay?: boolean
  /** Titre de l'événement lié (tooltip du lien calendrier), si résolu. */
  eventTitle?: string | null
}

/** Rendu visuel d'une carte (utilisé en place et dans le DragOverlay). */
export function TaskCardContent({
  task,
  attributes,
  listeners,
  overlay = false,
  eventTitle,
  onEdit,
  onMoveTo,
  onArchiveToggle,
  onDelete,
}: TaskCardContentProps) {
  const interactive = !overlay
  const pointerDown = useRef<{ x: number; y: number } | null>(null)

  const completed = task.status === "done" || task.status === "archived"
  const progress = subtaskProgress(task)
  const visibleTags = task.tags.slice(0, 3)
  const hiddenTags = task.tags.length - visibleTags.length

  /** Enregistre le point de départ puis transmet le pointerdown à dnd-kit. */
  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointerDown.current = { x: event.clientX, y: event.clientY }
    listeners?.onPointerDown?.(event)
  }

  /** Ouvre l'édition au clic simple, mais ignore les clics issus d'un drag. */
  const handleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const origin = pointerDown.current
    pointerDown.current = null
    if (
      origin &&
      (Math.abs(event.clientX - origin.x) > DRAG_CLICK_THRESHOLD ||
        Math.abs(event.clientY - origin.y) > DRAG_CLICK_THRESHOLD)
    ) {
      return // il s'agissait d'un déplacement, pas d'un clic
    }
    onEdit?.(task)
  }

  return (
    <div
      {...(interactive ? attributes : undefined)}
      {...(interactive ? listeners : undefined)}
      onPointerDown={interactive ? handlePointerDown : undefined}
      onClick={interactive ? handleClick : undefined}
      style={interactive ? priorityBorderStyle(task.priority) : undefined}
      className={cn(
        "relative rounded-lg border border-l-4 border-border/70 bg-card p-3 text-left shadow-xs transition-[border-color,box-shadow,opacity,transform] duration-200",
        interactive
          ? "cursor-grab select-none hover:border-primary/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
          : "pointer-events-none cursor-grabbing rotate-2 scale-[1.02] border-primary/60 shadow-2xl shadow-black/40",
        completed && "opacity-80"
      )}
    >
      {/* Ligne 1 : titre + menu contextuel */}
      <div className="flex items-start gap-1.5">
        <span
          className={cn(
            "min-w-0 flex-1 text-sm font-medium leading-snug",
            completed && "text-muted-foreground line-through decoration-muted-foreground/60"
          )}
        >
          {task.title}
        </span>

        {interactive ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  HIT_AREA,
                  "-m-1 size-8 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
                onClick={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                aria-label={`Actions pour la tâche « ${task.title} »`}
              >
                <MoreVertical className="size-4" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={() => onEdit?.(task)}>
                <Pencil className="size-4" aria-hidden="true" />
                Modifier
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Déplacer vers</DropdownMenuLabel>
              {TASK_STATUSES.map((status) => {
                const MoveIcon = STATUS_ICONS[status]
                return (
                  <DropdownMenuItem
                    key={status}
                    disabled={status === task.status}
                    onClick={() => onMoveTo?.(task, status)}
                  >
                    <MoveIcon
                      className={cn(
                        "size-4",
                        status === "todo" && "text-blue-500",
                        status === "doing" && "text-orange-500",
                        status === "done" && "text-emerald-500",
                        status === "archived" && "text-muted-foreground"
                      )}
                      aria-hidden="true"
                    />
                    {TASK_STATUS_LABELS[status]}
                    {status === task.status ? (
                      <span className="ml-auto text-[10px] text-muted-foreground">
                        actuelle
                      </span>
                    ) : null}
                  </DropdownMenuItem>
                )
              })}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onArchiveToggle?.(task)}>
                {task.status === "archived" ? (
                  <>
                    <ArchiveRestore className="size-4" aria-hidden="true" />
                    Désarchiver
                  </>
                ) : (
                  <>
                    <Archive className="size-4" aria-hidden="true" />
                    Archiver
                  </>
                )}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onClick={() => onDelete?.(task)}
              >
                <Trash2 className="size-4" aria-hidden="true" />
                Supprimer
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>

      {/* Description tronquée sur une ligne */}
      {task.description ? (
        <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">
          {task.description}
        </p>
      ) : null}

      {/* Badges de tags (max 3 visibles + « +N ») */}
      {task.tags.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          {visibleTags.map((tag) => (
            <Badge
              key={tag.id}
              variant="outline"
              className="gap-1 border-transparent px-1.5 text-[10px] font-medium"
              style={{ backgroundColor: `${tag.color}22`, color: tag.color }}
              title={`Tag : ${tag.name}`}
            >
              <span
                className="size-1.5 rounded-full"
                style={{ backgroundColor: tag.color }}
                aria-hidden="true"
              />
              {tag.name}
            </Badge>
          ))}
          {hiddenTags > 0 ? (
            <span
              className="text-[10px] font-medium text-muted-foreground"
              title={`${hiddenTags} autre(s) tag(s) : ${task.tags.slice(3).map((t) => t.name).join(", ")}`}
            >
              +{hiddenTags}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Méta : priorité, échéance, IA, lien calendrier, poignée */}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <PriorityBadge priority={task.priority} size="sm" />

        <DueDateBadge due={task.dueDate} completed={completed} />

        {task.aiSuggestedPriority ? (
          <Badge
            variant="outline"
            className="gap-1 border-violet-500/40 bg-violet-500/10 px-1.5 text-[10px] font-medium text-violet-500 dark:text-violet-400"
            title="Priorité suggérée par l'IA — ouvrez la tâche pour l'appliquer"
          >
            <Bot className="size-3" aria-hidden="true" />
            IA
          </Badge>
        ) : null}

        {task.eventId ? (
          <span
            className="inline-flex items-center gap-1 text-xs text-muted-foreground"
            title={
              eventTitle
                ? `Liée à l'événement « ${eventTitle} »`
                : "Tâche liée à un événement du calendrier"
            }
          >
            <CalendarDays className="size-3.5" aria-hidden="true" />
            <span className="sr-only">
              {eventTitle
                ? `Liée à l'événement « ${eventTitle} »`
                : "Liée à un événement du calendrier"}
            </span>
          </span>
        ) : null}

        <GripVertical
          className={cn(
            "ml-auto size-4 shrink-0 text-muted-foreground transition-opacity",
            interactive ? "opacity-0 group-hover/card:opacity-70" : "opacity-70"
          )}
          aria-hidden="true"
        />
      </div>

      {/* Progression des sous-tâches — seule la barre sur la carte (le détail
       *  vit dans le modal : affichage « paresseux », spec volume personnel). */}
      {progress.total > 0 ? (
        <div className="mt-2.5 flex items-center gap-2">
          <Progress
            value={progress.percent}
            className="h-1.5 flex-1"
            aria-label={`Sous-tâches : ${progress.done} sur ${progress.total}`}
          />
          <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {progress.done}/{progress.total}
          </span>
        </div>
      ) : null}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Wrapper sortable (dans une colonne du Kanban)
// ─────────────────────────────────────────────────────────────────────────────

type SortableTaskCardProps = {
  task: TaskDto
  eventTitle?: string | null
} & Required<TaskCardActions>

/** Carte sortable (dans une colonne du Kanban). */
export function SortableTaskCard({ task, eventTitle, ...actions }: SortableTaskCardProps) {
  const { attributes, isDragging, listeners, setNodeRef } = useSortable({
    id: task.id,
    data: { type: "task", status: task.status },
  })

  return (
    <li
      ref={setNodeRef}
      className={cn("list-none", isDragging && "opacity-40")}
      aria-label={`Tâche : ${task.title}`}
    >
      <TaskCardContent
        task={task}
        attributes={attributes}
        listeners={listeners}
        eventTitle={eventTitle}
        {...actions}
      />
    </li>
  )
}
