"use client";

// Orbit — Boîte de réception + analyse IA des emails
// Sélection contrôlée par le parent (permet la navigation dashboard → email précis).

import { useState } from "react"
import { differenceInMinutes, format, parseISO } from "date-fns"
import { fr } from "date-fns/locale"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Input } from "@/components/ui/input"
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
import { useEmails, useEmailMutations, useEventMutations } from "@/lib/api-client"
import type { EmailDto, OrbitView } from "@/lib/types"
import {
  Inbox,
  RefreshCw,
  Sparkles,
  Trash2,
  MailOpen,
  Search,
  CalendarCheck,
  CalendarPlus,
  X,
  Loader2,
  Check,
  ArrowLeft,
  ScanSearch,
} from "lucide-react"

function durationLabel(startISO: string, endISO: string): string {
  const mins = differenceInMinutes(parseISO(endISO), parseISO(startISO))
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `${h} h` : `${h} h ${m}`
}

export function EmailsView({
  selectedId,
  onSelect,
  onNavigate,
}: {
  selectedId: string | null
  onSelect: (id: string | null) => void
  onNavigate?: (view: OrbitView) => void
}) {
  const { data, isLoading } = useEmails()
  const { patch, remove, sync, analyze } = useEmailMutations()
  const { create: createEvent } = useEventMutations()

  const [search, setSearch] = useState("")
  const [confirmDelete, setConfirmDelete] = useState(false)

  const emails = data?.emails ?? []
  const filtered = search
    ? emails.filter((e) => {
        const q = search.toLowerCase()
        return (
          e.subject.toLowerCase().includes(q) ||
          (e.fromName ?? e.fromAddress).toLowerCase().includes(q) ||
          e.bodyText.toLowerCase().includes(q)
        )
      })
    : emails

  const selected = emails.find((e) => e.id === selectedId) ?? null
  const creating = createEvent.isPending

  function handleSelect(email: EmailDto) {
    onSelect(email.id)
    if (!email.isRead) patch.mutate({ id: email.id, isRead: true })
  }

  async function handleAnalyze(email: EmailDto) {
    try {
      const res = await analyze.mutateAsync(email.id)
      if (!res.suggestion) {
        await patch.mutateAsync({ id: email.id, isProcessed: true })
        toast.info("Aucun événement détecté", {
          description: res.message ?? "Cet email ne semble pas contenir de rendez-vous.",
        })
      } else {
        toast.success("Événement détecté 🎯", {
          description: "Vérifiez la suggestion puis confirmez.",
        })
      }
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function handleCreateEvent(email: EmailDto) {
    const s = email.suggestedEvent
    if (!s) return
    try {
      await createEvent.mutateAsync({
        title: s.title,
        description: `${s.description}\n\n(Source : email de ${email.fromName ?? email.fromAddress} — « ${email.subject} »)`.trim(),
        startTime: s.startTime,
        endTime: s.endTime,
        source: "email_extract",
      })
      await patch.mutateAsync({ id: email.id, isProcessed: true })
      toast.success("Événement ajouté au calendrier", {
        description: `${format(parseISO(s.startTime), "EEEE d MMMM 'à' HH:mm", { locale: fr })}`,
        action: onNavigate
          ? { label: "Voir", onClick: () => onNavigate("calendar") }
          : undefined,
      })
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function handleDismiss(email: EmailDto) {
    try {
      await patch.mutateAsync({ id: email.id, isProcessed: true })
      toast.info("Suggestion ignorée")
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function handleDelete() {
    if (!selected) return
    try {
      await remove.mutateAsync(selected.id)
      onSelect(null)
      setConfirmDelete(false)
      toast.success("Email supprimé")
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const listNode = (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 p-3">
        <div className="relative flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Rechercher…"
            className="h-9 pl-9"
            aria-label="Rechercher dans les emails"
          />
        </div>
        <Button
          size="icon"
          variant="outline"
          className="size-9"
          onClick={async () => {
            try {
              const res = await sync.mutateAsync()
              toast.success(`${res.count} nouvel(s) email(s)`)
            } catch (err) {
              toast.error((err as Error).message)
            }
          }}
          disabled={sync.isPending}
          aria-label="Synchroniser la boîte de réception"
        >
          <RefreshCw className={sync.isPending ? "size-4 animate-spin" : "size-4"} aria-hidden />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1 orbit-scroll">
        <div className="space-y-1 px-2 pb-3">
          {isLoading ? (
            Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="mx-1 h-16 rounded-lg" />
            ))
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
              <Inbox className="size-8" aria-hidden />
              <p className="text-sm">
                {search ? "Aucun résultat pour cette recherche" : "Boîte vide — synchronisez vos emails"}
              </p>
            </div>
          ) : (
            filtered.map((email) => {
              const isSelected = email.id === selectedId
              return (
                <button
                  key={email.id}
                  onClick={() => handleSelect(email)}
                  className={`w-full rounded-lg p-3 text-left transition-colors ${
                    isSelected ? "bg-accent ring-1 ring-primary/30" : "hover:bg-accent/50"
                  }`}
                  aria-current={isSelected ? "true" : undefined}
                >
                  <div className="flex items-center gap-2">
                    <span
                      className={`size-2 shrink-0 rounded-full ${email.isRead ? "bg-transparent" : "bg-violet-500"}`}
                      aria-hidden
                    />
                    <span className={`min-w-0 flex-1 truncate text-sm ${email.isRead ? "font-normal" : "font-semibold"}`}>
                      {email.fromName ?? email.fromAddress}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {format(parseISO(email.receivedAt), "d MMM · HH:mm", { locale: fr })}
                    </span>
                  </div>
                  <p className={`mt-0.5 truncate text-[13px] ${email.isRead ? "" : "font-medium"}`}>
                    {email.subject}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {email.bodyText.replace(/\s+/g, " ").slice(0, 80)}
                  </p>
                  {!email.isProcessed && (
                    <Badge variant="outline" className="mt-1.5 gap-1 border-violet-500/30 px-1.5 text-[10px] text-violet-500">
                      <Sparkles className="size-2.5" aria-hidden />
                      À analyser
                    </Badge>
                  )}
                </button>
              )
            })
          )}
        </div>
      </ScrollArea>
    </div>
  )

  const detailNode = selected ? (
    <div className="flex h-full min-h-0 flex-col">
      {/* Barre d'actions */}
      <div className="flex items-center justify-between gap-2 border-b border-border/60 p-3">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1 lg:hidden"
          onClick={() => onSelect(null)}
        >
          <ArrowLeft className="size-4" aria-hidden />
          Boîte
        </Button>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-9"
            onClick={() => patch.mutate({ id: selected.id, isRead: !selected.isRead })}
            aria-label={selected.isRead ? "Marquer comme non lu" : "Marquer comme lu"}
          >
            <MailOpen className="size-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-9 text-destructive hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
            aria-label="Supprimer l'email"
          >
            <Trash2 className="size-4" aria-hidden />
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1 orbit-scroll">
        <div className="space-y-5 p-4 sm:p-6">
          {/* En-tête email */}
          <div>
            <h2 className="text-lg font-semibold leading-snug sm:text-xl">{selected.subject}</h2>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {selected.fromName ?? selected.fromAddress}
              </span>
              <span>&lt;{selected.fromAddress}&gt;</span>
              <span>·</span>
              <span>{format(parseISO(selected.receivedAt), "EEEE d MMMM yyyy 'à' HH:mm", { locale: fr })}</span>
            </div>
          </div>

          {/* Corps */}
          <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground/90">
            {selected.bodyText}
          </div>

          {/* Zone IA */}
          {selected.isProcessed && !selected.suggestedEvent ? (
            <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 p-4 text-sm text-muted-foreground">
              <Check className="size-4 shrink-0 text-emerald-500" aria-hidden />
              Email traité — analyse terminée.
            </div>
          ) : selected.suggestedEvent ? (
            <SuggestionCard
              suggestion={selected.suggestedEvent}
              onCreate={() => handleCreateEvent(selected)}
              onDismiss={() => handleDismiss(selected)}
              creating={creating}
            />
          ) : (
            <div className="rounded-xl border border-violet-500/25 bg-violet-500/5 p-4">
              <div className="flex items-start gap-3">
                <ScanSearch className="mt-0.5 size-5 shrink-0 text-violet-500" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Analyse intelligente</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Orbit détecte les rendez-vous et échéances cachés dans cet email
                    et les transforme en événements de calendrier.
                  </p>
                  <Button
                    size="sm"
                    className="mt-3"
                    onClick={() => handleAnalyze(selected)}
                    disabled={analyze.isPending}
                  >
                    {analyze.isPending ? (
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                    ) : (
                      <Sparkles className="size-4" aria-hidden />
                    )}
                    {analyze.isPending ? "Analyse en cours…" : "Analyser avec l'IA"}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  ) : (
    <div className="hidden h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground lg:flex">
      <Inbox className="size-10" aria-hidden />
      <p className="font-medium text-foreground">Sélectionnez un email</p>
      <p className="max-w-xs text-sm">
        Choisissez un message pour le lire, puis laissez l&apos;IA y repérer vos prochains rendez-vous.
      </p>
    </div>
  )

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Boîte de réception</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {emails.length} messages · {emails.filter((e) => !e.isRead).length} non lus ·{" "}
            {emails.filter((e) => !e.isProcessed).length} à analyser
          </p>
        </div>
      </header>

      <Card className="overflow-hidden border-border/60 bg-card/70 backdrop-blur-sm">
        <div className="grid h-[calc(100vh-16rem)] min-h-[420px] lg:grid-cols-[minmax(300px,380px)_1fr]">
          {/* Mobile : liste OU détail */}
          <div className={`min-h-0 ${selected ? "hidden lg:flex lg:flex-col" : "flex flex-col"}`}>
            {listNode}
          </div>
          <div className={`min-h-0 border-t border-border/60 lg:border-l lg:border-t-0 ${selected ? "flex flex-col" : "hidden lg:flex lg:flex-col"}`}>
            {detailNode}
          </div>
        </div>
      </Card>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer cet email ?</AlertDialogTitle>
            <AlertDialogDescription>
              « {selected?.subject} » sera définitivement supprimé de votre boîte Orbit.
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
    </div>
  )
}

function SuggestionCard({
  suggestion,
  onCreate,
  onDismiss,
  creating,
}: {
  suggestion: NonNullable<EmailDto["suggestedEvent"]>
  onCreate: () => void
  onDismiss: () => void
  creating: boolean
}) {
  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-emerald-500" aria-hidden />
        <p className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
          Rendez-vous détecté par l&apos;IA
        </p>
        <Badge variant="outline" className="ml-auto border-emerald-500/30 text-[10px] text-emerald-600 dark:text-emerald-400">
          confiance {Math.round(suggestion.confidence * 100)} %
        </Badge>
      </div>

      <div className="mt-3 rounded-lg bg-card/80 p-4">
        <p className="flex items-center gap-2 font-medium">
          <CalendarCheck className="size-4 shrink-0 text-emerald-500" aria-hidden />
          {suggestion.title}
        </p>
        <p className="mt-2 text-sm capitalize text-muted-foreground">
          {format(parseISO(suggestion.startTime), "EEEE d MMMM yyyy", { locale: fr })} ·{" "}
          {format(parseISO(suggestion.startTime), "HH:mm")} –{" "}
          {format(parseISO(suggestion.endTime), "HH:mm")} ({durationLabel(suggestion.startTime, suggestion.endTime)})
        </p>
        {suggestion.description && (
          <p className="mt-2 text-sm text-foreground/80">{suggestion.description}</p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={onCreate} disabled={creating}>
          {creating ? (
            <Loader2 className="size-4 animate-spin" aria-hidden />
          ) : (
            <CalendarPlus className="size-4" aria-hidden />
          )}
          Créer l&apos;événement
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss} disabled={creating}>
          <X className="size-4" aria-hidden />
          Ignorer
        </Button>
      </div>
    </div>
  )
}
