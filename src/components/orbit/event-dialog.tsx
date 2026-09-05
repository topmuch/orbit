"use client";

// Orbit — Dialog création/édition/suppression d'événement
// API : <EventDialog open onOpenChange event={EventDto|null} defaultDate={Date?} source? />
// Le formulaire vit dans un composant interne remonté à chaque ouverture (contenu Radix
// démonté quand le dialog est fermé) → initialisation directe dans useState, sans effet.

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
import { Badge } from "@/components/ui/badge"
import { CalendarDays, Trash2, Loader2 } from "lucide-react"
import { useEventMutations } from "@/lib/api-client"
import type { EventDto } from "@/lib/types"

function addHour(time: string): string {
  const [h, m] = time.split(":").map(Number)
  return format(new Date(2000, 0, 1, (h + 1) % 24, m), "HH:mm")
}

function toLocalInput(d: Date): { date: string; time: string } {
  return { date: format(d, "yyyy-MM-dd"), time: format(d, "HH:mm") }
}

export function EventDialog({
  open,
  onOpenChange,
  event,
  defaultDate,
  source,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Événement existant → mode édition ; null → mode création */
  event?: EventDto | null
  /** Date pré-sélectionnée à la création */
  defaultDate?: Date
  /** Source à la création (ex: extraction email) */
  source?: "manual" | "email_extract" | "ai"
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <EventForm
          key={event?.id ?? "new"}
          event={event ?? null}
          defaultDate={defaultDate}
          source={source}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

function EventForm({
  event,
  defaultDate,
  source,
  onDone,
}: {
  event: EventDto | null
  defaultDate?: Date
  source?: "manual" | "email_extract" | "ai"
  onDone: () => void
}) {
  const { create, update, remove } = useEventMutations()

  const base = event ? new Date(event.startTime) : (defaultDate ?? new Date())
  const b = toLocalInput(base)

  const [title, setTitle] = useState(event?.title ?? "")
  const [description, setDescription] = useState(event?.description ?? "")
  const [date, setDate] = useState(b.date)
  const [start, setStart] = useState(b.time)
  const [end, setEnd] = useState(() => {
    if (!event) return addHour(b.time)
    const s = toLocalInput(new Date(event.startTime))
    const e = toLocalInput(new Date(event.endTime))
    return e.date === s.date ? e.time : addHour(s.time)
  })
  const [confirmDelete, setConfirmDelete] = useState(false)

  const saving = create.isPending || update.isPending || remove.isPending

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) return toast.error("Le titre est requis")
    if (!date) return toast.error("La date est requise")

    const startTime = new Date(`${date}T${start}`)
    let endTime = new Date(`${date}T${end}`)
    if (end < start) endTime = new Date(endTime.getTime() + 24 * 3600_000) // passe minuit

    if (endTime <= startTime) return toast.error("L'heure de fin doit suivre l'heure de début")

    try {
      if (event) {
        await update.mutateAsync({
          id: event.id,
          input: {
            title: title.trim(),
            description: description.trim() || undefined,
            startTime: startTime.toISOString(),
            endTime: endTime.toISOString(),
          },
        })
        toast.success("Événement mis à jour")
      } else {
        await create.mutateAsync({
          title: title.trim(),
          description: description.trim() || undefined,
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          source: source ?? "manual",
        })
        toast.success("Événement créé", {
          description: `${format(startTime, "EEEE d MMMM", { locale: fr })} · ${format(startTime, "HH:mm")}–${format(endTime, "HH:mm")}`,
        })
      }
      onDone()
    } catch (err) {
      toast.error((err as Error).message ?? "Une erreur est survenue")
    }
  }

  async function handleDelete() {
    if (!event) return
    try {
      await remove.mutateAsync(event.id)
      toast.success("Événement supprimé")
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
          <CalendarDays className="size-5 text-primary" aria-hidden />
          {event ? "Modifier l'événement" : "Nouvel événement"}
        </DialogTitle>
        <DialogDescription>
          {event
            ? "Ajustez les détails de votre événement."
            : "Ajoutez un rendez-vous à votre calendrier Orbit."}
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="event-title">Titre</Label>
          <Input
            id="event-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ex. Réunion d'équipe"
            maxLength={120}
            autoFocus
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="event-date">Date</Label>
          <Input
            id="event-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <Label htmlFor="event-start">Début</Label>
            <Input
              id="event-start"
              type="time"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="event-end">Fin</Label>
            <Input
              id="event-end"
              type="time"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label htmlFor="event-desc">Description (optionnel)</Label>
          <Textarea
            id="event-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Détails, lieu, participants…"
            rows={3}
            maxLength={2000}
          />
        </div>

        {event && event.source !== "manual" && (
          <Badge variant="secondary" className="gap-1">
            {event.source === "email_extract" ? "Extrait d'un email" : "Créé par l'IA"}
          </Badge>
        )}

        <DialogFooter className="gap-2 sm:gap-0">
          {event ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirmDelete(true)}
              className="mr-auto text-destructive hover:text-destructive"
              aria-label="Supprimer l'événement"
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onDone} disabled={saving}>
            Annuler
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {event ? "Enregistrer" : "Créer"}
          </Button>
        </DialogFooter>
      </form>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer cet événement ?</AlertDialogTitle>
            <AlertDialogDescription>
              « {event?.title} » sera définitivement retiré de votre calendrier.
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
