"use client";

// Orbit — Vue Tâches (orchestrateur) : Kanban + vue liste + stats + filtres.
// ─────────────────────────────────────────────────────────────────────────────
// Layout : toolbar (TaskFilters à gauche ; ToggleGroup Kanban/Liste, bouton
// Tags, toggle « Archivées », bouton « Nouvelle tâche » à droite), bandeau
// TaskStats TOUJOURS visible (compact), puis TaskBoard OU TaskListView.
// Dialogs montés ici : TaskModal (création/édition), TagManager, AlertDialog
// de suppression. Les mutations optimistes (archiver/désarchiver/supprimer)
// suivent le pattern maison : snapshot structuredClone → setQueryData ciblé →
// rollback + toast en cas d'erreur. Le drag & drop (move) vit dans TaskBoard.

import { useMemo, useState } from "react"
import { addDays } from "date-fns"
import { useQueryClient } from "@tanstack/react-query"
import { useNewIntent } from "@/lib/ui-intent"
import {
  KanbanSquare,
  ListTodo,
  Loader2,
  Plus,
  RefreshCw,
  Table,
  Tag as TagIcon,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Label } from "@/components/ui/label"
import { TASK_STATUS_LABELS } from "@/lib/tasks"
import {
  useEvents,
  useTags,
  useTaskMutations,
  useTasks,
  type TaskListResult,
} from "@/lib/api-client"
import type { TaskDto, TaskStatus } from "@/lib/types"
import {
  EMPTY_TASK_FILTERS,
  TaskFilters,
  countActiveFilters,
  filterTasks,
} from "@/components/orbit/tasks/task-filters"
import { TaskBoard } from "@/components/orbit/tasks/task-board"
import { TaskListView } from "@/components/orbit/tasks/task-list-view"
import { TaskStats } from "@/components/orbit/tasks/task-stats"
import { TaskModal } from "@/components/orbit/tasks/task-modal"
import { TagManager } from "@/components/orbit/tasks/tag-manager"

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Une erreur est survenue"
}

/** Vue d'affichage (toggle de la toolbar). */
type TasksViewMode = "kanban" | "list"

// ─────────────────────────────────────────────────────────────────────────────
// Skeletons
// ─────────────────────────────────────────────────────────────────────────────

function ColumnSkeleton() {
  return (
    <Card className="h-full gap-0 rounded-xl bg-muted/40 py-0">
      <CardHeader className="flex-row items-center gap-2 p-3 pb-2">
        <Skeleton className="size-6 shrink-0 rounded-full" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="ml-auto size-8 rounded-md" />
      </CardHeader>
      <CardContent className="flex flex-col gap-2 p-2 pt-0">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-24 rounded-lg" />
        ))}
      </CardContent>
    </Card>
  )
}

function BoardSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3" role="status" aria-label="Chargement des tâches">
      {Array.from({ length: 3 }, (_, i) => (
        <ColumnSkeleton key={i} />
      ))}
    </div>
  )
}

function TableSkeleton() {
  return (
    <div className="space-y-2 rounded-xl border border-border/60 bg-card/60 p-4" role="status" aria-label="Chargement des tâches">
      <Skeleton className="h-9 w-full" />
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty states
// ─────────────────────────────────────────────────────────────────────────────

function GlobalEmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <Card className="mx-auto flex w-full max-w-md flex-col items-center gap-4 rounded-xl bg-card/60 p-8 text-center">
      <div className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
        <ListTodo className="size-7" aria-hidden="true" />
      </div>
      <div className="space-y-1.5">
        <h3 className="text-base font-semibold">Aucune tâche pour l&apos;instant</h3>
        <p className="mx-auto max-w-xs text-sm leading-relaxed text-muted-foreground">
          Créez votre première tâche, puis faites-la glisser entre les colonnes
          pour suivre son avancement.
        </p>
      </div>
      <Button onClick={onCreate} className="h-11 gap-2 px-5">
        <Plus className="size-4" aria-hidden="true" />
        Créer ma première tâche
      </Button>
    </Card>
  )
}

function FilteredEmptyState({ onReset }: { onReset: () => void }) {
  return (
    <Card className="mx-auto flex w-full max-w-md flex-col items-center gap-3 rounded-xl bg-card/60 p-6 text-center">
      <p className="text-sm text-muted-foreground">
        Aucune tâche ne correspond aux filtres.
      </p>
      <Button variant="outline" size="sm" className="gap-1.5" onClick={onReset}>
        Réinitialiser les filtres
      </Button>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Vue principale
// ─────────────────────────────────────────────────────────────────────────────

export function TasksView() {
  const { data, isLoading, isError, error, refetch } = useTasks()
  const { update, archive, removeHard } = useTaskMutations()
  const { data: tagsData } = useTags()
  const qc = useQueryClient()

  // Titres d'événements (tooltips « tâche liée à un événement » des cartes).
  // Plage STABLE au montage : `new Date()` à chaque render changerait la
  // queryKey (millisecondes) et déclencherait une boucle de refetch.
  const [eventsFrom, eventsTo] = useMemo(
    () => [addDays(new Date(), -60), addDays(new Date(), 180)],
    []
  )
  const { data: eventsData } = useEvents(eventsFrom, eventsTo)

  const [viewMode, setViewMode] = useState<TasksViewMode>("kanban")
  const [showArchived, setShowArchived] = useState(false)
  const [filters, setFilters] = useState(EMPTY_TASK_FILTERS)

  const [modalOpen, setModalOpen] = useState(false)
  const [editingTask, setEditingTask] = useState<TaskDto | null>(null)
  const [modalStatus, setModalStatus] = useState<TaskStatus>("todo")
  const [tagManagerOpen, setTagManagerOpen] = useState(false)
  const [taskToDelete, setTaskToDelete] = useState<TaskDto | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)

  // Intention globale « nouvelle tâche » (palette Ctrl+K / raccourci Ctrl+T) :
  // abonnement au store d'intentions (rattrape aussi les intentions émises
  // pendant le chargement différé de la vue — cf. lib/ui-intent).
  useNewIntent("task", () => {
    setEditingTask(null)
    setModalStatus("todo")
    setModalOpen(true)
  })

  const tasks = useMemo(() => data?.tasks ?? [], [data])

  /** Tâches visibles : archivées exclues (sauf toggle) + filtres clients. */
  const visibleTasks = useMemo(() => {
    const base = showArchived ? tasks : tasks.filter((t) => t.status !== "archived")
    return filterTasks(base, filters)
  }, [tasks, showArchived, filters])

  const archivedCount = useMemo(
    () => tasks.filter((t) => t.status === "archived").length,
    [tasks]
  )

  /** eventId → titre (première occurrence). */
  const eventTitles = useMemo(() => {
    const map: Record<string, string> = {}
    for (const ev of eventsData?.events ?? []) {
      if (!map[ev.id]) map[ev.id] = ev.title
    }
    return map
  }, [eventsData])

  // ----- Dialogs -----

  const openCreate = (status: TaskStatus) => {
    setEditingTask(null)
    setModalStatus(status)
    setModalOpen(true)
  }

  const openEdit = (task: TaskDto) => {
    setEditingTask(task)
    setModalStatus(task.status)
    setModalOpen(true)
  }

  // ----- Mutations optimistes (archiver / désarchiver / supprimer) -----

  /** Snapshot du cache avant écriture optimiste (rollback). */
  const snapshotTasks = (): TaskListResult | undefined =>
    structuredClone(qc.getQueryData<TaskListResult>(["tasks"]))

  /** Archiver (DELETE soft) / Désarchiver (PATCH status=todo) — optimiste. */
  const toggleArchive = async (task: TaskDto) => {
    const archiving = task.status !== "archived"
    const nextStatus: TaskStatus = archiving ? "archived" : "todo"
    const snap = snapshotTasks()
    qc.setQueryData<TaskListResult>(["tasks"], (old) =>
      old
        ? {
            ...old,
            tasks: old.tasks.map((t) => (t.id === task.id ? { ...t, status: nextStatus } : t)),
          }
        : old
    )
    try {
      if (archiving) {
        await archive.mutateAsync(task.id)
        toast.success("Tâche archivée", {
          description: `« ${task.title} » est conservée dans la colonne Archivé.`,
        })
      } else {
        await update.mutateAsync({ id: task.id, input: { status: "todo" } })
        toast.success("Tâche désarchivée", {
          description: `« ${task.title} » est de retour dans « ${TASK_STATUS_LABELS.todo} ».`,
        })
      }
    } catch (err) {
      if (snap) qc.setQueryData(["tasks"], snap)
      else qc.invalidateQueries({ queryKey: ["tasks"] })
      toast.error(archiving ? "Archivage impossible" : "Désarchivage impossible", {
        description: errMessage(err),
      })
    }
  }

  /** Suppression DÉFINITIVE (hard=1) — optimiste + confirmation en amont. */
  const deleteTask = async (task: TaskDto) => {
    setIsDeleting(true)
    const snap = snapshotTasks()
    qc.setQueryData<TaskListResult>(["tasks"], (old) =>
      old ? { ...old, tasks: old.tasks.filter((t) => t.id !== task.id) } : old
    )
    try {
      await removeHard.mutateAsync(task.id)
      toast.success("Tâche supprimée", {
        description: `« ${task.title} » a été définitivement supprimée.`,
      })
      setTaskToDelete(null)
    } catch (err) {
      if (snap) qc.setQueryData(["tasks"], snap)
      else qc.invalidateQueries({ queryKey: ["tasks"] })
      toast.error("Suppression impossible", { description: errMessage(err) })
    } finally {
      setIsDeleting(false)
    }
  }

  // ----- Rendu -----

  const filtersActive = countActiveFilters(filters) > 0

  return (
    <section aria-label="Tâches" className="flex flex-col gap-4">
      {/* ---------- Toolbar ---------- */}
      {isLoading || tasks.length > 0 ? (
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          {/* Filtres + recherche (côté client, réaction instantanée) */}
          <TaskFilters
            value={filters}
            onChange={setFilters}
            tags={tagsData?.tags ?? []}
            className="flex-1"
          />

          {/* Actions de vue */}
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup
              type="single"
              value={viewMode}
              onValueChange={(value) => {
                if (value) setViewMode(value as TasksViewMode)
              }}
              variant="outline"
              aria-label="Mode d'affichage des tâches"
            >
              <ToggleGroupItem value="kanban" className="gap-1.5" aria-label="Vue Kanban">
                <KanbanSquare className="size-4" aria-hidden="true" />
                <span className="hidden sm:inline">Kanban</span>
              </ToggleGroupItem>
              <ToggleGroupItem value="list" className="gap-1.5" aria-label="Vue liste">
                <Table className="size-4" aria-hidden="true" />
                <span className="hidden sm:inline">Liste</span>
              </ToggleGroupItem>
            </ToggleGroup>

            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-9 gap-1.5"
              onClick={() => setTagManagerOpen(true)}
            >
              <TagIcon className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">Tags</span>
              <span className="sr-only sm:hidden">Gérer les tags</span>
            </Button>

            {/* Toggle « Archivées » + compteur */}
            <div className="flex h-9 items-center gap-2 rounded-md border border-input bg-transparent px-3 shadow-xs">
              <Switch
                id="toggle-archived"
                checked={showArchived}
                onCheckedChange={setShowArchived}
                aria-label="Afficher les tâches archivées"
              />
              <Label
                htmlFor="toggle-archived"
                className="cursor-pointer text-sm font-medium leading-none"
              >
                Archivées
              </Label>
              <Badge variant="secondary" className="px-1.5 text-[10px] tabular-nums">
                {archivedCount}
              </Badge>
            </div>

            <Button onClick={() => openCreate("todo")} className="h-9 gap-1.5">
              <Plus className="size-4" aria-hidden="true" />
              Nouvelle tâche
            </Button>
          </div>
        </div>
      ) : null}

      {/* ---------- Bandeau de stats (toujours visible, compact) ---------- */}
      <TaskStats />

      {/* ---------- Contenu ---------- */}
      {isLoading ? (
        viewMode === "kanban" ? <BoardSkeleton /> : <TableSkeleton />
      ) : isError ? (
        <Card className="mx-auto flex w-full max-w-md flex-col items-center gap-3 rounded-xl bg-card/60 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            Impossible de charger vos tâches.
          </p>
          {error ? (
            <p className="text-xs text-muted-foreground/80">{errMessage(error)}</p>
          ) : null}
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void refetch()}>
            <RefreshCw className="size-4" aria-hidden="true" />
            Réessayer
          </Button>
        </Card>
      ) : tasks.length === 0 ? (
        <GlobalEmptyState onCreate={() => openCreate("todo")} />
      ) : visibleTasks.length === 0 ? (
        <FilteredEmptyState onReset={() => setFilters(EMPTY_TASK_FILTERS)} />
      ) : viewMode === "kanban" ? (
        <TaskBoard
          tasks={visibleTasks}
          showArchived={showArchived}
          eventTitles={eventTitles}
          onEdit={openEdit}
          onArchiveToggle={(task) => void toggleArchive(task)}
          onDelete={setTaskToDelete}
          onCreate={openCreate}
        />
      ) : (
        <TaskListView
          tasks={visibleTasks}
          onEdit={openEdit}
          onArchiveToggle={(task) => void toggleArchive(task)}
          onDelete={setTaskToDelete}
        />
      )}

      {/* ---------- Création / édition ---------- */}
      <TaskModal
        open={modalOpen}
        onOpenChange={(open) => {
          setModalOpen(open)
          if (!open) setEditingTask(null)
        }}
        task={editingTask}
        defaultStatus={modalStatus}
      />

      {/* ---------- Gestion des tags ---------- */}
      <TagManager open={tagManagerOpen} onOpenChange={setTagManagerOpen} />

      {/* ---------- Confirmation de suppression (carte / ligne) ---------- */}
      <AlertDialog
        open={taskToDelete !== null}
        onOpenChange={(open) => {
          if (!open) setTaskToDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer cette tâche ?</AlertDialogTitle>
            <AlertDialogDescription>
              {taskToDelete?.status === "archived" ? (
                <>
                  « {taskToDelete?.title} » (archivée) sera définitivement
                  supprimée, avec ses sous-tâches. Cette action est irréversible.
                </>
              ) : (
                <>
                  « {taskToDelete?.title} » sera définitivement supprimée, avec
                  ses sous-tâches. Cette action est irréversible — pour la
                  garder en réserve, préférez « Archiver ».
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive"
              disabled={isDeleting}
              onClick={(e) => {
                e.preventDefault() // on garde le dialog ouvert jusqu'au résultat
                if (taskToDelete) void deleteTask(taskToDelete)
              }}
            >
              {isDeleting ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="size-4" aria-hidden="true" />
              )}
              Supprimer définitivement
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
