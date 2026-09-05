"use client";

// Orbit — TaskBoard : Kanban principal (drag & drop dnd-kit).
// ─────────────────────────────────────────────────────────────────────────────
// 3 colonnes actives (« À faire » bleu / « En cours » orange / « Terminé » vert)
// + colonne « Archivé » (gris, masquée par défaut — toggle dans la toolbar).
// Chaque colonne = SortableContext + droppable (drop sur colonne vide accepté).
// Drag inter-colonnes → PATCH /move {status, indice} ; réordonnancement
// intra-colonne → même statut + nouvel indice (le serveur renormalise toute la
// colonne en 1000·2000·3000). Mise à jour OPTIMISTE du cache ["tasks"]
// (arrayMove + positions recalculées) avec snapshot → rollback + toast si erreur.
// Mobile (<md) : une seule colonne visible à la fois via ToggleGroup de statuts
// (le drag tactile reste possible, le menu « Déplacer vers » est le chemin garanti).

import { useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import {
  Archive,
  CheckCircle2,
  Circle,
  Inbox,
  Plus,
  Timer,
  type LucideIcon,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import { ACTIVE_TASK_STATUSES, TASK_STATUSES, TASK_STATUS_LABELS } from "@/lib/tasks"
import { useTaskMutations, type TaskListResult } from "@/lib/api-client"
import type { TaskDto, TaskStatus } from "@/lib/types"
import {
  TaskCardContent,
  SortableTaskCard,
  type TaskCardActions,
} from "@/components/orbit/tasks/task-card"

// ─────────────────────────────────────────────────────────────────────────────
// Définitions des colonnes (couleurs spec utilisateur)
// ─────────────────────────────────────────────────────────────────────────────

type ColumnDef = {
  id: TaskStatus
  label: string
  emptyLabel: string
  icon: LucideIcon
  /** Couleur de marque (hex) : pastille d'en-tête + accents. */
  color: string
}

const COLUMN_DEFS: ColumnDef[] = [
  {
    id: "todo",
    label: "À faire",
    emptyLabel: "Glissez une tâche ici",
    icon: Circle,
    color: "#3B82F6",
  },
  {
    id: "doing",
    label: "En cours",
    emptyLabel: "Glissez une tâche ici",
    icon: Timer,
    color: "#F97316",
  },
  {
    id: "done",
    label: "Terminé",
    emptyLabel: "Rien de terminé pour l'instant",
    icon: CheckCircle2,
    color: "#22C55E",
  },
  {
    id: "archived",
    label: "Archivé",
    emptyLabel: "Aucune tâche archivée",
    icon: Archive,
    color: "#6B7280",
  },
]

/** Élargit la zone cliquable des petits boutons (~44px). */
const HIT_AREA =
  "relative before:absolute before:-inset-2 before:rounded-md before:content-['']"

/** Collision : priorité à ce qui est sous le curseur, sinon intersection géométrique. */
const collisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args)
  return pointerCollisions.length > 0 ? pointerCollisions : rectIntersection(args)
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Une erreur est survenue"
}

// ─────────────────────────────────────────────────────────────────────────────
// Colonne droppable
// ─────────────────────────────────────────────────────────────────────────────

type KanbanColumnProps = Required<TaskCardActions> & {
  column: ColumnDef
  tasks: TaskDto[]
  onCreate: (status: TaskStatus) => void
  eventTitles: Record<string, string>
  /** Masquée sur mobile (une seule colonne visible via le ToggleGroup). */
  hiddenOnMobile: boolean
}

/** Colonne droppable du Kanban (accepte le drop même vide). */
function KanbanColumn({
  column,
  tasks,
  onCreate,
  eventTitles,
  hiddenOnMobile,
  ...actions
}: KanbanColumnProps) {
  const { isOver, setNodeRef } = useDroppable({
    id: column.id,
    data: { type: "column", status: column.id },
  })
  const ColumnIcon = column.icon

  return (
    <div
      ref={setNodeRef}
      className={cn("flex h-full flex-col", hiddenOnMobile && "hidden md:flex")}
    >
      <Card
        className={cn(
          "h-full w-full gap-0 rounded-xl border-border/60 bg-muted/40 py-0 transition-colors",
          isOver && "border-primary/50 bg-primary/5"
        )}
      >
        <CardHeader className="flex-row items-center gap-2 p-3 pb-2">
          <span
            className="flex size-6 shrink-0 items-center justify-center rounded-full"
            style={{ backgroundColor: `${column.color}26`, color: column.color }}
            aria-hidden="true"
          >
            <ColumnIcon className="size-3.5" />
          </span>
          <CardTitle className="text-sm font-medium">{column.label}</CardTitle>
          <Badge
            variant="outline"
            className="ml-1 tabular-nums"
            style={{ borderColor: `${column.color}55`, color: column.color }}
            aria-label={`${tasks.length} ${tasks.length > 1 ? "tâches" : "tâche"}`}
          >
            {tasks.length}
          </Badge>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className={cn(
              HIT_AREA,
              "-m-1 ml-auto size-8 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-primary"
            )}
            onClick={() => onCreate(column.id)}
            aria-label={`Ajouter une tâche dans « ${column.label} »`}
          >
            <Plus className="size-4" aria-hidden="true" />
          </Button>
        </CardHeader>

        <CardContent className="p-2 pt-0">
          <ScrollArea className="md:max-h-[70vh]">
            <SortableContext
              items={tasks.map((task) => task.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="flex flex-col gap-2 pb-0.5 pr-0.5">
                {tasks.map((task) => (
                  <SortableTaskCard
                    key={task.id}
                    task={task}
                    eventTitle={task.eventId ? eventTitles[task.eventId] : undefined}
                    {...actions}
                  />
                ))}
                {tasks.length === 0 ? (
                  <li className="pointer-events-none flex min-h-24 flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-muted-foreground/25 p-4 text-center">
                    <Inbox
                      className="size-4 text-muted-foreground/60"
                      aria-hidden="true"
                    />
                    <p className="text-xs text-muted-foreground">
                      {column.emptyLabel}
                    </p>
                  </li>
                ) : null}
              </ul>
            </SortableContext>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Plateau principal
// ─────────────────────────────────────────────────────────────────────────────

export type TaskBoardProps = {
  /** Tâches à afficher (déjà filtrées : actives, + archivées si showArchived). */
  tasks: TaskDto[]
  /** Affiche la colonne Archivé (toggle de la toolbar). */
  showArchived: boolean
  /** Titres d'événements résolus (eventId → titre) pour les tooltips cartes. */
  eventTitles: Record<string, string>
  onEdit: (task: TaskDto) => void
  /** Archiver / Désarchiver (géré par la vue, mutations optimistes). */
  onArchiveToggle: (task: TaskDto) => void
  onDelete: (task: TaskDto) => void
  /** Création depuis le bouton « + » d'une colonne. */
  onCreate: (status: TaskStatus) => void
}

function TaskBoard({
  tasks,
  showArchived,
  eventTitles,
  onCreate,
  onEdit,
  onArchiveToggle,
  onDelete,
}: TaskBoardProps) {
  const qc = useQueryClient()
  const { move } = useTaskMutations()

  // Colonne visible sur mobile (ToggleGroup de statuts) — desktop les montre toutes.
  const [mobileStatus, setMobileStatus] = useState<TaskStatus>("todo")
  // Carte active du DragOverlay + largeur mesurée au démarrage du drag.
  const [activeTask, setActiveTask] = useState<TaskDto | null>(null)
  const [activeWidth, setActiveWidth] = useState<number | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  /** Colonnes rendues : 3 actives (+ archivée si demandée). */
  const columns = useMemo(
    () => COLUMN_DEFS.filter((c) => showArchived || c.id !== "archived"),
    [showArchived]
  )

  /** Groupes par statut, triés par POSITION (l'ordre du Kanban persiste). */
  const byStatus = useMemo(() => {
    const groups: Record<TaskStatus, TaskDto[]> = {
      todo: [],
      doing: [],
      done: [],
      archived: [],
    }
    for (const task of tasks) {
      if (task.status in groups) groups[task.status].push(task)
    }
    for (const status of TASK_STATUSES) {
      groups[status].sort((a, b) => a.position - b.position)
    }
    return groups
  }, [tasks])

  // ----- Déplacement (drag & drop + menu « Déplacer vers ») -----

  /** Snapshot du cache avant écriture optimiste (rollback en cas d'erreur). */
  const snapshotTasks = (): TaskListResult | undefined =>
    structuredClone(qc.getQueryData<TaskListResult>(["tasks"]))

  /**
   * Déplace une tâche : écriture optimiste (statut + arrayMove + positions
   * (i+1)·1000 recalculées localement sur les DEUX colonnes touchées), puis
   * PATCH /move {status, position: indice}. Erreur → rollback + toast.
   */
  const doMove = async (task: TaskDto, targetStatus: TaskStatus, targetIndex: number) => {
    // No-op : même colonne, même position effective
    const source = byStatus[task.status] ?? []
    const fromIndex = source.findIndex((t) => t.id === task.id)
    if (task.status === targetStatus && fromIndex === targetIndex) return

    const snap = snapshotTasks()
    qc.setQueryData<TaskListResult>(["tasks"], (old) => {
      if (!old) return old
      const nextTasks = old.tasks.map((t) => ({ ...t }))
      // Listes par statut construites sur les copies (mutables isolément).
      const lists: Partial<Record<TaskStatus, TaskDto[]>> = {}
      for (const t of nextTasks) (lists[t.status] ??= []).push(t)

      const sourceList = lists[task.status] ?? []
      const from = sourceList.findIndex((t) => t.id === task.id)
      if (from < 0) return old

      const targetList =
        task.status === targetStatus ? sourceList : (lists[targetStatus] ??= [])
      const [moved] = sourceList.splice(from, 1)
      moved.status = targetStatus
      const to = Math.max(0, Math.min(targetIndex, targetList.length))
      targetList.splice(to, 0, moved)

      // Recalcul des positions espacées sur les colonnes touchées
      for (const status of [task.status, targetStatus]) {
        lists[status]?.forEach((t, index) => {
          t.position = (index + 1) * 1000
        })
      }
      // Ordre interne identique au serveur (statut puis position).
      const statusOrder: Record<TaskStatus, number> = {
        todo: 0,
        doing: 1,
        done: 2,
        archived: 3,
      }
      nextTasks.sort(
        (a, b) => statusOrder[a.status] - statusOrder[b.status] || a.position - b.position
      )
      return { ...old, tasks: nextTasks }
    })

    try {
      await move.mutateAsync({ id: task.id, status: targetStatus, position: targetIndex })
      // Succès : l'invalidation du hook rafraîchit avec la renormalisation
      // serveur exacte (aucune écriture supplémentaire nécessaire).
    } catch (err) {
      if (snap) qc.setQueryData(["tasks"], snap)
      else qc.invalidateQueries({ queryKey: ["tasks"] })
      toast.error("Déplacement impossible", { description: errMessage(err) })
    }
  }

  /** Menu « Déplacer vers » : la tâche part en FIN de colonne cible. */
  const handleMoveTo = (task: TaskDto, status: TaskStatus) => {
    if (status === "archived") {
      // Déplacer vers « Archivé » = archiver (soft delete) — même sémantique.
      onArchiveToggle(task)
      return
    }
    void doMove(task, status, byStatus[status]?.length ?? 0)
  }

  // ----- Événements dnd-kit -----

  const taskTitleOf = (id: string | number): string =>
    tasks.find((t) => t.id === id)?.title ?? "la tâche"

  const columnLabelOf = (id: string | number): string => {
    const column = COLUMN_DEFS.find((c) => c.id === id)
    if (column) return column.label
    const task = tasks.find((t) => t.id === id)
    return task
      ? (COLUMN_DEFS.find((c) => c.id === task.status)?.label ?? "cette zone")
      : "cette zone"
  }

  const handleDragStart = (event: DragStartEvent) => {
    setActiveTask(tasks.find((t) => t.id === String(event.active.id)) ?? null)
    setActiveWidth(event.active.rect.current.initial?.width ?? null)
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveTask(null)
    setActiveWidth(null)
    const { active, over } = event
    if (!over) return
    const activeId = String(active.id)
    if (activeId === String(over.id)) return

    const task = tasks.find((t) => t.id === activeId)
    if (!task) return

    const overId = String(over.id)
    const overData = over.data.current as
      | { type?: string; status?: TaskStatus }
      | undefined

    let targetStatus: TaskStatus | undefined
    let targetIndex: number

    if (overData?.type === "column" && overData.status) {
      // Drop sur la colonne (zone vide / fond) → fin de colonne
      targetStatus = overData.status
      targetIndex = byStatus[targetStatus]?.length ?? 0
    } else {
      // Drop sur une carte → à sa position (sémantique arrayMove : le serveur
      // retire d'abord la tâche déplacée puis insère à l'indice — cohérent).
      const overTask = tasks.find((t) => t.id === overId)
      if (!overTask) return
      targetStatus = overTask.status
      const list = byStatus[targetStatus] ?? []
      targetIndex = list.findIndex((t) => t.id === overId)
      if (targetIndex < 0) return
    }

    if (targetStatus === undefined) return
    void doMove(task, targetStatus, targetIndex)
  }

  const handleDragCancel = () => {
    setActiveTask(null)
    setActiveWidth(null)
  }

  // ----- Rendu -----

  return (
    <div className="space-y-3">
      {/* Mobile : sélecteur de colonne (une seule visible à la fois) */}
      <ToggleGroup
        type="single"
        value={mobileStatus}
        onValueChange={(value) => {
          if (value) setMobileStatus(value as TaskStatus)
        }}
        className="flex w-full justify-stretch gap-1 md:hidden"
        aria-label="Colonne affichée (mobile)"
      >
        {columns.map((column) => (
          <ToggleGroupItem
            key={column.id}
            value={column.id}
            className="h-10 flex-1 gap-1.5 text-xs font-medium"
            aria-label={`Afficher la colonne ${column.label}`}
          >
            <column.icon className="size-3.5" aria-hidden="true" />
            {column.label}
            <Badge
              variant="secondary"
              className="px-1 text-[10px] tabular-nums text-muted-foreground"
            >
              {byStatus[column.id]?.length ?? 0}
            </Badge>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
        accessibility={{
          announcements: {
            onDragStart: ({ active }) =>
              `Tâche saisie : ${taskTitleOf(active.id)}. Utilisez les touches fléchées pour la déplacer, puis Espace pour la déposer.`,
            onDragOver: ({ over }) =>
              over ? `Zone survolée : ${columnLabelOf(over.id)}.` : "",
            onDragEnd: ({ over }) =>
              over
                ? `Tâche déposée dans « ${columnLabelOf(over.id)} ».`
                : "Déplacement annulé.",
            onDragCancel: () => "Déplacement annulé.",
          },
          screenReaderInstructions: {
            draggable:
              "Pour saisir une tâche au clavier, placez-vous dessus avec Tab, appuyez sur Espace, déplacez-la avec les flèches, puis déposez-la avec Espace ou annulez avec Échap.",
          },
        }}
      >
        <div
          className={cn(
            "grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3",
            showArchived && "xl:grid-cols-4"
          )}
        >
          {columns.map((column) => (
            <KanbanColumn
              key={column.id}
              column={column}
              tasks={byStatus[column.id] ?? []}
              eventTitles={eventTitles}
              hiddenOnMobile={column.id !== mobileStatus}
              onEdit={onEdit}
              onMoveTo={handleMoveTo}
              onArchiveToggle={onArchiveToggle}
              onDelete={onDelete}
              onCreate={onCreate}
            />
          ))}        </div>

        <DragOverlay>
          {activeTask ? (
            <div style={{ width: activeWidth ?? undefined }}>
              <TaskCardContent task={activeTask} overlay eventTitle={
                activeTask.eventId ? eventTitles[activeTask.eventId] : undefined
              } />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </div>
  )
}

export { TaskBoard, COLUMN_DEFS }
export type { ColumnDef as TaskColumnDef }
