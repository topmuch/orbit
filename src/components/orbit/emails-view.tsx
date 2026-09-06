"use client";

// Orbit — Boîte de réception complète (style Gmail/Outlook)
// ─────────────────────────────────────────────────────────────────────────────
// Trois panneaux : dossiers + comptes (sidebar) · liste (recherche, sélection
// multiple, actions groupées) · lecture (HTML sandbox, pièces jointes, IA).
// Sélection d'email contrôlée par le parent (navigation dashboard → email).
//
// Raccourcis clavier (lecture ouverte, hors champ de saisie) :
//   R répondre · A archiver · S étoiler · # corbeille · Échap retour.
// Recherche : debounce 300 ms ; rafraîchissement auto 60 s (useEmails).

import { useEffect, useMemo, useRef, useState } from "react"
import { differenceInMinutes, format, parseISO } from "date-fns"
import { fr } from "date-fns/locale"
import { toast } from "sonner"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Input } from "@/components/ui/input"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { useEmails, useEmailDetail, useEmailMutations } from "@/lib/api-client"
import { EventDialog } from "@/components/orbit/event-dialog"
import { useTimezone } from "@/hooks/useTimezone"
import type { EmailDto, OrbitView } from "@/lib/types"
import { ComposeDialog, type ComposeDraft } from "@/components/orbit/emails/compose-dialog"
import { EmailBodyFrame } from "@/components/orbit/emails/email-body-frame"
import { AiSummaryDialog } from "@/components/orbit/ai/ai-summary-dialog"
import {
  Inbox,
  RefreshCw,
  Sparkles,
  Trash2,
  MailOpen,
  MailPlus,
  Search,
  CalendarCheck,
  CalendarPlus,
  X,
  Loader2,
  Check,
  ArrowLeft,
  ScanSearch,
  FileText,
  MapPin,
  Users,
  Server,
  Star,
  Paperclip,
  Archive,
  Undo2,
  Send,
  Reply,
  Forward,
  PenSquare,
  Download,
  Settings2,
  ChevronRight,
} from "lucide-react"

// ─── Types locaux ────────────────────────────────────────────────────────────

type FolderTab = "INBOX" | "STARRED" | "SENT" | "ARCHIVE" | "TRASH"

const FOLDER_TABS: Array<{
  key: FolderTab
  label: string
  icon: typeof Inbox
  countKey: "inbox" | "starred" | "sent" | "archive" | "trash"
  unreadKey?: "inboxUnread"
}> = [
  { key: "INBOX", label: "Boîte de réception", icon: Inbox, countKey: "inbox", unreadKey: "inboxUnread" },
  { key: "STARRED", label: "Étoilés", icon: Star, countKey: "starred" },
  { key: "SENT", label: "Envoyés", icon: Send, countKey: "sent" },
  { key: "ARCHIVE", label: "Archivés", icon: Archive, countKey: "archive" },
  { key: "TRASH", label: "Corbeille", icon: Trash2, countKey: "trash" },
]

function durationLabel(startISO: string, endISO: string): string {
  const mins = differenceInMinutes(parseISO(endISO), parseISO(startISO))
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `${h} h` : `${h} h ${m}`
}

function sizeLabel(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} Ko`
  return `${bytes} o`
}

/** Citation de réponse/transfert (corps d'origine tronqué). */
function quoteBody(email: EmailDto, fmt: (d: Date, p: string) => string): string {
  const from = email.fromName ?? email.fromAddress
  const date = fmt(parseISO(email.receivedAt), "EEEE d MMMM yyyy 'à' HH:mm")
  const lines = email.bodyText.split("\n").slice(0, 40).map((l) => (l.trim() ? `> ${l}` : ">"))
  return `Le ${date}, ${from} a écrit :\n${lines.join("\n")}`.slice(0, 2500)
}

// ─── Vue principale ──────────────────────────────────────────────────────────

export function EmailsView({
  selectedId,
  onSelect,
  onNavigate,
}: {
  selectedId: string | null
  onSelect: (id: string | null) => void
  onNavigate?: (view: OrbitView) => void
}) {
  const { timezone, fmt } = useTimezone()

  // ── Filtres d'état ──
  const [folder, setFolder] = useState<FolderTab>("INBOX")
  const [searchInput, setSearchInput] = useState("")
  const [q, setQ] = useState("") // debounce 300 ms
  const [accountFilter, setAccountFilter] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<"recent" | "oldest">("recent")

  // ── Sélection multiple + dialogs ──
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false)
  const [summaryEmail, setSummaryEmail] = useState<EmailDto | null>(null)
  const [suggestDraft, setSuggestDraft] = useState<EmailDto | null>(null)
  const [composeDraft, setComposeDraft] = useState<ComposeDraft | null>(null)
  const [composeOpen, setComposeOpen] = useState(false)
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const filters = useMemo(
    () => ({
      folder,
      q: q || undefined,
      accountId: accountFilter ?? undefined,
      page,
      limit: 25,
      sort,
    }),
    [folder, q, accountFilter, page, sort]
  )
  const { data, isLoading, isFetching } = useEmails(filters)
  const { patch, remove, sync, analyze, bulk } = useEmailMutations()
  const { data: detailData, isLoading: detailLoading } = useEmailDetail(selectedId)

  const emails = data?.emails ?? []
  const counts = data?.counts
  const accounts = data?.accounts ?? []
  const selected = detailData?.email ?? null

  // Debounce recherche (300 ms) — requête serveur seulement une fois stabilisé.
  // Reset page/sélection en asynchrone dans le timer (pas d'effet synchrone).
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      setQ(searchInput.trim())
      setPage(1)
      setSelection(new Set())
    }, 300)
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current)
    }
  }, [searchInput])

  /** Changement de dossier (sidebar + onglets mobiles) : reset liste + sélection. */
  function changeFolder(key: FolderTab) {
    setFolder(key)
    setPage(1)
    setSelection(new Set())
    onSelect(null)
  }

  /** Bascule le filtre de compte (null = tous les comptes). */
  function changeAccountFilter(id: string | null) {
    setAccountFilter(id)
    setPage(1)
    setSelection(new Set())
  }

  // ── Actions ──

  function handleSelect(email: EmailDto) {
    onSelect(email.id)
    if (!email.isRead) patch.mutate({ id: email.id, isRead: true })
  }

  function toggleSelection(id: string) {
    setSelection((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleSelectPage() {
    if (selection.size > 0 && selection.size >= emails.filter((e) => !e.isRead || true).length) {
      setSelection(new Set())
    } else {
      setSelection(new Set(emails.map((e) => e.id)))
    }
  }

  async function runBulk(action: "read" | "unread" | "star" | "unstar" | "archive" | "trash" | "restore") {
    const ids = [...selection]
    if (!ids.length) return
    try {
      const res = await bulk.mutateAsync({ ids, action })
      toast.success(`${res.updated} email(s) mis à jour`)
      setSelection(new Set())
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function runBulkDelete() {
    const ids = [...selection]
    if (!ids.length) return
    try {
      const res = await bulk.mutateAsync({ ids, action: "delete" })
      toast.success(`${res.updated} email(s) supprimé(s) définitivement`)
      setSelection(new Set())
      setConfirmBulkDelete(false)
      if (selectedId && ids.includes(selectedId)) onSelect(null)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function moveFolder(ids: string[], action: "archive" | "trash" | "restore") {
    try {
      const res = await bulk.mutateAsync({ ids, action })
      const labels = { archive: "archivé(s)", trash: "mis à la corbeille", restore: "restauré(s)" }
      toast.success(`${res.updated} email(s) ${labels[action]}`)
      if (selectedId && ids.includes(selectedId) && action !== "restore") onSelect(null)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  /** Ouvre la composition (nouveau / réponse / transfert) avec pré-remplissage. */
  function openCompose(mode: ComposeDraft["mode"], email?: EmailDto) {
    if (!email || mode === "new") {
      setComposeDraft({ mode: "new", accountId: accountFilter ?? undefined })
      setComposeOpen(true)
      return
    }
    const account = accounts.find((a) => a.address === email.accountAddress)
    const accountId = account?.canSend ? account.id : undefined
    const isReply = mode === "reply" || mode === "replyAll"
    if (mode === "reply" || mode === "replyAll") {
      const to =
        mode === "reply"
          ? [email.fromAddress]
          : [
              email.fromAddress,
              ...(email.toAddresses ?? []).filter(
                (addr) => addr.toLowerCase() !== (email.accountAddress ?? "").toLowerCase()
              ),
            ]
      setComposeDraft({
        mode,
        accountId,
        to,
        subject: email.subject.toLowerCase().startsWith("re:") ? email.subject : `Re: ${email.subject}`,
        quotedBody: quoteBody(email, fmt),
        replyToEmailId: email.id,
      })
    } else {
      setComposeDraft({
        mode: "forward",
        accountId,
        subject: email.subject.toLowerCase().startsWith("fwd:") ? email.subject : `Fwd: ${email.subject}`,
        quotedBody: quoteBody(email, fmt),
      })
    }
    setComposeOpen(true)
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
        toast.success("Événement détecté 🎯", { description: "Vérifiez la suggestion puis confirmez." })
      }
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

  function suggestionDescription(email: EmailDto): string {
    const s = email.suggestedEvent
    if (!s) return ""
    return `${s.description}\n\n(Source : email de ${email.fromName ?? email.fromAddress} — « ${email.subject} »)`.trim()
  }

  async function handleSync() {
    try {
      const res = await sync.mutateAsync()
      if (res.demo) {
        toast.info("Mode démonstration", {
          description: `${res.count} email(s) d'exemple ajoutés — connectez un compte IMAP dans les Réglages pour recevoir vos vrais messages.`,
        })
      } else {
        const failures = (res.accounts ?? []).filter((a) => !a.ok)
        toast[failures.length ? "warning" : "success"](`${res.count} nouveau(x) email(s) synchronisé(s)`, {
          description: failures.length
            ? `Échec : ${failures.map((f) => f.address).join(", ")} — vérifiez le compte dans les Réglages.`
            : undefined,
        })
      }
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  // ── Raccourcis clavier (déclarés APRÈS les actions qu'ils appellent) ──
  // R répondre · A archiver · S étoiler · # corbeille · Échap retour — inactifs
  // pendant une saisie (input/textarea/select) ou un dialog ouvert.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!selectedId || composeOpen || confirmBulkDelete || summaryEmail || suggestDraft) return
      const target = e.target as HTMLElement | null
      if (
        target &&
        (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)
      )
        return
      const key = e.key.toLowerCase()
      if (key === "escape") {
        e.preventDefault()
        onSelect(null)
      } else if (key === "r") {
        e.preventDefault()
        if (selected) openCompose("reply", selected)
      } else if (key === "a" && selected && selected.folder !== "TRASH") {
        e.preventDefault()
        void moveFolder([selected.id], "archive")
      } else if (key === "s" && selected) {
        e.preventDefault()
        patch.mutate({ id: selected.id, isStarred: !selected.isStarred })
      } else if (key === "#" && selected && selected.folder !== "TRASH") {
        e.preventDefault()
        void moveFolder([selected.id], "trash")
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [selectedId, selected, composeOpen, confirmBulkDelete, summaryEmail, suggestDraft, onSelect, patch])

  // ─── Sidebar (lg+) ────────────────────────────────────────────────────────

  const sidebarNode = (
    <nav className="hidden min-h-0 flex-col gap-1 overflow-y-auto border-r border-border/60 p-2 lg:flex orbit-scroll" aria-label="Dossiers et comptes email">
      {FOLDER_TABS.map(({ key, label, icon: Icon, countKey, unreadKey }) => {
        const count = counts?.[countKey] ?? 0
        const unread = unreadKey ? counts?.[unreadKey] ?? 0 : 0
        const active = folder === key
        return (
          <button
            key={key}
            onClick={() => changeFolder(key)}
            aria-current={active ? "true" : undefined}
            className={`flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors ${
              active ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            }`}
          >
            <Icon className={`size-4 shrink-0 ${active ? "text-primary" : ""}`} aria-hidden />
            <span className="min-w-0 flex-1 truncate">{label}</span>
            {unread > 0 ? (
              <Badge className="ml-auto h-5 min-w-5 shrink-0 rounded-full px-1.5 text-[10px] tabular-nums" variant="default">
                {unread > 99 ? "99+" : unread}
              </Badge>
            ) : count > 0 ? (
              <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{count}</span>
            ) : null}
          </button>
        )
      })}

      {accounts.length > 0 && (
        <div className="mt-3">
          <p className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
            Comptes
          </p>
          <button
            onClick={() => changeAccountFilter(null)}
            aria-current={accountFilter === null ? "true" : undefined}
            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
              accountFilter === null ? "text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Server className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate">Tous les comptes</span>
          </button>
          {accounts.map((a) => {
            const active = accountFilter === a.id
            return (
              <button
                key={a.id}
                onClick={() => changeAccountFilter(active ? null : a.id)}
                aria-current={active ? "true" : undefined}
                title={`${a.address}${a.canSend ? " · envoi SMTP configuré" : ""}`}
                className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
                  active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                }`}
              >
                <span
                  className={`size-2 shrink-0 rounded-full ${a.canSend ? "bg-emerald-500" : "bg-violet-500/70"}`}
                  aria-hidden
                  title={a.canSend ? "Envoi SMTP configuré" : "Lecture seule"}
                />
                <span className="min-w-0 flex-1 truncate">{a.label ?? a.address}</span>
                {a.unread > 0 && (
                  <span className="shrink-0 rounded-full bg-primary/15 px-1.5 text-[10px] font-medium tabular-nums text-primary">
                    {a.unread > 99 ? "99+" : a.unread}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {onNavigate && (
        <Button
          variant="ghost"
          size="sm"
          className="mt-3 justify-start gap-2 text-xs text-muted-foreground"
          onClick={() => onNavigate("settings")}
        >
          <Settings2 className="size-3.5" aria-hidden />
          Gérer les comptes
        </Button>
      )}
    </nav>
  )

  // ─── Barre d'onglets mobile ────────────────────────────────────────────────

  const folderChipsNode = (
    <div
      className="flex gap-1.5 overflow-x-auto border-b border-border/60 px-2 py-2 lg:hidden orbit-scroll"
      role="tablist"
      aria-label="Dossiers email"
    >
      {FOLDER_TABS.map(({ key, label, icon: Icon, countKey, unreadKey }) => {
        const count = counts?.[countKey] ?? 0
        const unread = unreadKey ? counts?.[unreadKey] ?? 0 : 0
        const active = folder === key
        return (
          <button
            key={key}
            role="tab"
            aria-selected={active}
            onClick={() => changeFolder(key)}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors ${
              active
                ? "border-primary/40 bg-primary/10 font-medium text-primary"
                : "border-border/60 text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="size-3.5" aria-hidden />
            {label.split(" ")[0]}
            {unread > 0 && <span className="tabular-nums">({unread > 99 ? "99+" : unread})</span>}
            {!unread && count > 0 && <span className="tabular-nums opacity-60">{count}</span>}
          </button>
        )
      })}
    </div>
  )

  // ─── Liste ────────────────────────────────────────────────────────────────

  const total = data?.total ?? 0
  const showAccountChip = !accountFilter && accounts.length > 1

  const listNode = (
    <div className="flex h-full min-h-0 flex-col">
      {/* Recherche + actions */}
      <div className="flex items-center gap-2 p-2.5">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Rechercher (objet, expéditeur, contenu)…"
            className="h-9 pl-9"
            aria-label="Rechercher dans les emails"
          />
        </div>
        <Button
          size="icon"
          variant="outline"
          className="size-9 shrink-0"
          onClick={handleSync}
          disabled={sync.isPending}
          aria-label="Synchroniser la boîte de réception"
          title="Synchroniser (IMAP)"
        >
          <RefreshCw className={sync.isPending ? "size-4 animate-spin" : "size-4"} aria-hidden />
        </Button>
        <Button
          size="icon"
          className="size-9 shrink-0"
          onClick={() => openCompose("new")}
          aria-label="Écrire un email"
          title="Écrire (envoi SMTP)"
        >
          <PenSquare className="size-4" aria-hidden />
        </Button>
      </div>

      {/* Barre d'actions groupées */}
      {selection.size > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-y border-border/60 bg-muted/40 px-2.5 py-1.5">
          <span className="mr-1 text-xs font-medium tabular-nums">{selection.size} sélectionné(s)</span>
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => runBulk("read")}>
            <MailOpen className="size-3.5" aria-hidden /> Lus
          </Button>
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => runBulk("unread")}>
            <Inbox className="size-3.5" aria-hidden /> Non lus
          </Button>
          <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => runBulk("star")}>
            <Star className="size-3.5" aria-hidden /> Étoiler
          </Button>
          {folder === "TRASH" ? (
            <>
              <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => runBulk("restore")}>
                <Undo2 className="size-3.5" aria-hidden /> Restaurer
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1.5 px-2 text-xs text-destructive hover:text-destructive"
                onClick={() => setConfirmBulkDelete(true)}
              >
                <Trash2 className="size-3.5" aria-hidden /> Supprimer
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => runBulk("archive")}>
                <Archive className="size-3.5" aria-hidden /> Archiver
              </Button>
              <Button variant="ghost" size="sm" className="h-7 gap-1.5 px-2 text-xs" onClick={() => runBulk("trash")}>
                <Trash2 className="size-3.5" aria-hidden /> Corbeille
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-7 text-xs"
            onClick={() => setSelection(new Set())}
            aria-label="Annuler la sélection"
          >
            <X className="size-3.5" aria-hidden />
          </Button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 border-y border-border/60 px-2.5 py-1.5 text-[11px] text-muted-foreground">
          <label className="flex cursor-pointer items-center gap-1.5 font-normal">
            <Checkbox
              checked={false}
              onCheckedChange={toggleSelectPage}
              aria-label="Tout sélectionner"
              className="size-3.5"
            />
            Sélectionner la page
          </label>
          <div className="flex items-center gap-2">
            {accountFilter && (
              <Badge variant="outline" className="gap-1 border-violet-500/30 px-1.5 text-[10px] text-violet-500">
                <Server className="size-2.5" aria-hidden />
                {accounts.find((a) => a.id === accountFilter)?.address ?? "compte"}
                <button onClick={() => changeAccountFilter(null)} aria-label="Retirer le filtre de compte">
                  <X className="size-2.5" aria-hidden />
                </button>
              </Badge>
            )}
            <Select value={sort} onValueChange={(v) => {
              setSort(v === "oldest" ? "oldest" : "recent")
              setPage(1)
              setSelection(new Set())
            }}>
              <SelectTrigger size="sm" className="h-6 w-auto gap-1 border-0 px-1.5 text-[11px] shadow-none" aria-label="Tri">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="recent">Récents d&apos;abord</SelectItem>
                <SelectItem value="oldest">Anciens d&apos;abord</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {/* Liste des emails — viewport en display:block (le layout table de
          Radix laisse les lignes nowrap s'étendre au min-content → débordement
          sur le panneau voisin) */}
      <ScrollArea className="min-h-0 flex-1 orbit-scroll [&>div>div]:!block">
        <div className="space-y-0.5 px-1.5 pb-3">
          {isLoading ? (
            Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="mx-1 h-[52px] rounded-lg" />)
          ) : emails.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-14 text-center text-muted-foreground">
              <Inbox className="size-8" aria-hidden />
              <p className="text-sm">
                {q
                  ? "Aucun résultat pour cette recherche"
                  : folder === "INBOX" && accounts.length === 0
                    ? "Boîte vide — connectez un compte IMAP"
                    : folder === "TRASH"
                      ? "Corbeille vide"
                      : folder === "SENT"
                        ? "Aucun email envoyé — écrivez votre premier message"
                        : folder === "STARRED"
                          ? "Aucun email étoilé"
                          : folder === "ARCHIVE"
                            ? "Aucun email archivé"
                            : "Aucun email"}
              </p>
              {folder === "INBOX" && accounts.length === 0 && !q && onNavigate && (
                <Button variant="outline" size="sm" className="mt-1 gap-1.5" onClick={() => onNavigate("settings")}>
                  <MailPlus className="size-4" aria-hidden />
                  Connecter un compte IMAP
                </Button>
              )}
              {folder === "SENT" && !q && (
                <Button variant="outline" size="sm" className="mt-1 gap-1.5" onClick={() => openCompose("new")}>
                  <PenSquare className="size-4" aria-hidden />
                  Écrire un email
                </Button>
              )}
            </div>
          ) : (
            emails.map((email) => {
              const isSelected = email.id === selectedId
              const isSel = selection.has(email.id)
              return (
                <div
                  key={email.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => handleSelect(email)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleSelect(email)
                  }}
                  className={`group flex cursor-pointer items-start gap-2 rounded-lg p-2.5 text-left transition-colors ${
                    isSelected
                      ? "bg-accent ring-1 ring-primary/30"
                      : isSel
                        ? "bg-primary/10"
                        : "hover:bg-accent/50"
                  } ${!email.isRead ? "" : ""}`}
                  aria-current={isSelected ? "true" : undefined}
                >
                  <Checkbox
                    checked={isSel}
                    onCheckedChange={() => toggleSelection(email.id)}
                    onClick={(e) => e.stopPropagation()}
                    className="mt-1 size-4 shrink-0"
                    aria-label={`Sélectionner « ${email.subject} »`}
                  />
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      patch.mutate({ id: email.id, isStarred: !email.isStarred })
                    }}
                    className="mt-0.5 shrink-0 rounded p-0.5 transition-colors hover:bg-accent"
                    aria-label={email.isStarred ? "Retirer l'étoile" : "Étoiler cet email"}
                    aria-pressed={email.isStarred}
                  >
                    <Star
                      className={`size-4 ${
                        email.isStarred
                          ? "fill-amber-400 text-amber-400"
                          : "text-muted-foreground/50 group-hover:text-muted-foreground"
                      }`}
                      aria-hidden
                    />
                  </button>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className={`min-w-0 flex-1 truncate text-sm ${email.isRead ? "font-normal" : "font-semibold"}`}>
                        {folder === "SENT" || folder === "ARCHIVE"
                          ? `À : ${(email.toAddresses ?? []).join(", ") || "—"}`
                          : email.fromName ?? email.fromAddress}
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {format(parseISO(email.receivedAt), "d MMM · HH:mm", { locale: fr })}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <p className={`min-w-0 flex-1 truncate text-[13px] ${email.isRead ? "" : "font-medium"}`}>
                        {email.subject}
                      </p>
                      {email.hasAttachments && (
                        <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-label="Pièce(s) jointe(s)" />
                      )}
                      {!email.isRead && (
                        <span className="size-1.5 shrink-0 rounded-full bg-violet-500" aria-label="Non lu" />
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {email.snippet ?? email.bodyText.replace(/\s+/g, " ").slice(0, 120)}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      {!email.isProcessed && folder !== "TRASH" && folder !== "SENT" && (
                        <Badge
                          variant="outline"
                          className="gap-1 border-violet-500/30 px-1.5 text-[10px] text-violet-500"
                        >
                          <Sparkles className="size-2.5" aria-hidden />
                          À analyser
                        </Badge>
                      )}
                      {showAccountChip && email.accountAddress && (
                        <Badge
                          variant="outline"
                          className="max-w-[160px] gap-1 border-amber-500/30 px-1.5 text-[10px] text-amber-600 dark:text-amber-400"
                          title={`Synchronisé depuis ${email.accountAddress}`}
                        >
                          <Server className="size-2.5 shrink-0" aria-hidden />
                          <span className="truncate">{email.accountAddress}</span>
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              )
            })
          )}

          {/* Charger plus */}
          {!isLoading && emails.length > 0 && emails.length < total && (
            <div className="flex items-center justify-center gap-2 py-3">
              <Button
                variant="outline"
                size="sm"
                disabled={isFetching}
                onClick={() => setPage((p) => p + 1)}
              >
                {isFetching ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <ChevronRight className="size-4" aria-hidden />}
                Charger plus ({emails.length}/{total})
              </Button>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  )

  // ─── Détail ───────────────────────────────────────────────────────────────

  const detailNode = selected ? (
    <div className="flex h-full min-h-0 flex-col">
      {/* Barre d'actions du message */}
      <div className="flex items-center gap-1 border-b border-border/60 p-2">
        <Button variant="ghost" size="sm" className="gap-1 lg:hidden" onClick={() => onSelect(null)}>
          <ArrowLeft className="size-4" aria-hidden />
          Boîte
        </Button>
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => openCompose("reply", selected)}
            aria-label="Répondre (R)"
            title="Répondre (R)"
          >
            <Reply className="size-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => openCompose("replyAll", selected)}
            aria-label="Répondre à tous"
            title="Répondre à tous"
            disabled={(selected.toAddresses?.length ?? 0) === 0}
          >
            <Send className="size-4 -scale-x-100" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => openCompose("forward", selected)}
            aria-label="Transférer"
            title="Transférer"
          >
            <Forward className="size-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => patch.mutate({ id: selected.id, isStarred: !selected.isStarred })}
            aria-label={selected.isStarred ? "Retirer l'étoile (S)" : "Étoiler (S)"}
            title="Étoiler (S)"
          >
            <Star
              className={`size-4 ${selected.isStarred ? "fill-amber-400 text-amber-400" : ""}`}
              aria-hidden
            />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => patch.mutate({ id: selected.id, isRead: !selected.isRead })}
            aria-label={selected.isRead ? "Marquer comme non lu" : "Marquer comme lu"}
            title={selected.isRead ? "Marquer non lu" : "Marquer lu"}
          >
            <MailOpen className="size-4" aria-hidden />
          </Button>
          {selected.folder === "TRASH" ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => moveFolder([selected.id], "restore")}
                aria-label="Restaurer dans la boîte"
                title="Restaurer"
              >
                <Undo2 className="size-4" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-destructive hover:text-destructive"
                onClick={async () => {
                  try {
                    await remove.mutateAsync(selected.id)
                    onSelect(null)
                    toast.success("Email supprimé définitivement")
                  } catch (err) {
                    toast.error((err as Error).message)
                  }
                }}
                aria-label="Supprimer définitivement"
                title="Supprimer définitivement"
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => moveFolder([selected.id], "archive")}
                aria-label="Archiver (A)"
                title="Archiver (A)"
              >
                <Archive className="size-4" aria-hidden />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-8"
                onClick={() => moveFolder([selected.id], "trash")}
                aria-label="Mettre à la corbeille (#)"
                title="Corbeille (#)"
              >
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </>
          )}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1 orbit-scroll [&>div>div]:!block">
        <div className="space-y-4 p-4 sm:p-5">
          {detailLoading && !selected.bodyText ? (
            <div className="space-y-3">
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-64 w-full" />
            </div>
          ) : (
            <>
              {/* En-tête */}
              <div>
                <h2 className="text-lg font-semibold leading-snug sm:text-xl">{selected.subject}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {selected.fromName ?? selected.fromAddress}
                  </span>
                  <span>&lt;{selected.fromAddress}&gt;</span>
                  <span>·</span>
                  <span>{fmt(parseISO(selected.receivedAt), "EEEE d MMMM yyyy 'à' HH:mm")}</span>
                  {selected.accountAddress && (
                    <Badge
                      variant="outline"
                      className="gap-1 border-amber-500/30 px-1.5 text-[10px] text-amber-600 dark:text-amber-400"
                      title={`Synchronisé depuis ${selected.accountAddress} (IMAP)`}
                    >
                      <Server className="size-2.5" aria-hidden />
                      {selected.accountLabel ? `${selected.accountLabel} · ` : ""}
                      {selected.accountAddress}
                    </Badge>
                  )}
                  {selected.threadId && (
                    <Badge variant="outline" className="px-1.5 text-[10px] text-muted-foreground" title="Fil de discussion">
                      Fil de discussion
                    </Badge>
                  )}
                </div>
                {(selected.toAddresses?.length ?? 0) > 0 && (
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    À : {selected.toAddresses!.join(", ")}
                  </p>
                )}
              </div>

              {/* Corps : HTML sandbox ou texte brut */}
              {selected.bodyHtml ? (
                <EmailBodyFrame html={selected.bodyHtml} />
              ) : (
                <div className="whitespace-pre-wrap text-[15px] leading-relaxed text-foreground/90">
                  {selected.bodyText}
                </div>
              )}

              {/* Pièces jointes (les images inline sont dans le corps) */}
              {(selected.attachments ?? []).filter((a) => !a.isInline).length > 0 && (
                <div>
                  <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                    <Paperclip className="size-4 text-muted-foreground" aria-hidden />
                    Pièces jointes ({selected.attachments!.filter((a) => !a.isInline).length})
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {selected.attachments!
                      .filter((a) => !a.isInline)
                      .map((att) => (
                        <a
                          key={att.id}
                          href={`/api/emails/attachments/${att.id}`}
                          download={att.filename}
                          className="flex items-center gap-2.5 rounded-lg border border-border/60 bg-card/60 p-2.5 transition-colors hover:bg-accent/50"
                          title={`Télécharger ${att.filename}`}
                        >
                          <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
                            <Download className="size-4 text-muted-foreground" aria-hidden />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-sm">{att.filename}</span>
                            <span className="block text-[11px] text-muted-foreground">
                              {sizeLabel(att.size)} · {att.contentType}
                            </span>
                          </span>
                        </a>
                      ))}
                  </div>
                </div>
              )}

              {/* Synthèse IA (contenus longs) */}
              {selected.bodyText.trim().length >= 200 && (
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-xs text-violet-600 hover:bg-violet-500/10 hover:text-violet-700 dark:text-violet-400 dark:hover:text-violet-300"
                    onClick={() => setSummaryEmail(selected)}
                  >
                    <FileText className="size-3.5" aria-hidden />
                    Résumer avec l&apos;IA
                  </Button>
                </div>
              )}

              {/* Zone IA (détection de rendez-vous) */}
              {selected.isProcessed && !selected.suggestedEvent ? (
                <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/40 p-4 text-sm text-muted-foreground">
                  <Check className="size-4 shrink-0 text-emerald-500" aria-hidden />
                  Email traité — analyse terminée.
                </div>
              ) : selected.suggestedEvent ? (
                <SuggestionCard
                  suggestion={selected.suggestedEvent}
                  onCreate={() => setSuggestDraft(selected)}
                  onDismiss={() => handleDismiss(selected)}
                  fmt={fmt}
                />
              ) : (
                selected.folder !== "TRASH" &&
                selected.folder !== "SENT" && (
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
                )
              )}

              {/* Réponse rapide */}
              <div className="flex justify-end gap-2 border-t border-border/60 pt-3">
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => openCompose("reply", selected)}>
                  <Reply className="size-4" aria-hidden />
                  Répondre
                </Button>
                <Button variant="outline" size="sm" className="gap-1.5" onClick={() => openCompose("forward", selected)}>
                  <Forward className="size-4" aria-hidden />
                  Transférer
                </Button>
              </div>

              <p className="text-right text-[10px] text-muted-foreground/60">
                Raccourcis : R répondre · A archiver · S étoiler · # corbeille · Échap retour
              </p>
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  ) : (
    <div className="hidden h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground lg:flex">
      <Inbox className="size-10" aria-hidden />
      <p className="font-medium text-foreground">Sélectionnez un email</p>
      <p className="max-w-xs text-sm">
        Choisissez un message pour le lire, répondez en un clic et laissez l&apos;IA y repérer vos prochains rendez-vous.
      </p>
      <Button size="sm" className="mt-1 gap-1.5" onClick={() => openCompose("new")}>
        <PenSquare className="size-4" aria-hidden />
        Écrire un email
      </Button>
    </div>
  )

  // ─── Assemblage ───────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Boîte de réception</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {counts
              ? `${counts.all} messages · ${counts.inboxUnread} non lus · ${counts.starred} étoilés · ${counts.sent} envoyés`
              : "Chargement…"}
          </p>
        </div>
      </header>

      <Card className="overflow-hidden border-border/60 bg-card/70 backdrop-blur-sm">
        <div className="grid h-[calc(100vh-15rem)] min-h-[480px] lg:grid-cols-[216px_minmax(300px,370px)_1fr]">
          {sidebarNode}
          {/* Mobile : liste OU détail (pattern existant) */}
          <div className={`min-h-0 flex-col ${selected ? "hidden lg:flex" : "flex"} border-border/60 lg:border-l`}>
            {folderChipsNode}
            <div className="min-h-0 flex-1">{listNode}</div>
          </div>
          <div
            className={`min-h-0 flex-col border-t border-border/60 lg:border-l lg:border-t-0 ${
              selected ? "flex" : "hidden lg:flex"
            }`}
          >
            {detailNode}
          </div>
        </div>
      </Card>

      {/* Suppression définitive groupée */}
      <AlertDialog open={confirmBulkDelete} onOpenChange={setConfirmBulkDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer définitivement {selection.size} email(s) ?</AlertDialogTitle>
            <AlertDialogDescription>
              Cette action est irréversible — les messages et leurs pièces jointes seront effacés de votre boîte
              Orbit (sans impact sur le serveur IMAP).
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={runBulkDelete} className="bg-destructive text-white hover:bg-destructive/90">
              Supprimer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Composition / réponse / transfert */}
      <ComposeDialog
        open={composeOpen}
        onOpenChange={(open) => {
          setComposeOpen(open)
          if (!open) setComposeDraft(null)
        }}
        draft={composeDraft}
        accounts={accounts.map((a) => ({ id: a.id, address: a.address, label: a.label, canSend: a.canSend }))}
        onNavigate={onNavigate}
        onSent={() => setFolder((f) => (f === "INBOX" ? f : f))}
      />

      {/* Création d'événement depuis une suggestion IA (dialog pré-rempli) */}
      <EventDialog
        open={suggestDraft !== null}
        onOpenChange={(open) => {
          if (!open) setSuggestDraft(null)
        }}
        defaultDate={
          suggestDraft?.suggestedEvent ? new Date(suggestDraft.suggestedEvent.startTime) : undefined
        }
        defaultEnd={
          suggestDraft?.suggestedEvent ? new Date(suggestDraft.suggestedEvent.endTime) : undefined
        }
        defaultTitle={suggestDraft?.suggestedEvent?.title}
        defaultDescription={suggestDraft ? suggestionDescription(suggestDraft) : undefined}
        defaultLocation={suggestDraft?.suggestedEvent?.location ?? undefined}
        defaultAttendees={suggestDraft?.suggestedEvent?.attendees}
        defaultTimezone={timezone}
        source="email_extract"
      />

      {/* Synthèse IA de l'email sélectionné (objet + corps) */}
      <AiSummaryDialog
        open={summaryEmail !== null}
        onOpenChange={(open) => {
          if (!open) setSummaryEmail(null)
        }}
        content={summaryEmail ? [summaryEmail.subject, summaryEmail.bodyText].filter(Boolean).join("\n\n") : ""}
        contextLabel="cet email"
      />
    </div>
  )
}

// ─── Carte suggestion IA (préservée de la version précédente) ───────────────

function SuggestionCard({
  suggestion,
  onCreate,
  onDismiss,
  fmt,
}: {
  suggestion: NonNullable<EmailDto["suggestedEvent"]>
  onCreate: () => void
  onDismiss: () => void
  fmt: (d: Date, p: string) => string
}) {
  const start = parseISO(suggestion.startTime)
  const end = parseISO(suggestion.endTime)
  return (
    <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
      <div className="flex items-center gap-2">
        <Sparkles className="size-4 text-emerald-500" aria-hidden />
        <p className="text-sm font-semibold text-emerald-600 dark:text-emerald-400">
          Rendez-vous détecté par l&apos;IA
        </p>
        <Badge
          variant="outline"
          className="ml-auto border-emerald-500/30 text-[10px] text-emerald-600 dark:text-emerald-400"
        >
          confiance {Math.round(suggestion.confidence * 100)} %
        </Badge>
      </div>

      <div className="mt-3 rounded-lg bg-card/80 p-4">
        <p className="flex items-center gap-2 font-medium">
          <CalendarCheck className="size-4 shrink-0 text-emerald-500" aria-hidden />
          {suggestion.title}
        </p>
        <p className="mt-2 text-sm capitalize text-muted-foreground">
          {fmt(start, "EEEE d MMMM yyyy")} · {fmt(start, "HH:mm")} – {fmt(end, "HH:mm")} (
          {durationLabel(suggestion.startTime, suggestion.endTime)})
        </p>
        {suggestion.location || (suggestion.attendees?.length ?? 0) > 0 ? (
          <div className="mt-2 space-y-1.5 text-sm">
            {suggestion.location ? (
              <p className="flex items-center gap-2 text-foreground/80">
                <MapPin className="size-3.5 shrink-0 text-emerald-500/80" aria-hidden />
                {suggestion.location}
              </p>
            ) : null}
            {suggestion.attendees?.length ? (
              <p className="flex items-center gap-2 text-foreground/80">
                <Users className="size-3.5 shrink-0 text-emerald-500/80" aria-hidden />
                <span className="min-w-0 truncate" title={suggestion.attendees.join(", ")}>
                  {suggestion.attendees.join(", ")}
                </span>
              </p>
            ) : null}
          </div>
        ) : null}
        {suggestion.description && (
          <p className="mt-2 text-sm text-foreground/80">{suggestion.description}</p>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={onCreate}>
          <CalendarPlus className="size-4" aria-hidden />
          Créer l&apos;événement
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss}>
          <X className="size-4" aria-hidden />
          Ignorer
        </Button>
      </div>
    </div>
  )
}
