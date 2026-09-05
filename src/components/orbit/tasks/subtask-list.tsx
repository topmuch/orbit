"use client";

// Orbit — SubtaskList : sous-tâches d'une tâche (checkboxes + progression).
// ─────────────────────────────────────────────────────────────────────────────
// DEUX modes complémentaires :
//  • taskId non null (édition)  : mutations serveur IMMÉDIATES optimistes
//    (POST/PATCH/DELETE /api/tasks/:id/subtasks) — la liste se réabonne au
//    cache ["tasks"] (setQueryData ciblé + rollback par snapshot en erreur).
//  • taskId null (création)     : liste locale contrôlée (value/onLocalChange),
//    envoyée au POST de la tâche sous forme [{title}] (les cases cochées ne
//    sont pas transmises : une sous-tâche créée démarre non terminée).
// Réordonnancement par boutons ↑ ↓ (PATCH position = indice cible → le serveur
// renormalise toute la liste). Cap 50 géré par le serveur (toast d'erreur).

import { useMemo, useState } from "react"
import { arrayMove } from "@dnd-kit/sortable"
import { useQueryClient } from "@tanstack/react-query"
import { Check, ChevronDown, ChevronUp, ListChecks, Loader2, Plus, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Progress } from "@/components/ui/progress"
import { cn } from "@/lib/utils"
import { POSITION_STEP, subtaskProgress } from "@/lib/tasks"
import {
  useSubtaskMutations,
  useTasks,
  type TaskListResult,
} from "@/lib/api-client"
import type { SubTaskDto, TaskDto } from "@/lib/types"

/** Sous-tâche en mode local (création — position implicite = ordre du tableau). */
export type LocalSubtask = { id: string; title: string; completed: boolean }

/** Barre de progression + « 2/5 · 40 % » (partagée par les deux modes). */
function SubtaskProgress({ subtasks }: { subtasks: readonly { completed: boolean }[] }) {
  const { done, total, percent } = subtaskProgress({
    // Coercition structurelle : subtaskProgress attend des SubTaskDto complets,
    // seule la case « completed » compte pour la progression.
    subtasks: subtasks as SubTaskDto[],
  })
  if (total === 0) return null
  return (
    <div className="flex items-center gap-2.5" aria-live="polite">
      <Progress
        value={percent}
        className="h-1.5 flex-1"
        aria-label={`Progression des sous-tâches : ${done} sur ${total}`}
      />
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
        {done}/{total} · {percent}&nbsp;%
      </span>
    </div>
  )
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Une erreur est survenue"
}

type SubtaskListProps = {
  /** null → mode local (création de tâche, aucune mutation serveur). */
  taskId: string | null
  /** Mode local uniquement : liste contrôlée par le parent. */
  localItems?: LocalSubtask[]
  onLocalChange?: (items: LocalSubtask[]) => void
  className?: string
}

function SubtaskList({ taskId, localItems, onLocalChange, className }: SubtaskListProps) {
  // ----- Mode serveur : réabonnement au cache (liste toujours fraîche) -----
  const { data } = useTasks()
  const serverSubtasks = useMemo<SubTaskDto[]>(() => {
    if (taskId === null) return []
    return (
      data?.tasks.find((t) => t.id === taskId)?.subtasks ??
      []
    )
  }, [data, taskId])

  const isLocalMode = taskId === null
  const items = isLocalMode ? (localItems ?? []) : serverSubtasks

  const { add, patch, remove } = useSubtaskMutations()
  const qc = useQueryClient()
  const [newTitle, setNewTitle] = useState("")
  const pending = add.isPending || patch.isPending || remove.isPending

  /** Snapshot du cache avant un setQueryData optimiste (rollback). */
  const snapshot = (): TaskListResult | undefined =>
    structuredClone(qc.getQueryData<TaskListResult>(["tasks"]))

  /** Écriture optimiste ciblée : remplace les sous-tâches d'une tâche. */
  const writeSubtasks = (targetId: string, subtasks: SubTaskDto[]) => {
    qc.setQueryData<TaskListResult>(["tasks"], (old) =>
      old
        ? {
            ...old,
            tasks: old.tasks.map((t) => (t.id === targetId ? { ...t, subtasks } : t)),
          }
        : old
    )
  }

  const rollback = (snap: TaskListResult | undefined, context: string, err: unknown) => {
    if (snap) qc.setQueryData(["tasks"], snap)
    else qc.invalidateQueries({ queryKey: ["tasks"] })
    toast.error(context, { description: errMessage(err) })
  }

  // ----- Ajout (Entrée ou bouton +) -----

  const handleAdd = () => {
    const title = newTitle.trim()
    if (title === "") return

    if (isLocalMode) {
      onLocalChange?.([
        ...(localItems ?? []),
        { id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title, completed: false },
      ])
      setNewTitle("")
      return
    }

    const targetId = taskId
    const nextPosition =
      serverSubtasks.length > 0
        ? Math.max(...serverSubtasks.map((s) => s.position)) + POSITION_STEP
        : 0
    const optimistic: SubTaskDto = {
      id: `temp-${Date.now()}`,
      title,
      completed: false,
      position: nextPosition,
      createdAt: new Date().toISOString(),
    }
    const snap = snapshot()
    writeSubtasks(targetId, [...serverSubtasks, optimistic])
    add
      .mutateAsync({ taskId: targetId, title })
      .then(() => setNewTitle(""))
      .catch((err) => rollback(snap, "Ajout impossible", err))
  }

  // ----- Coche (optimiste + rollback) -----

  const handleToggle = (subtaskId: string, completed: boolean) => {
    if (isLocalMode) {
      onLocalChange?.(
        (localItems ?? []).map((s) => (s.id === subtaskId ? { ...s, completed } : s))
      )
      return
    }
    const targetId = taskId
    const snap = snapshot()
    writeSubtasks(
      targetId,
      serverSubtasks.map((s) => (s.id === subtaskId ? { ...s, completed } : s))
    )
    patch
      .mutateAsync({ taskId: targetId, subtaskId, completed })
      .catch((err) => rollback(snap, "Mise à jour impossible", err))
  }

  // ----- Réordonnancement ↑↓ (position = indice cible) -----

  const handleMove = (subtaskId: string, offset: -1 | 1) => {
    const from = items.findIndex((s) => s.id === subtaskId)
    const to = from + offset
    if (from < 0 || to < 0 || to >= items.length) return

    if (isLocalMode) {
      onLocalChange?.(arrayMove(localItems ?? [], from, to) as LocalSubtask[])
      return
    }
    const targetId = taskId
    const reordered = arrayMove(serverSubtasks, from, to)
    const next = reordered.map((s, index) => ({ ...s, position: (index + 1) * POSITION_STEP }))
    const snap = snapshot()
    writeSubtasks(targetId, next)
    patch
      .mutateAsync({ taskId: targetId, subtaskId, position: to })
      .catch((err) => rollback(snap, "Réordonnancement impossible", err))
  }

  // ----- Suppression (optimiste + rollback) -----

  const handleRemove = (subtaskId: string) => {
    if (isLocalMode) {
      onLocalChange?.((localItems ?? []).filter((s) => s.id !== subtaskId))
      return
    }
    const targetId = taskId
    const snap = snapshot()
    writeSubtasks(
      targetId,
      serverSubtasks.filter((s) => s.id !== subtaskId)
    )
    remove
      .mutateAsync({ taskId: targetId, subtaskId })
      .catch((err) => rollback(snap, "Suppression impossible", err))
  }

  const total = items.length

  return (
    <div className={cn("space-y-2.5", className)}>
      {total > 0 ? <SubtaskProgress subtasks={items} /> : null}

      <ul className="space-y-1" aria-label="Sous-tâches">
        {items.map((subtask, index) => (
          <li
            key={subtask.id}
            className={cn(
              "group/row flex items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors hover:bg-accent/50",
              String(subtask.id).startsWith("temp-") && "opacity-60"
            )}
          >
            <Checkbox
              id={`subtask-${subtask.id}`}
              checked={subtask.completed}
              onCheckedChange={(checked) => handleToggle(subtask.id, checked === true)}
              disabled={pending && !String(subtask.id).startsWith("temp-")}
              aria-label={`Sous-tâche : ${subtask.title}`}
            />
            <label
              htmlFor={`subtask-${subtask.id}`}
              className={cn(
                "min-w-0 flex-1 cursor-pointer truncate text-sm leading-snug",
                subtask.completed && "text-muted-foreground line-through decoration-muted-foreground/50"
              )}
            >
              {subtask.title}
            </label>

            {/* Réordonnancement (masqué si extrémité) */}
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100 disabled:opacity-20"
                disabled={index === 0 || pending}
                onClick={() => handleMove(subtask.id, -1)}
                aria-label={`Déplacer « ${subtask.title} » vers le haut`}
              >
                <ChevronUp className="size-4" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100 disabled:opacity-20"
                disabled={index === total - 1 || pending}
                onClick={() => handleMove(subtask.id, 1)}
                aria-label={`Déplacer « ${subtask.title} » vers le bas`}
              >
                <ChevronDown className="size-4" aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover/row:opacity-100"
                disabled={pending}
                onClick={() => handleRemove(subtask.id)}
                aria-label={`Supprimer la sous-tâche « ${subtask.title} »`}
              >
                <X className="size-4" aria-hidden="true" />
              </Button>
            </div>
          </li>
        ))}
        {total === 0 ? (
          <li className="rounded-lg border border-dashed border-border/70 px-3 py-3 text-center text-xs text-muted-foreground">
            Aucune sous-tâche — découpez la tâche pour suivre votre progression.
          </li>
        ) : null}
      </ul>

      {/* Ajout rapide : Entrée ou bouton */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <ListChecks
            className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault()
                handleAdd()
              }
            }}
            placeholder="Nouvelle sous-tâche…"
            className="h-9 pl-8"
            maxLength={200}
            disabled={pending}
            aria-label="Ajouter une sous-tâche"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 w-9 shrink-0 p-0"
          onClick={handleAdd}
          disabled={pending || newTitle.trim() === ""}
          aria-label="Ajouter la sous-tâche"
        >
          {add.isPending ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : (
            <Plus className="size-4" aria-hidden="true" />
          )}
        </Button>
      </div>
      {total >= 50 ? (
        <p className="flex items-center gap-1.5 text-xs text-amber-500">
          <Check className="size-3.5" aria-hidden="true" />
          Maximum atteint (50 sous-tâches).
        </p>
      ) : null}
    </div>
  )
}

export { SubtaskList }
