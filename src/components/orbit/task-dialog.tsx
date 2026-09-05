"use client";

// Orbit — Dialog création/édition/suppression de tâche
// API : <TaskDialog open onOpenChange task={TaskDto|null} defaultStatus? defaultDueDate? />
// Formulaire interne remonté à chaque ouverture → initialisation directe, sans effet.

import { useState } from "react"
import { format } from "date-fns"
import { fr } from "date-fns/locale"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ListTodo, Trash2, Loader2, Flag } from "lucide-react"
import { useTaskMutations } from "@/lib/api-client"
import type { TaskDto } from "@/lib/types"

const PRIORITIES: { value: number; label: string; hint: string }[] = [
  { value: 0, label: "Basse", hint: "Quand j'aurai le temps" },
  { value: 1, label: "Moyenne", hint: "À traiter cette semaine" },
  { value: 2, label: "Haute", hint: "Priorité immédiate" },
]

export function TaskDialog({
  open,
  onOpenChange,
  task,
  defaultStatus = "todo",
  defaultDueDate,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Tâche existante → édition ; null → création */
  task?: TaskDto | null
  defaultStatus?: "todo" | "doing" | "done"
  defaultDueDate?: Date | null
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <TaskForm
          key={task?.id ?? "new"}
          task={task ?? null}
          defaultStatus={defaultStatus}
          defaultDueDate={defaultDueDate ?? null}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

function TaskForm({
  task,
  defaultStatus,
  defaultDueDate,
  onDone,
}: {
  task: TaskDto | null
  defaultStatus: "todo" | "doing" | "done"
  defaultDueDate: Date | null
  onDone: () => void
}) {
  const { create, update, remove } = useTaskMutations()

  const [title, setTitle] = useState(task?.title ?? "")
  const [description, setDescription] = useState(task?.description ?? "")
  const [status, setStatus] = useState<"todo" | "doing" | "done">(task?.status ?? defaultStatus)
  const [priority, setPriority] = useState(task?.priority ?? 1)
  const [dueDate, setDueDate] = useState(() => {
    const d = task?.dueDate ? new Date(task.dueDate) : defaultDueDate
    return d ? format(d, "yyyy-MM-dd'T'HH:mm") : ""
  })
  const [confirmDelete, setConfirmDelete] = useState(false)

  const saving = create.isPending || update.isPending || remove.isPending

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return toast.error("Le titre est requis")

    const input = {
      title: title.trim(),
      description: description.trim() || undefined,
      status,
      priority,
      dueDate: dueDate ? new Date(dueDate).toISOString() : null,
    }

    try {
      if (task) {
        await update.mutateAsync({ id: task.id, input })
        toast.success("Tâche mise à jour")
      } else {
        await create.mutateAsync(input)
        toast.success("Tâche créée")
      }
      onDone()
    } catch (err) {
      toast.error((err as Error).message ?? "Une erreur est survenue")
    }
  }

  async function handleDelete() {
    if (!task) return
    try {
      await remove.mutateAsync(task.id)
      toast.success("Tâche supprimée")
      setConfirmDelete(false)
      onDone()
    } catch (err) {
      toast.error((err as Error).message ?? "Suppression impossible")
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <ListTodo className="size-5 text-primary" aria-hidden />
          {task ? "Modifier la tâche" : "Nouvelle tâche"}
        </DialogTitle>
        <DialogDescription>
          {task ? "Ajustez les détails de votre tâche." : "Ajoutez une tâche à votre tableau Orbit."}
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="task-title">Titre</Label>
          <Input
            id="task-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ex. Préparer la présentation"
            maxLength={120}
            autoFocus
          />
        </div>

        <div className="space-y-2">
          <Label>Priorité</Label>
          <RadioGroup
            value={String(priority)}
            onValueChange={(v) => setPriority(Number(v))}
            className="grid grid-cols-3 gap-2"
          >
            {PRIORITIES.map((p) => (
              <Label
                key={p.value}
                htmlFor={`prio-${p.value}`}
                className="flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-input p-3 text-center transition-colors hover:bg-accent [&:has([data-state=checked])]:border-primary [&:has([data-state=checked])]:bg-primary/10"
              >
                <RadioGroupItem id={`prio-${p.value}`} value={String(p.value)} className="sr-only" />
                <Flag className="size-4" aria-hidden />
                <span className="text-sm font-medium">{p.label}</span>
                <span className="text-[11px] leading-tight text-muted-foreground">{p.hint}</span>
              </Label>
            ))}
          </RadioGroup>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="task-status">Statut</Label>
            <select
              id="task-status"
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="todo">À faire</option>
              <option value="doing">En cours</option>
              <option value="done">Terminé</option>
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="task-due">Échéance (optionnel)</Label>
            <Input
              id="task-due"
              type="datetime-local"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="task-desc">Description (optionnel)</Label>
          <Textarea
            id="task-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Détails de la tâche…"
            rows={3}
            maxLength={2000}
          />
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          {task ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirmDelete(true)}
              className="mr-auto text-destructive hover:text-destructive"
              aria-label="Supprimer la tâche"
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onDone} disabled={saving}>
            Annuler
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {task ? "Enregistrer" : "Créer"}
          </Button>
        </DialogFooter>
      </form>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer cette tâche ?</AlertDialogTitle>
            <AlertDialogDescription>
              « {task?.title} »{" "}
              {task?.dueDate ? `(${format(new Date(task.dueDate), "d MMMM", { locale: fr })}) ` : ""}
              sera définitivement supprimée.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Supprimer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
