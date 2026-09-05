"use client";

// Orbit — TagManager : gestion des tags (création, renommage, couleur, suppression).
// ─────────────────────────────────────────────────────────────────────────────
// Dialog listant les tags de l'utilisateur : création en haut (nom + ColorPicker),
// chaque ligne = pastille couleur + nom + nombre de tâches associées + édition
// inline (Input nom + ColorPicker) + suppression avec confirmation LÉGÈRE INLINE
// (la ligne devient « Supprimer ce tag ? » — pas d'overlay). La suppression
// détache le tag sans toucher les tâches (contrat backend). 409 (doublon) →
// toast d'erreur. Mutations via useTagMutations (invalidation tasks+tags+stats).

import { useState } from "react"
import { Check, Pencil, Plus, Tag as TagIcon, Trash2, X } from "lucide-react"
import { toast } from "sonner"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { foldText } from "@/lib/tasks"
import { useTagMutations, useTags } from "@/lib/api-client"
import { ColorPicker } from "@/components/orbit/color-picker"

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Une erreur est survenue"
}

/** Couleur par défaut des nouveaux tags (cyan de marque). */
const DEFAULT_TAG_COLOR = "#00D4FF"

function TagManager({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { data, isLoading } = useTags()
  const { create, update, remove } = useTagMutations()
  const tags = data?.tags ?? []

  // ----- Création -----
  const [newName, setNewName] = useState("")
  const [newColor, setNewColor] = useState<string | null>(DEFAULT_TAG_COLOR)

  // ----- Édition inline -----
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState("")
  const [editColor, setEditColor] = useState<string | null>(null)

  // ----- Confirmation de suppression (inline) -----
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)

  const saving = create.isPending || update.isPending || remove.isPending

  /** Crée un tag (le serveur rejette les doublons → 409 → toast). */
  const handleCreate = async () => {
    const name = newName.trim()
    if (name === "") {
      toast.error("Le nom du tag est requis")
      return
    }
    try {
      await create.mutateAsync({ name, color: newColor ?? DEFAULT_TAG_COLOR })
      toast.success("Tag créé", { description: `« ${name} » est prêt à l'emploi.` })
      setNewName("")
    } catch (err) {
      toast.error("Création impossible", { description: errMessage(err) })
    }
  }

  const startEdit = (tag: { id: string; name: string; color: string }) => {
    setConfirmDeleteId(null)
    setEditingId(tag.id)
    setEditName(tag.name)
    setEditColor(tag.color)
  }

  const handleSaveEdit = async (tagId: string) => {
    const name = editName.trim()
    if (name === "") {
      toast.error("Le nom du tag est requis")
      return
    }
    try {
      await update.mutateAsync({ id: tagId, name, color: editColor ?? DEFAULT_TAG_COLOR })
      toast.success("Tag mis à jour")
      setEditingId(null)
    } catch (err) {
      toast.error("Mise à jour impossible", { description: errMessage(err) })
    }
  }

  const handleDelete = async (tag: { id: string; name: string }) => {
    try {
      await remove.mutateAsync(tag.id)
      toast.success("Tag supprimé", {
        description: `« ${tag.name} » a été détaché — vos tâches restent intactes.`,
      })
      setConfirmDeleteId(null)
    } catch (err) {
      toast.error("Suppression impossible", { description: errMessage(err) })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <TagIcon className="size-5 text-primary" aria-hidden="true" />
            Gérer les tags
          </DialogTitle>
          <DialogDescription>
            Les tags sont partagés entre vos tâches. La suppression détache le
            tag sans modifier les tâches.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* ----- Création ----- */}
          <div className="space-y-2.5 rounded-lg border border-border/60 bg-muted/30 p-3">
            <div className="flex items-center gap-2">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault()
                    void handleCreate()
                  }
                }}
                placeholder="Nom du nouveau tag…"
                maxLength={50}
                disabled={saving}
                aria-label="Nom du nouveau tag"
              />
              <Button
                type="button"
                size="sm"
                className="h-9 shrink-0 gap-1.5"
                disabled={saving || newName.trim() === ""}
                onClick={() => void handleCreate()}
              >
                <Plus className="size-4" aria-hidden="true" />
                Ajouter
              </Button>
            </div>
            <ColorPicker
              value={newColor}
              onChange={setNewColor}
              disabled={saving}
              className="gap-1.5"
            />
          </div>

          {/* ----- Liste des tags ----- */}
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-12 rounded-lg" />
              ))}
            </div>
          ) : tags.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
              Aucun tag pour l&apos;instant — créez-en un ci-dessus pour
              organiser vos tâches.
            </p>
          ) : (
            <ScrollArea className="max-h-72 pr-2">
              <ul className="space-y-1.5">
                {tags.map((tag) => {
                  const editing = editingId === tag.id
                  const confirming = confirmDeleteId === tag.id
                  const nameExists =
                    editing &&
                    foldText(editName) !== foldText(tag.name) &&
                    tags.some((t) => t.id !== tag.id && foldText(t.name) === foldText(editName))

                  if (confirming) {
                    return (
                      <li
                        key={tag.id}
                        className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2"
                      >
                        <span className="min-w-0 flex-1 text-sm">
                          Supprimer « <span className="font-medium">{tag.name}</span> » ?
                          <span className="ml-1 text-xs text-muted-foreground">
                            {tag.taskCount} tâche{tag.taskCount > 1 ? "s" : ""} concernée
                            {tag.taskCount > 1 ? "s" : ""}
                          </span>
                        </span>
                        <Button
                          type="button"
                          size="sm"
                          variant="destructive"
                          className="h-8"
                          disabled={remove.isPending}
                          onClick={() => void handleDelete(tag)}
                        >
                          Supprimer
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="h-8"
                          disabled={remove.isPending}
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          Annuler
                        </Button>
                      </li>
                    )
                  }

                  if (editing) {
                    return (
                      <li
                        key={tag.id}
                        className="space-y-2.5 rounded-lg border border-primary/40 bg-primary/5 p-3"
                      >
                        <div className="flex items-center gap-2">
                          <Input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault()
                                void handleSaveEdit(tag.id)
                              }
                              if (e.key === "Escape") setEditingId(null)
                            }}
                            maxLength={50}
                            autoFocus
                            disabled={saving}
                            aria-label={`Nouveau nom du tag « ${tag.name} »`}
                            aria-invalid={nameExists}
                          />
                          <Button
                            type="button"
                            size="icon"
                            className="size-9 shrink-0"
                            disabled={saving || editName.trim() === "" || nameExists}
                            onClick={() => void handleSaveEdit(tag.id)}
                            aria-label="Enregistrer le tag"
                          >
                            <Check className="size-4" aria-hidden="true" />
                          </Button>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="size-9 shrink-0"
                            disabled={saving}
                            onClick={() => setEditingId(null)}
                            aria-label="Annuler la modification"
                          >
                            <X className="size-4" aria-hidden="true" />
                          </Button>
                        </div>
                        <ColorPicker
                          value={editColor}
                          onChange={setEditColor}
                          disabled={saving}
                          className="gap-1.5"
                        />
                        {nameExists ? (
                          <p role="alert" className="text-xs text-destructive">
                            Un tag portant ce nom existe déjà.
                          </p>
                        ) : null}
                      </li>
                    )
                  }

                  return (
                    <li
                      key={tag.id}
                      className={cn(
                        "group flex items-center gap-2.5 rounded-lg border border-transparent px-2 py-2 transition-colors hover:border-border/60 hover:bg-accent/40"
                      )}
                    >
                      <span
                        className="size-3.5 shrink-0 rounded-full border border-black/10"
                        style={{ backgroundColor: tag.color }}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {tag.name}
                      </span>
                      <Badge
                        variant="secondary"
                        className="shrink-0 tabular-nums text-[10px] text-muted-foreground"
                        aria-label={`${tag.taskCount} tâche${tag.taskCount > 1 ? "s" : ""} associée${tag.taskCount > 1 ? "s" : ""}`}
                      >
                        {tag.taskCount}
                      </Badge>
                      <div className="flex shrink-0 gap-0.5">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8 text-muted-foreground hover:text-foreground"
                          disabled={saving}
                          onClick={() => startEdit(tag)}
                          aria-label={`Modifier le tag « ${tag.name} »`}
                        >
                          <Pencil className="size-3.5" aria-hidden="true" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="size-8 text-muted-foreground hover:text-destructive"
                          disabled={saving}
                          onClick={() => {
                            setEditingId(null)
                            setConfirmDeleteId(tag.id)
                          }}
                          aria-label={`Supprimer le tag « ${tag.name} »`}
                        >
                          <Trash2 className="size-3.5" aria-hidden="true" />
                        </Button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </ScrollArea>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export { TagManager }
