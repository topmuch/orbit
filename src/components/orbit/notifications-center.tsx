"use client";

// Orbit — Centre de notifications (calculé en direct depuis les données)
// Événements imminents, tâches en retard/urgentes, emails en attente d'analyse.

import { addHours, format, isBefore, parseISO } from "date-fns"
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
import { useEvents, useTasks, useEmails } from "@/lib/api-client"
import type { OrbitView } from "@/lib/types"
import {
  Bell,
  CalendarClock,
  AlarmClock,
  MailWarning,
  CircleAlert,
  Sparkles,
} from "lucide-react"

type NotificationItem = {
  id: string
  icon: React.ElementType
  className: string
  title: string
  description: string
  view: OrbitView
}

export function NotificationCenter({
  onNavigate,
}: {
  onNavigate: (view: OrbitView) => void
}) {
  const { data: eventsData } = useEvents()
  const { data: tasksData } = useTasks()
  const { data: emailsData } = useEmails()

  const now = new Date()
  const items: NotificationItem[] = []

  // Événements dans les 24 prochaines heures
  for (const ev of eventsData?.events ?? []) {
    const start = parseISO(ev.startTime)
    if (start >= now && start <= addHours(now, 24)) {
      const isSoon = start <= addHours(now, 2)
      items.push({
        id: `event-${ev.id}`,
        icon: isSoon ? AlarmClock : CalendarClock,
        className: isSoon
          ? "bg-red-500/15 text-red-500"
          : "bg-primary/15 text-primary",
        title: ev.title,
        description: `${start <= addHours(now, 2) ? "Imminent" : "À venir"} · ${format(start, "EEEE d MMMM 'à' HH:mm", { locale: fr })}`,
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
        description: `En retard · échéance ${format(due, "EEE d MMM 'à' HH:mm", { locale: fr })}`,
        view: "tasks",
      })
    } else if (due <= addHours(now, 24)) {
      items.push({
        id: `task-soon-${task.id}`,
        icon: CalendarClock,
        className: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
        title: task.title,
        description: `À traiter aujourd'hui · ${format(due, "HH:mm", { locale: fr })}`,
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

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative size-10"
          aria-label={`Notifications (${items.length})`}
        >
          <Bell className="size-5" aria-hidden />
          {items.length > 0 && (
            <span
              className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white"
              aria-hidden
            >
              {items.length > 9 ? "9+" : items.length}
            </span>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent className="flex w-full flex-col sm:max-w-md">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            Notifications
            {items.length > 0 && (
              <Badge variant="secondary" className="font-normal">{items.length}</Badge>
            )}
          </SheetTitle>
          <SheetDescription>
            Ce qui demande votre attention maintenant.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1 orbit-scroll">
          <div className="space-y-2 px-4 pb-6">
            {items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-16 text-center text-muted-foreground">
                <Sparkles className="size-8" aria-hidden />
                <p className="text-sm">Tout est calme dans votre orbite ✨</p>
              </div>
            ) : (
              items.map((item) => (
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
              ))
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
