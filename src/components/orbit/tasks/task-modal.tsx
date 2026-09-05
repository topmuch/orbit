"use client";

// Orbit — TaskModal : création/édition/suppression de tâche (formulaire complet).
// ─────────────────────────────────────────────────────────────────────────────
// API : <TaskModal open onOpenChange task={TaskDto|null} defaultStatus? />
// Dialog sm:max-w-2xl + ScrollArea (pattern event-dialog, ~80vh en réservant
// header/footer). Le formulaire vit dans un composant interne remonté par
// `key` (task id + nonce de « créer une autre ») → initialisation directe dans
// useState, AUCUN setState dans useEffect (pattern maison).
//
// Champs : titre (requis, erreur inline FR), description, statut (Select 4),
// priorité (RadioGroup 4 cartes colorées), échéance (datetime-local EFFAÇABLE),
// tags (Popover : checkbox colorées + création à la volée couleur aléatoire),
// sous-tâches (SubtaskList — mutations directes en édition, liste locale en
// création), lien calendrier (Select des événements à venir + création
// EventDialog pré-rempli depuis l'échéance), section IA (suggestion priorité
// + bouton Appliquer), suppression confirmée (texte différencié actif/archivé).
//
// RÈGLE D'ÉCHÉANCE : datetime-local = chaîne LOCALE du navigateur
// (« yyyy-MM-ddTHH:mm » → new Date() en heure locale → toISOString() en UTC) ;
// l'affichage (formatDueDate) utilise la même convention.

import { useMemo, useState } from "react"
import { addDays, format } from "date-fns"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  Bot,
  CalendarDays,
  Circle,
  CircleDot,
  FileText,
  Flame,
  ListTodo,
  Loader2,
  Plus,
  Sparkles,
  Tag as TagIcon,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react"
import { cn } from "@/lib/utils"
import {
  TASK_PRIORITIES,
  TASK_PRIORITY_LABELS,
  TASK_STATUSES,
  TASK_STATUS_LABELS,
  foldText,
} from "@/lib/tasks"
import {
  useAIPrioritySuggestion,
  useEvents,
  useTagMutations,
  useTags,
  useTaskMutations,
} from "@/lib/api-client"
import type { TaskDto, TaskPriority, TaskStatus, TaskUpdateInput } from "@/lib/types"
import { PRIORITY_COLORS } from "@/components/orbit/tasks/priority-badge"
import { SubtaskList, type LocalSubtask } from "@/components/orbit/tasks/subtask-list"
import { EventDialog } from "@/components/orbit/event-dialog"
import { AiSummaryDialog } from "@/components/orbit/ai/ai-summary-dialog"

// ─────────────────────────────────────────────────────────────────────────────
// Constantes
// ─────────────────────────────────────────────────────────────────────────────

/** Options de priorité (cartes RadioGroup — icônes + couleurs spec). */
const PRIORITY_OPTIONS: {
  value: TaskPriority
  label: string
  hint: string
  icon: React.ElementType
}[] = [
  { value: "LOW", label: "Basse", hint: "Quand j'aurai le temps", icon: Circle },
  { value: "MEDIUM", label: "Moyenne", hint: "À traiter cette semaine", icon: CircleDot },
  { value: "HIGH", label: "Haute", hint: "Priorité immédiate", icon: TriangleAlert },
  { value: "URGENT", label: "Urgente", hint: "Maintenant, sans délai", icon: Flame },
]

/** Couleurs aléatoires pour la création de tags à la volée. */
const TAG_AUTO_COLORS = [
  "#00D4FF",
  "#FF6B35",
  "#8B5CF6",
  "#F59E0B",
  "#10B981",
  "#EF4444",
  "#14B8A6",
  "#3B82F6",
] as const

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Une erreur est survenue"
}

/** Tag sélectionné localement (le serveur upsert par nom au submit). */
type SelectedTag = { name: string; color: string }

// ─────────────────────────────────────────────────────────────────────────────
// Modal (coquille + remontage du formulaire)
// ─────────────────────────────────────────────────────────────────────────────

export function TaskModal({
  open,
  onOpenChange,
  task,
  defaultStatus = "todo",
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Tâche existante → édition ; null → création. */
  task?: TaskDto | null
  /** Statut pré-sélectionné à la création (colonne d'origine). */
  defaultStatus?: TaskStatus
}) {
  // Nonce incrémenté après « Enregistrer et ajouter une autre » → remontage
  // complet du formulaire (vide) sans fermer le dialog.
  const [formNonce, setFormNonce] = useState(0)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 sm:max-w-2xl">
        <TaskForm
          key={`${task?.id ?? "new"}-${formNonce}`}
          task={task ?? null}
          defaultStatus={defaultStatus}
          onDone={() => onOpenChange(false)}
          onCreatedAnother={() => setFormNonce((n) => n + 1)}
        />
      </DialogContent>
    </Dialog>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Formulaire
// ─────────────────────────────────────────────────────────────────────────────

/** Suggestion IA locale (priorité) — affichée dans la section dédiée du modal. */
type LocalAiSuggestion = {
  priority: TaskPriority
  confidence: number
  reasoning: string
  /** true = lue depuis la base (persistée) ; false = suggestion fraîche. */
  fromDb: boolean
}

function TaskForm({
  task,
  defaultStatus,
  onDone,
  onCreatedAnother,
}: {
  task: TaskDto | null
  defaultStatus: TaskStatus
  onDone: () => void
  onCreatedAnother: () => void
}) {
  const { create, update, removeHard } = useTaskMutations()
  const { data: tagsData } = useTags()
  const { create: createTag } = useTagMutations()
  const aiSuggest = useAIPrioritySuggestion()

  // ----- Champs contrôlés (initialisation directe, zéro useEffect) -----
  const [title, setTitle] = useState(task?.title ?? "")
  const [titleError, setTitleError] = useState<string | null>(null)
  const [description, setDescription] = useState(task?.description ?? "")
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? defaultStatus)
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? "MEDIUM")
  // Chaîne locale « yyyy-MM-ddTHH:mm » (vide = pas d'échéance).
  const [dueDate, setDueDate] = useState(() =>
    task?.dueDate ? formatLocalInput(task.dueDate) : ""
  )
  const [selectedTags, setSelectedTags] = useState<SelectedTag[]>(
    () => task?.tags.map((t) => ({ name: t.name, color: t.color })) ?? []
  )
  const [eventId, setEventId] = useState<string | null>(task?.eventId ?? null)
  // Suggestion IA locale : priorité + confiance + raisonnement. Disparaît après
  // « Appliquer » ou « Ignorer » (en édition, la suggestion est persistée en
  // base via POST /api/ai/suggest-priority jusqu'à décision de l'utilisateur).
  const [aiSuggestion, setAiSuggestion] = useState<LocalAiSuggestion | null>(
    task?.aiSuggestedPriority
      ? {
          priority: task.aiSuggestedPriority,
          confidence: task.aiConfidence ?? 0.5,
          reasoning: "",
          fromDb: true,
        }
      : null
  )
  // Dialog de synthèse IA (descriptions longues, ≥ 400 caractères).
  const [summaryOpen, setSummaryOpen] = useState(false)
  // Sous-tâches : mutations directes en édition (taskId), liste locale en création.
  const [localSubtasks, setLocalSubtasks] = useState<LocalSubtask[]>([])

  const [confirmDelete, setConfirmDelete] = useState(false)
  const [eventDialogOpen, setEventDialogOpen] = useState(false)
  const [tagsPopoverOpen, setTagsPopoverOpen] = useState(false)
  const [newTagName, setNewTagName] = useState("")

  const saving = create.isPending || update.isPending || removeHard.isPending

  // ----- Événements à venir (lien calendrier — 180 j de marge, incl. passés proches) -----
  // Plage STABLE au montage (sinon queryKey instable → boucle de refetch).
  const [eventsFrom, eventsTo] = useMemo(
    () => [addDays(new Date(), -60), addDays(new Date(), 180)],
    []
  )
  const { data: eventsData } = useEvents(eventsFrom, eventsTo)
  // Dédupliqué par id de série : une série récurrente expansée produit
  // plusieurs occurrences partageant le même id maître — le Select lierait
  // de toute façon la tâche au même événement (clés Radix dupliquées sinon).
  // On garde, par série, l'occurrence la plus pertinente : la prochaine à
  // venir, sinon la dernière passée (événements récents toujours affichés).
  const upcomingEvents = useMemo(() => {
    const all = [...(eventsData?.events ?? [])].sort(
      (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
    )
    const now = Date.now()
    const upcoming = new Map<string, (typeof all)[number]>() // 1re occurrence à venir
    const past = new Map<string, (typeof all)[number]>() // dernière occurrence passée
    for (const ev of all) {
      const t = new Date(ev.startTime).getTime()
      if (t >= now) {
        if (!upcoming.has(ev.id)) upcoming.set(ev.id, ev)
      } else {
        past.set(ev.id, ev) // itération croissante → garde la plus récente
      }
    }
    const byId = new Map(past)
    for (const [id, ev] of upcoming) byId.set(id, ev)
    return [...byId.values()].sort(
      (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
    )
  }, [eventsData])
  const eventLabel = (iso: string) => format(new Date(iso), "EEE d MMM · HH:mm", { locale: fr })

  // ----- Tags : helpers -----

  const toggleTag = (tag: { name: string; color: string }, checked: boolean) => {
    setSelectedTags((prev) =>
      checked
        ? [...prev.filter((t) => t.name !== tag.name), { name: tag.name, color: tag.color }]
        : prev.filter((t) => t.name !== tag.name)
    )
  }

  /** Création à la volée (couleur aléatoire) ou sélection si le nom existe. */
  const handleCreateTag = async () => {
    const name = newTagName.trim()
    if (name === "") return
    const existing = (tagsData?.tags ?? []).find((t) => foldText(t.name) === foldText(name))
    if (existing) {
      toast.info("Ce tag existe déjà — il a été sélectionné", {
        description: `« ${existing.name} »`,
      })
      toggleTag(existing, true)
      setNewTagName("")
      return
    }
    const color = TAG_AUTO_COLORS[Math.floor(Math.random() * TAG_AUTO_COLORS.length)]
    try {
      const res = await createTag.mutateAsync({ name, color })
      toggleTag(res.tag, true)
      setNewTagName("")
      toast.success("Tag créé", { description: `« ${res.tag.name} »` })
    } catch (err) {
      toast.error("Création impossible", { description: errMessage(err) })
    }
  }

  // ----- Section IA : demander, appliquer, ignorer -----

  const handleAskAi = async () => {
    if (aiSuggest.isPending) return
    const trimmedTitle = title.trim()
    if (!task && !trimmedTitle) {
      toast.error("Titre requis", {
        description: "Renseignez au moins le titre de la tâche avant de demander une suggestion.",
      })
      return
    }
    try {
      const res = await aiSuggest.mutateAsync(
        task
          ? { taskId: task.id }
          : {
              title: trimmedTitle,
              description: description.trim() || null,
              dueDate: dueDate ? new Date(dueDate).toISOString() : null,
            }
      )
      const s = res.suggestion
      setAiSuggestion({
        priority: s.priority,
        confidence: s.confidence,
        reasoning: s.reasoning,
        fromDb: s.persisted,
      })
    } catch (err) {
      toast.error("Suggestion impossible", { description: errMessage(err) })
    }
  }

  const handleApplySuggestion = async () => {
    if (!aiSuggestion) return
    if (task) {
      try {
        await update.mutateAsync({
          id: task.id,
          input: { priority: aiSuggestion.priority, aiSuggestedPriority: null },
        })
        toast.success("Suggestion appliquée", {
          description: `Priorité mise à « ${TASK_PRIORITY_LABELS[aiSuggestion.priority]} ».`,
        })
      } catch (err) {
        toast.error("Application impossible", { description: errMessage(err) })
        return
      }
    } else {
      toast.success("Suggestion appliquée", {
        description: `Priorité mise à « ${TASK_PRIORITY_LABELS[aiSuggestion.priority]} » — pensez à enregistrer la tâche.`,
      })
    }
    setPriority(aiSuggestion.priority)
    setAiSuggestion(null)
  }

  /** Ignorer : efface localement ET en base (sinon elle reviendrait à la réouverture). */
  const handleDismissSuggestion = async () => {
    if (task) {
      try {
        await update.mutateAsync({
          id: task.id,
          input: { aiSuggestedPriority: null },
        })
      } catch (err) {
        toast.error("Suppression impossible", { description: errMessage(err) })
        return
      }
    }
    setAiSuggestion(null)
    toast.info("Suggestion ignorée")
  }

  // ----- Suppression (hard delete, confirmée) -----

  const handleDelete = async () => {
    if (!task) return
    try {
      await removeHard.mutateAsync(task.id)
      toast.success("Tâche supprimée", {
        description: `« ${task.title} » a été définitivement supprimée.`,
      })
      setConfirmDelete(false)
      onDone()
    } catch (err) {
      toast.error("Suppression impossible", { description: errMessage(err) })
    }
  }

  // ----- Submit -----

  /** Enregistre la tâche. `again` = « Enregistrer et ajouter une autre ». */
  const handleSubmit = async (again: boolean) => {
    if (title.trim() === "") {
      setTitleError("Le titre est requis")
      return
    }
    setTitleError(null)

    const due = dueDate ? new Date(dueDate).toISOString() : null
    const tagsInput = selectedTags.map((t) => ({ name: t.name, color: t.color }))

    try {
      if (task) {
        // ÉDITION : on n'envoie JAMAIS subtasks (elles sont mutées en direct —
        // un tableau envoyé serait un REMPLACEMENT complet, cf. contrat API).
        const input: TaskUpdateInput = {
          title: title.trim(),
          description: description.trim() || null,
          status,
          priority,
          dueDate: due,
          tags: tagsInput,
          eventId,
          // Priorité changée manuellement → la suggestion IA est obsolète.
          ...(priority !== task.priority ? { aiSuggestedPriority: null } : {}),
        }
        await update.mutateAsync({ id: task.id, input })
        toast.success("Tâche mise à jour", { description: title.trim() })
        onDone()
      } else {
        await create.mutateAsync({
          title: title.trim(),
          description: description.trim() || null,
          status,
          priority,
          dueDate: due,
          tags: tagsInput,
          subtasks: localSubtasks.map((s) => ({ title: s.title })),
          eventId: eventId ?? undefined,
        })
        toast.success("Tâche créée", { description: title.trim() })
        if (again) {
          onCreatedAnother() // remonte le formulaire vide
        } else {
          onDone()
        }
      }
    } catch (err) {
      toast.error("Enregistrement impossible", { description: errMessage(err) })
    }
  }

  // ----- Rendu -----

  return (
    <>
      <DialogHeader className="pr-8">
        <DialogTitle className="flex items-center gap-2">
          <ListTodo className="size-5 text-primary" aria-hidden="true" />
          {task ? "Modifier la tâche" : "Nouvelle tâche"}
        </DialogTitle>
        <DialogDescription>
          {task
            ? "Ajustez les détails de votre tâche."
            : "Ajoutez une tâche à votre tableau Orbit."}
        </DialogDescription>
      </DialogHeader>

      <ScrollArea className="max-h-[calc(100vh-16rem)] px-1">
        <form
          id="task-form"
          className="space-y-5 py-1"
          onSubmit={(e) => {
            e.preventDefault()
            void handleSubmit(false)
          }}
        >
          {/* ----- Titre + description ----- */}
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="task-title">
                Titre <span className="text-destructive" aria-hidden="true">*</span>
              </Label>
              <Input
                id="task-title"
                value={title}
                onChange={(e) => {
                  setTitle(e.target.value)
                  if (titleError) setTitleError(null)
                }}
                placeholder="Ex. Préparer la présentation Orbit"
                maxLength={200}
                autoFocus
                aria-invalid={titleError !== null}
                aria-describedby={titleError ? "task-title-error" : undefined}
              />
              {titleError ? (
                <p id="task-title-error" role="alert" className="text-xs font-medium text-destructive">
                  {titleError}
                </p>
              ) : null}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="task-desc">Description (optionnel)</Label>
                {description.trim().length >= 400 ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-xs text-violet-600 hover:bg-violet-500/10 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300"
                    onClick={() => setSummaryOpen(true)}
                  >
                    <FileText className="size-3.5" aria-hidden="true" />
                    Résumer avec l'IA
                  </Button>
                ) : null}
              </div>
              <Textarea
                id="task-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Détails de la tâche…"
                rows={3}
                maxLength={10000}
              />
            </div>
          </div>

          {/* ----- Statut + échéance ----- */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="task-status">Statut</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as TaskStatus)}>
                <SelectTrigger id="task-status" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TASK_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {TASK_STATUS_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="task-due">Échéance (optionnel)</Label>
              <div className="relative">
                <Input
                  id="task-due"
                  type="datetime-local"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="pr-10"
                />
                {dueDate ? (
                  <button
                    type="button"
                    onClick={() => setDueDate("")}
                    className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="Effacer l'échéance"
                  >
                    <X className="size-4" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          {/* ----- Priorité (4 cartes RadioGroup + suggestion IA) ----- */}
          <fieldset className="space-y-2">
            <legend className="flex w-full items-center justify-between gap-2">
              <span className="text-sm font-medium">Priorité</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs text-violet-600 hover:bg-violet-500/10 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300"
                onClick={() => void handleAskAi()}
                disabled={aiSuggest.isPending || saving}
              >
                {aiSuggest.isPending ? (
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                ) : (
                  <Sparkles className="size-3.5" aria-hidden="true" />
                )}
                {aiSuggest.isPending ? "Analyse en cours…" : "Suggérer avec l'IA"}
              </Button>
            </legend>
            <RadioGroup
              value={priority}
              onValueChange={(v) => setPriority(v as TaskPriority)}
              className="grid grid-cols-2 gap-2 sm:grid-cols-4"
            >
              {PRIORITY_OPTIONS.map((p) => {
                const color = PRIORITY_COLORS[p.value]
                const Icon = p.icon
                return (
                  <Label
                    key={p.value}
                    htmlFor={`prio-${p.value}`}
                    className="flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border border-input p-3 text-center transition-colors hover:bg-accent [&:has([data-state=checked])]:bg-accent/60"
                  >
                    <RadioGroupItem
                      id={`prio-${p.value}`}
                      value={p.value}
                      className="sr-only"
                    />
                    <span className="flex items-center gap-1.5">
                      <span
                        className={cn(
                          "size-2.5 rounded-full",
                          p.value === "URGENT" && "animate-pulse"
                        )}
                        style={{ backgroundColor: color }}
                        aria-hidden="true"
                      />
                      <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
                    </span>
                    <span className="text-sm font-medium">{p.label}</span>
                    <span className="text-[10px] leading-tight text-muted-foreground">
                      {p.hint}
                    </span>
                  </Label>
                )
              })}
            </RadioGroup>
          </fieldset>

          {/* ----- Tags (chips + Popover) ----- */}
          <div className="space-y-2">
            <Label>Tags</Label>
            <div className="flex flex-wrap items-center gap-1.5">
              {selectedTags.map((tag) => (
                <Badge
                  key={tag.name}
                  variant="outline"
                  className="gap-1 border-transparent px-2 py-1 text-xs font-medium"
                  style={{ backgroundColor: `${tag.color}22`, color: tag.color }}
                >
                  <span
                    className="size-1.5 rounded-full"
                    style={{ backgroundColor: tag.color }}
                    aria-hidden="true"
                  />
                  {tag.name}
                  <button
                    type="button"
                    onClick={() => toggleTag(tag, false)}
                    className="ml-0.5 inline-flex size-4 items-center justify-center rounded-full transition-colors hover:bg-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Retirer le tag « ${tag.name} »`}
                  >
                    <X className="size-3" aria-hidden="true" />
                  </button>
                </Badge>
              ))}

              <Popover open={tagsPopoverOpen} onOpenChange={setTagsPopoverOpen}>
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1.5 text-xs"
                  >
                    <TagIcon className="size-3.5" aria-hidden="true" />
                    {selectedTags.length > 0 ? "Modifier les tags" : "Ajouter des tags"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-64 p-2">
                  <div className="px-1 py-1 text-xs font-medium text-muted-foreground">
                    Tags de la tâche
                  </div>
                  <ScrollArea className="max-h-40">
                    <div className="space-y-0.5">
                      {(tagsData?.tags ?? []).map((tag) => {
                        const checked = selectedTags.some((t) => t.name === tag.name)
                        return (
                          <Label
                            key={tag.id}
                            htmlFor={`modal-tag-${tag.id}`}
                            className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-sm font-normal transition-colors hover:bg-accent"
                          >
                            <Checkbox
                              id={`modal-tag-${tag.id}`}
                              checked={checked}
                              onCheckedChange={(c) => toggleTag(tag, c === true)}
                            />
                            <span
                              className="size-2.5 shrink-0 rounded-full"
                              style={{ backgroundColor: tag.color }}
                              aria-hidden="true"
                            />
                            <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                          </Label>
                        )
                      })}
                      {(tagsData?.tags ?? []).length === 0 ? (
                        <p className="px-2 py-2 text-xs text-muted-foreground">
                          Aucun tag existant — créez-en un ci-dessous.
                        </p>
                      ) : null}
                    </div>
                  </ScrollArea>
                  <div className="mt-1.5 flex items-center gap-1.5 border-t border-border/60 pt-2">
                    <Input
                      value={newTagName}
                      onChange={(e) => setNewTagName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault()
                          void handleCreateTag()
                        }
                      }}
                      placeholder="Nouveau tag…"
                      className="h-8 text-xs"
                      maxLength={50}
                    />
                    <Button
                      type="button"
                      size="icon"
                      className="size-8 shrink-0"
                      disabled={createTag.isPending || newTagName.trim() === ""}
                      onClick={() => void handleCreateTag()}
                      aria-label="Créer le tag"
                    >
                      <Plus className="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>
            </div>
          </div>

          {/* ----- Sous-tâches (SubtaskList : directes en édition) ----- */}
          <div className="space-y-2">
            <Label>Sous-tâches</Label>
            <SubtaskList
              taskId={task?.id ?? null}
              localItems={task ? undefined : localSubtasks}
              onLocalChange={task ? undefined : setLocalSubtasks}
            />
          </div>

          {/* ----- Lien calendrier ----- */}
          <div className="space-y-2">
            <Label htmlFor="task-event">Événement lié (optionnel)</Label>
            <div className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <Select
                  value={eventId ?? "__none__"}
                  onValueChange={(v) => setEventId(v === "__none__" ? null : v)}
                >
                  <SelectTrigger id="task-event" className="w-full">
                    <SelectValue placeholder="Aucun événement" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Aucun événement</SelectItem>
                    {upcomingEvents.map((ev) => (
                      <SelectItem key={`${ev.id}-${ev.startTime}`} value={ev.id}>
                        <span className="flex items-center gap-1.5">
                          <CalendarDays className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                          <span className="truncate">{ev.title}</span>
                          <span className="ml-auto pl-2 text-[10px] tabular-nums text-muted-foreground">
                            {eventLabel(ev.startTime)}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                variant="outline"
                className="h-9 shrink-0 gap-1.5"
                onClick={() => setEventDialogOpen(true)}
              >
                <Plus className="size-4" aria-hidden="true" />
                <span className="hidden sm:inline">Créer un événement</span>
                <span className="sr-only sm:hidden">Créer un événement</span>
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Les événements créés apparaissent dans la liste après enregistrement.
            </p>
          </div>

          {/* ----- Section IA (suggestion de priorité) ----- */}
          {aiSuggestion ? (
            <div className="flex items-start gap-3 rounded-lg border border-violet-500/30 bg-violet-500/10 p-3">
              <Bot className="mt-0.5 size-5 shrink-0 text-violet-500 dark:text-violet-400" aria-hidden="true" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-violet-700 dark:text-violet-300">
                  L&apos;IA suggère : Priorité{" "}
                  {TASK_PRIORITY_LABELS[aiSuggestion.priority].toUpperCase()}
                  <span className="font-normal">
                    {" "}
                    (confiance {Math.round(aiSuggestion.confidence * 100)} %)
                  </span>
                </p>
                {aiSuggestion.reasoning ? (
                  <p className="mt-1 text-xs leading-relaxed text-violet-700/80 dark:text-violet-300/80">
                    {aiSuggestion.reasoning}
                  </p>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5 border-violet-500/40 text-violet-700 hover:bg-violet-500/10 hover:text-violet-700 dark:text-violet-300 dark:hover:text-violet-200"
                    disabled={saving}
                    onClick={() => void handleApplySuggestion()}
                  >
                    <Bot className="size-3.5" aria-hidden="true" />
                    Appliquer
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8 gap-1 text-muted-foreground"
                    disabled={saving}
                    onClick={() => void handleDismissSuggestion()}
                  >
                    <X className="size-3.5" aria-hidden="true" />
                    Ignorer
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </form>
      </ScrollArea>

      {/* ----- Footer : Supprimer (édition) / Annuler / Enregistrer ----- */}
      <DialogFooter className="gap-2 border-t border-border/60 pt-4 sm:gap-0">
        {task ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setConfirmDelete(true)}
            className="mr-auto gap-1.5 text-destructive hover:text-destructive"
            aria-label="Supprimer la tâche"
          >
            <Trash2 className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Supprimer</span>
          </Button>
        ) : null}
        <Button type="button" variant="outline" onClick={onDone} disabled={saving}>
          Annuler
        </Button>
        {task ? (
          <Button type="submit" form="task-form" disabled={saving} className="min-w-28">
            {saving ? (
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
            ) : null}
            Enregistrer
          </Button>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              className="hidden gap-1.5 sm:inline-flex"
              onClick={() => void handleSubmit(true)}
            >
              Enregistrer et ajouter une autre
            </Button>
            <Button type="submit" form="task-form" disabled={saving} className="min-w-24">
              {saving ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Plus className="size-4" aria-hidden="true" />
              )}
              Créer
            </Button>
          </>
        )}
      </DialogFooter>

      {/* ----- EventDialog (créer un événement depuis la tâche) ----- */}
      <EventDialog
        open={eventDialogOpen}
        onOpenChange={setEventDialogOpen}
        defaultDate={task?.dueDate ? new Date(task.dueDate) : undefined}
      />

      {/* ----- Synthèse IA de la description (contenus longs) ----- */}
      <AiSummaryDialog
        open={summaryOpen}
        onOpenChange={setSummaryOpen}
        content={description}
        contextLabel="cette description"
      />

      {/* ----- Confirmation de suppression (texte différencié actif/archivé) ----- */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer cette tâche ?</AlertDialogTitle>
            <AlertDialogDescription>
              {task?.status === "archived" ? (
                <>
                  « {task?.title} » (archivée) sera définitivement supprimée, avec
                  ses sous-tâches. Cette action est irréversible.
                </>
              ) : (
                <>
                  « {task?.title} » sera définitivement supprimée, avec ses
                  sous-tâches. Cette action est irréversible — pour la garder en
                  réserve, préférez « Archiver ».
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeHard.isPending}>Annuler</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive"
              disabled={removeHard.isPending}
              onClick={(e) => {
                e.preventDefault() // on garde le dialog ouvert jusqu'au résultat
                void handleDelete()
              }}
            >
              {removeHard.isPending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Trash2 className="size-4" aria-hidden="true" />
              )}
              Supprimer définitivement
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** ISO UTC → chaîne locale « yyyy-MM-ddTHH:mm » pour datetime-local. */
function formatLocalInput(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ""
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
