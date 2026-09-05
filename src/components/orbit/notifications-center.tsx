"use client"

// Orbit — Centre de notifications (v2 : live + historique persisté)
// ───────────────────────────────────────────────────────────────────────────
// Deux sources complémentaires :
//   1. « À traiter maintenant » — calculé en direct (événements imminents,
//      tâches en retard, emails à analyser) : l'attention immédiate.
//   2. « Historique » — notifications persistées (rappels envoyés, emails
//      importants IA…) : marque-lu au clic, tout-marquer-lu, deep link
//      vers la vue concernée (data.view), dates relatives.
// Le badge du header cumule non-lues persistées + items live.

import { useEffect, useMemo, useState } from "react"
import { addHours, formatDistanceToNow, isBefore, parseISO } from "date-fns"
import { fr } from "date-fns/locale"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import {
  useEventsRange,
  useTasks,
  useEmails,
  useNotifications,
  useNotificationMutations,
} from "@/lib/api-client"
import { useTimezone } from "@/hooks/useTimezone"
import type { NotificationDto, OrbitView } from "@/lib/types"
import {
  Bell,
  CalendarClock,
  AlarmClock,
  MailWarning,
  CircleAlert,
  Sparkles,
  CheckCheck,
  ListTodo,
  Mail,
  Bot,
  PartyPopper,
  CircleCheck,
} from "lucide-react"

type LiveItem = {
  id: string
  icon: React.ElementType
  className: string
  title: string
  description: string
  view: OrbitView
}

/** Icône/couleur par type de notification persistée. */
const TYPE_META: Record<string, { icon: React.ElementType; className: string; label: string }> = {
  EVENT_REMINDER: { icon: CalendarClock, className: "bg-primary/15 text-primary", label: "Événement" },
  TASK_DEADLINE: { icon: ListTodo, className: "bg-orange-500/15 text-orange-500", label: "Tâche" },
  IMPORTANT_EMAIL: { icon: Mail, className: "bg-emerald-500/15 text-emerald-500", label: "Email" },
  AI_SUGGESTION: { icon: Bot, className: "bg-violet-500/15 text-violet-500", label: "IA" },
  SYSTEM: { icon: PartyPopper, className: "bg-muted text-muted-foreground", label: "Système" },
  CUSTOM: { icon: Bell, className: "bg-muted text-muted-foreground", label: "Alerte" },
}

export function NotificationCenter({
  onNavigate,
}: {
  onNavigate: (view: OrbitView) => void
}) {
  // ── Items « live » (attention immédiate) ────────────────────────────────
  // Plage [maintenant, +24 h] re-cléée chaque minute : occurrences expansées
  // incluses, sans boucle de refetch (la clé ne change qu'au tick de 60 s).
  const [nowTick, setNowTick] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNowTick(new Date()), 60_000)
    return () => window.clearInterval(id)
  }, [])
  const until = useMemo(() => addHours(nowTick, 24), [nowTick])

  const { data: eventsData } = useEventsRange(nowTick, until)
  const { data: tasksData } = useTasks()
  const { data: emailsData } = useEmails()
  const { fmt } = useTimezone()

  // ── Historique persisté ──────────────────────────────────────────────────
  const { data: notifData, isLoading: notifLoading } = useNotifications(50)
  const { markRead } = useNotificationMutations()
  const notifications = notifData?.notifications ?? []
  const unreadCount = notifData?.unreadCount ?? 0

  const now = new Date()
  const items: LiveItem[] = []

  // Événements dans les 24 prochaines heures (occurrences incluses — la clé
  // d'item embarque l'instant de début pour rester unique par occurrence).
  for (const ev of eventsData?.events ?? []) {
    const start = parseISO(ev.startTime)
    if (start >= now && start <= addHours(now, 24)) {
      const isSoon = start <= addHours(now, 2)
      items.push({
        id: `event-${ev.id}-${ev.startTime}`,
        icon: isSoon ? AlarmClock : CalendarClock,
        className: isSoon
          ? "bg-red-500/15 text-red-500"
          : "bg-primary/15 text-primary",
        title: ev.title,
        description: `${isSoon ? "Imminent" : "À venir"} · ${fmt(start, "EEEE d MMMM 'à' HH:mm")}`,
        view: "calendar",
      })
    }
  }

  // Tâches en retard / à échéance aujourd'hui
  for (const task of tasksData?.tasks ?? []) {
    if (task.status === "done" || !task.dueDate) continue
    const due = parseISO(task.dueDate)
    if (isBefore(due, now)) {
      items.push({
        id: `task-late-${task.id}`,
        icon: CircleAlert,
        className: "bg-red-500/15 text-red-500",
        title: task.title,
        description: `En retard · échéance ${fmt(due, "EEE d MMM 'à' HH:mm")}`,
        view: "tasks",
      })
    } else if (due <= addHours(now, 24)) {
      items.push({
        id: `task-soon-${task.id}`,
        icon: CalendarClock,
        className: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
        title: task.title,
        description: `À traiter aujourd'hui · ${fmt(due, "HH:mm")}`,
        view: "tasks",
      })
    }
  }

  // Emails non traités (analyse IA suggérée)
  const unprocessed = (emailsData?.emails ?? []).filter((e) => !e.isProcessed).slice(0, 3)
  for (const email of unprocessed) {
    items.push({
      id: `email-${email.id}`,
      icon: MailWarning,
      className: "bg-violet-500/15 text-violet-500",
      title: email.subject,
      description: `Analyse IA suggérée · de ${email.fromName ?? email.fromAddress}`,
      view: "emails",
    })
  }

  const totalBadge = unreadCount + items.length
  const empty = items.length === 0 && notifications.length === 0

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative size-10"
          aria-label={`Notifications (${unreadCount} non lues, ${items.length} à traiter)`}
        >
          <Bell className="size-5" aria-hidden />
          {totalBadge > 0 && (
            <span
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white"
              aria-hidden
            >
              {totalBadge > 9 ? "9+" : totalBadge}
            </span>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            Notifications
            {unreadCount > 0 && (
              <Badge variant="secondary" className="font-normal">{unreadCount}</Badge>
            )}
            <span className="ml-auto">
              {unreadCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 gap-1.5 px-2 text-xs text-muted-foreground"
                  onClick={() => markRead.mutate({ all: true })}
                  disabled={markRead.isPending}
                  title="Tout marquer comme lu"
                >
                  <CheckCheck className="size-4" aria-hidden />
                  Tout lu
                </Button>
              )}
            </span>
          </SheetTitle>
          <SheetDescription>
            Ce qui demande votre attention maintenant, et l&apos;historique de vos rappels.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1 orbit-scroll">
          <div className="space-y-4 px-4 pb-6">
            {empty && !notifLoading ? (
              <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
                <Sparkles className="size-8" aria-hidden />
                <p className="text-sm">Tout est calme dans votre orbite ✨</p>
              </div>
            ) : null}

            {/* ── À traiter maintenant (live) ── */}
            {items.length > 0 && (
              <section aria-label="À traiter maintenant" className="space-y-2">
                <p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  À traiter
                </p>
                {items.map((item) => (
                  <button
                    key={item.id}
                    className="flex w-full items-start gap-3 rounded-xl border border-border/60 bg-card/70 p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"
                    // La fermeture du Sheet est gérée par le clic hors zone ;
                    // on navigue simplement :
                    onClick={() => onNavigate(item.view)}
                  >
                    <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${item.className}`}>
                      <item.icon className="size-4" aria-hidden />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-medium">{item.title}</span>
                      <span className="block text-xs text-muted-foreground">{item.description}</span>
                    </span>
                  </button>
                ))}
              </section>
            )}

            {/* ── Historique (persisté) ── */}
            <section aria-label="Historique des notifications" className="space-y-2">
              <p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Historique
              </p>
              {notifLoading ? (
                <div className="space-y-2">
                  {[0, 1, 2].map((i) => (
                    <Skeleton key={i} className="h-16 w-full rounded-xl" />
                  ))}
                </div>
              ) : notifications.length === 0 ? (
                <p className="px-1 py-4 text-center text-xs text-muted-foreground">
                  Aucune notification pour l&apos;instant — les rappels arrivent ici.
                </p>
              ) : (
                notifications.map((n) => (
                  <HistoryItem
                    key={n.id}
                    notification={n}
                    onOpen={() => {
                      if (!n.isRead) markRead.mutate({ notificationId: n.id })
                      if (n.data?.view) onNavigate(n.data.view)
                    }}
                  />
                ))
              )}
            </section>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}

/** Une ligne d'historique : icône par type, non-lue en surbrillance, action. */
function HistoryItem({
  notification: n,
  onOpen,
}: {
  notification: NotificationDto
  onOpen: () => void
}) {
  const meta = TYPE_META[n.type] ?? TYPE_META.SYSTEM
  const Icon = meta.icon
  const timeAgo = formatDistanceToNow(parseISO(n.createdAt), {
    addSuffix: true,
    locale: fr,
  })

  return (
    <button
      className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors hover:border-primary/40 ${
        n.isRead
          ? "border-border/40 bg-transparent"
          : "border-primary/30 bg-primary/5"
      }`}
      onClick={onOpen}
      aria-label={`${meta.label} — ${n.title} (${n.isRead ? "lue" : "non lue"})`}
    >
      <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${meta.className}`}>
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{n.title}</span>
          {!n.isRead && (
            <CircleCheck className="ml-auto size-3.5 shrink-0 text-primary" aria-hidden />
          )}
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{n.body}</span>
        <span className="mt-1 block text-[10px] uppercase tracking-wide text-muted-foreground/70">
          {meta.label} · {timeAgo}
        </span>
      </span>
    </button>
  )
}
