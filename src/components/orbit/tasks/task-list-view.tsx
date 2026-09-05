"use client";

// Orbit — TaskListView : vue tableau des tâches (alternative au Kanban).
// ─────────────────────────────────────────────────────────────────────────────
// Tableau shadcn : en-têtes triables (clic → asc/desc, icône flèche), colonnes
// [checkbox, Titre, Priorité, Tags, Échéance, Statut, Actions]. Sélection
// multiple (checkbox en-tête semi-cochée) → barre d'actions groupées FIXE en
// bas, façon toast : Terminer, Archiver, Supprimer (confirmation). Mobile :
// overflow-x-auto. Clic sur une ligne → édition (les contrôles stopPropagation).

import { useMemo, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle2,
  Loader2,
  Pencil,
  Trash2,
  X,
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
import { Checkbox } from "@/components/ui/checkbox"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { sortTasks, type SortOrder } from "@/lib/tasks"
import { useTaskMutations } from "@/lib/api-client"
import { StatusBadge } from "@/components/orbit/status-badge"
import { PriorityBadge } from "@/components/orbit/tasks/priority-badge"
import { DueDateBadge } from "@/components/orbit/tasks/due-date-badge"
import type { TaskDto, TaskStatus } from "@/lib/types"

// ─────────────────────────────────────────────────────────────────────────────
// Tri local
// ─────────────────────────────────────────────────────────────────────────────

/** Champs triables de la vue liste (Statut = comparateur maison). */
type ListSortField = "title" | "priority" | "dueDate" | "status"

const STATUS_ORDER: Record<TaskStatus, number> = {
  todo: 0,
  doing: 1,
  done: 2,
  archived: 3,
}

/** Ordre initial par champ (Priorité → URGENT d'abord, Échéance → proche d'abord). */
const DEFAULT_ORDER: Record<ListSortField, SortOrder> = {
  title: "asc",
  priority: "desc",
  dueDate: "asc",
  status: "asc",
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Une erreur est survenue"
}

// ─────────────────────────────────────────────────────────────────────────────
// En-tête triable
// ─────────────────────────────────────────────────────────────────────────────

function SortableHead({
  label,
  field,
  sortBy,
  order,
  onSort,
  className,
}: {
  label: string
  field: ListSortField
  sortBy: ListSortField
  order: SortOrder
  onSort: (field: ListSortField) => void
  className?: string
}) {
  const active = sortBy === field
  const Icon = active ? (order === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(field)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded text-xs font-medium uppercase tracking-wide transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active ? "text-foreground" : "text-muted-foreground"
        )}
        aria-label={`Trier par ${label}${active ? (order === "asc" ? " (croissant)" : " (décroissant)") : ""}`}
      >
        {label}
        <Icon className="size-3.5" aria-hidden="true" />
      </button>
    </TableHead>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Vue liste
// ─────────────────────────────────────────────────────────────────────────────

export type TaskListViewProps = {
  /** Tâches filtrées (les filtres vivent dans la toolbar de la vue). */
  tasks: TaskDto[]
  onEdit: (task: TaskDto) => void
  onArchiveToggle: (task: TaskDto) => void
  onDelete: (task: TaskDto) => void
}

function TaskListView({ tasks, onEdit, onArchiveToggle, onDelete }: TaskListViewProps) {
  const qc = useQueryClient()
  const { update, archive, removeHard } = useTaskMutations()

  const [sortBy, setSortBy] = useState<ListSortField>("status")
  const [order, setOrder] = useState<SortOrder>("asc")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<"complete" | "archive" | "delete" | null>(null)
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)

  const sorted = useMemo(() => {
    if (sortBy === "status") {
      const dir = order === "desc" ? -1 : 1
      return [...tasks].sort(
        (a, b) =>
          (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) * dir ||
          (a.position - b.position) * dir
      )
    }
    return sortTasks(tasks, sortBy, order)
  }, [tasks, sortBy, order])

  const selectedTasks = useMemo(
    () => sorted.filter((t) => selected.has(t.id)),
    [sorted, selected]
  )
  const selectedActive = selectedTasks.filter((t) => t.status !== "archived")

  const handleSort = (field: ListSortField) => {
    if (sortBy === field) {
      setOrder((o) => (o === "asc" ? "desc" : "asc"))
    } else {
      setSortBy(field)
      setOrder(DEFAULT_ORDER[field])
    }
  }

  const allSelected = sorted.length > 0 && selected.size === sorted.length
  const someSelected = selected.size > 0 && !allSelected

  const toggleAll = (checked: boolean) => {
    setSelected(checked ? new Set(sorted.map((t) => t.id)) : new Set())
  }

  const toggleOne = (id: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  // ----- Actions groupées (sélection multiple) -----

  /**
   * Applique une mutation à chaque tâche sélectionnée (Promise.allSettled)
   * puis toast résumé + invalidation finale (sécurité de cohérence).
   */
  const runBulk = async (
    kind: "complete" | "archive" | "delete",
    tasksToMutate: TaskDto[],
    run: (task: TaskDto) => Promise<unknown>
  ) => {
    if (tasksToMutate.length === 0) return
    setBusy(kind)
    const results = await Promise.allSettled(tasksToMutate.map((t) => run(t)))
    const ok = results.filter((r) => r.status === "fulfilled").length
    const failed = results.length - ok
    if (ok > 0) {
      toast.success(`${ok} tâche${ok > 1 ? "s" : ""} mise${ok > 1 ? "s" : ""} à jour`)
    }
    if (failed > 0) {
      const firstError = results.find((r) => r.status === "rejected")
      toast.error(`${failed} tâche${failed > 1 ? "s" : ""} en échec`, {
        description:
          firstError && firstError.status === "rejected"
            ? errMessage(firstError.reason)
            : undefined,
      })
    }
    setSelected(new Set())
    setBusy(null)
    // Sécurité : cache parfaitement synchrone après le lot.
    qc.invalidateQueries({ queryKey: ["tasks"] })
    qc.invalidateQueries({ queryKey: ["task-stats"] })
    qc.invalidateQueries({ queryKey: ["stats"] })
  }

  const bulkComplete = () =>
    runBulk(
      "complete",
      // « Terminer » ne concerne que les tâches non terminées/non archivées.
      selectedTasks.filter((t) => t.status !== "done" && t.status !== "archived"),
      (t) => update.mutateAsync({ id: t.id, input: { status: "done" } })
    )

  const bulkArchive = () => runBulk("archive", selectedActive, (t) => archive.mutateAsync(t.id))

  const bulkDelete = async () => {
    setConfirmBulkDelete(false)
    await runBulk("delete", selectedTasks, (t) => removeHard.mutateAsync(t.id))
  }

  return (
    <div className="space-y-0">
      {/* Tableau — scroll horizontal sur mobile */}
      <div className="overflow-x-auto rounded-xl border border-border/60 bg-card/60">
        <Table className="min-w-[720px]">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-10 pl-3">
                <Checkbox
                  checked={allSelected ? true : someSelected ? "indeterminate" : false}
                  onCheckedChange={(checked) => toggleAll(checked === true)}
                  aria-label="Sélectionner toutes les tâches"
                  className="translate-y-0.5"
                />
              </TableHead>
              <SortableHead label="Titre" field="title" sortBy={sortBy} order={order} onSort={handleSort} />
              <SortableHead label="Priorité" field="priority" sortBy={sortBy} order={order} onSort={handleSort} />
              <TableHead className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Tags
              </TableHead>
              <SortableHead label="Échéance" field="dueDate" sortBy={sortBy} order={order} onSort={handleSort} />
              <SortableHead label="Statut" field="status" sortBy={sortBy} order={order} onSort={handleSort} />
              <TableHead className="w-28 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((task) => {
              const isSelected = selected.has(task.id)
              const completed = task.status === "done" || task.status === "archived"
              return (
                <TableRow
                  key={task.id}
                  onClick={() => onEdit(task)}
                  className={cn(
                    "cursor-pointer transition-colors",
                    isSelected && "bg-primary/5"
                  )}
                >
                  <TableCell className="pl-3">
                    <Checkbox
                      checked={isSelected}
                      onCheckedChange={(checked) => toggleOne(task.id, checked === true)}
                      onClick={(e) => e.stopPropagation()}
                      aria-label={`Sélectionner « ${task.title} »`}
                      className="translate-y-0.5"
                    />
                  </TableCell>
                  <TableCell className="max-w-[280px]">
                    <div className="min-w-0">
                      <p
                        className={cn(
                          "truncate text-sm font-medium",
                          completed && "text-muted-foreground line-through decoration-muted-foreground/60"
                        )}
                      >
                        {task.title}
                      </p>
                      {task.description ? (
                        <p className="truncate text-xs text-muted-foreground">
                          {task.description}
                        </p>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <PriorityBadge priority={task.priority} />
                  </TableCell>
                  <TableCell>
                    <div className="flex max-w-[180px] flex-wrap items-center gap-1">
                      {task.tags.slice(0, 2).map((tag) => (
                        <Badge
                          key={tag.id}
                          variant="outline"
                          className="border-transparent px-1.5 text-[10px] font-medium"
                          style={{ backgroundColor: `${tag.color}22`, color: tag.color }}
                          title={`Tag : ${tag.name}`}
                        >
                          {tag.name}
                        </Badge>
                      ))}
                      {task.tags.length > 2 ? (
                        <span
                          className="text-[10px] text-muted-foreground"
                          title={task.tags.slice(2).map((t) => t.name).join(", ")}
                        >
                          +{task.tags.length - 2}
                        </span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <DueDateBadge due={task.dueDate} completed={completed} />
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={task.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation()
                          onEdit(task)
                        }}
                        aria-label={`Modifier « ${task.title} »`}
                      >
                        <Pencil className="size-4" aria-hidden="true" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation()
                          onArchiveToggle(task)
                        }}
                        aria-label={
                          task.status === "archived"
                            ? `Désarchiver « ${task.title} »`
                            : `Archiver « ${task.title} »`
                        }
                      >
                        {task.status === "archived" ? (
                          <ArchiveRestore className="size-4" aria-hidden="true" />
                        ) : (
                          <Archive className="size-4" aria-hidden="true" />
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 text-muted-foreground hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation()
                          onDelete(task)
                        }}
                        aria-label={`Supprimer « ${task.title} »`}
                      >
                        <Trash2 className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            })}
            {sorted.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="h-28 text-center text-sm text-muted-foreground">
                  Aucune tâche ne correspond aux filtres.
                </TableCell>
              </TableRow>
            ) : null}
          </TableBody>
        </Table>
      </div>

      {/* Barre d'actions groupées — fixe en bas, façon toast (au-dessus de la
       *  bottom-nav mobile : bottom-20 ; desktop : bottom-8). */}
      {selected.size > 0 ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-20 z-40 flex justify-center px-4 lg:bottom-8">
          <div
            className="pointer-events-auto flex flex-wrap items-center justify-center gap-2 rounded-full border border-border/60 bg-card/95 py-2 pl-4 pr-2 shadow-xl shadow-black/25 backdrop-blur-md"
            role="toolbar"
            aria-label={`Actions groupées (${selected.size} tâche(s) sélectionnée(s))`}
          >
            <span className="text-sm font-medium tabular-nums" aria-live="polite">
              {selected.size} sélectionnée{selected.size > 1 ? "s" : ""}
            </span>
            <Button
              type="button"
              size="sm"
              className="h-9 gap-1.5"
              disabled={busy !== null || selectedTasks.every((t) => t.status === "done" || t.status === "archived")}
              onClick={() => void bulkComplete()}
            >
              {busy === "complete" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <CheckCircle2 className="size-4" aria-hidden="true" />
              )}
              Terminer
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-9 gap-1.5"
              disabled={busy !== null || selectedActive.length === 0}
              onClick={() => void bulkArchive()}
            >
              {busy === "archive" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Archive className="size-4" aria-hidden="true" />
              )}
              Archiver
            </Button>
            <Button
              type="button"
              size="sm"
              variant="destructive"
              className="h-9 gap-1.5"
              disabled={busy !== null}
              onClick={() => setConfirmBulkDelete(true)}
            >
              {busy === "delete" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="size-4" aria-hidden="true" />
              )}
              Supprimer
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-9"
              onClick={() => setSelected(new Set())}
              aria-label="Effacer la sélection"
            >
              <X className="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      ) : null}

      {/* Confirmation de suppression groupée (définitive) */}
      <AlertDialog open={confirmBulkDelete} onOpenChange={setConfirmBulkDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Supprimer {selected.size} tâche{selected.size > 1 ? "s" : ""} ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Les tâches sélectionnées seront définitivement supprimées, avec
              leurs sous-tâches. Cette action est irréversible — pour les
              garder en réserve, préférez « Archiver ».
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy === "delete"}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive"
              disabled={busy === "delete"}
              onClick={(e) => {
                e.preventDefault() // on garde le dialog ouvert jusqu'au résultat
                void bulkDelete()
              }}
            >
              {busy === "delete" ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="size-4" aria-hidden="true" />
              )}
              Supprimer définitivement
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export { TaskListView }
