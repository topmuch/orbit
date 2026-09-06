"use client";

// Orbit — Tableau de bord : vue d'ensemble de la journée

import { useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { format, isBefore, isToday, parseISO } from "date-fns"
import { fr } from "date-fns/locale"
import { toast } from "sonner"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { EventCard, eventKeyOf } from "@/components/orbit/event-card"
import { EventDialog } from "@/components/orbit/event-dialog"
import { TaskModal } from "@/components/orbit/tasks/task-modal"
import { KpiCard } from "@/components/orbit/kpi-card"
import { PRIORITY_COLORS } from "@/components/orbit/tasks/priority-badge"
// 20-c : section « Analytique » (stats + graphiques Recharts)
import { StatsCards } from "@/components/orbit/analytics/StatsCards"
import { DashboardCharts } from "@/components/orbit/analytics/DashboardCharts"
import { useTimezone } from "@/hooks/useTimezone"
import { useI18n } from "@/lib/i18n/provider"
import type { AnalyticsDto } from "@/lib/analytics/types"
import {
  useStats,
  useTaskMutations,
  useEmailMutations,
  api,
} from "@/lib/api-client"
import type { SessionUser, TaskDto, EventDto, OrbitView } from "@/lib/types"
import {
  CalendarDays,
  ListTodo,
  Mail,
  CheckCircle2,
  Plus,
  Sparkles,
  RefreshCw,
  ArrowUpRight,
  Flag,
  Check,
  Sun,
  Moon,
  Clock,
} from "lucide-react"

function greeting(): string {
  const h = new Date().getHours()
  if (h < 6) return "Bonne nuit"
  if (h < 12) return "Bonjour"
  if (h < 18) return "Bel après-midi"
  return "Bonsoir"
}

// Jours de semaine pour le graphe « semaine à venir » (0 = lundi).
const WEEKDAY_SHORT = ["lun", "mar", "mer", "jeu", "ven", "sam", "dim"] as const
const WEEKDAY_LONG = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"] as const

export function DashboardView({
  user,
  onNavigate,
}: {
  user: SessionUser
  onNavigate?: (view: OrbitView, emailId?: string) => void
}) {
  const { data, isLoading } = useStats()
  const { update: updateTask } = useTaskMutations()
  const { sync } = useEmailMutations()
  // 12-c : heures formatées dans le fuseau d'affichage (RÈGLE D'OR UTC).
  const { fmt, dayKey } = useTimezone()
  // 20-c : analytique (agrégats + séries 14 j) — requête dédiée, rafraîchie
  // au maximum toutes les 60 s (staleTime), mutations non concernées.
  const { t } = useI18n()
  const { data: analyticsData, isLoading: analyticsLoading } = useQuery({
    queryKey: ["analytics"],
    queryFn: () => api<{ analytics: AnalyticsDto }>("/api/analytics"),
    staleTime: 60_000,
  })

  const [eventDialogOpen, setEventDialogOpen] = useState(false)
  const [editEvent, setEditEvent] = useState<EventDto | null>(null)
  const [taskDialogOpen, setTaskDialogOpen] = useState(false)

  const stats = data?.stats
  const now = new Date()
  // « aujourd'hui » (clé yyyy-MM-dd) dans le fuseau d'affichage — cohérent
  // avec les clés weekLoad du serveur (fuseau du profil, synchronisé via
  // setTimezone → PATCH /api/profile).
  const todayKey = dayKey(now)

  const firstName = (user.name ?? user.email).split(/[\s@]/)[0]
  const dateLabel = format(now, "EEEE d MMMM", { locale: fr })
  const isNight = now.getHours() < 6 || now.getHours() >= 21

  async function completeTask(task: TaskDto) {
    try {
      await updateTask.mutateAsync({ id: task.id, input: { status: "done" } })
      toast.success("Tâche terminée 🎉", { description: task.title })
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function handleSync() {
    try {
      const res = await sync.mutateAsync()
      toast.success(`${res.count} nouvel(s) email(s) récupéré(s)`, {
        description: "Connecteur IMAP simulé — branchez votre boîte en Phase 3.",
      })
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  return (
    <div className="space-y-6">
      {/* ---------- En-tête ---------- */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight sm:text-3xl">
            {isNight ? <Moon className="size-6 text-primary" aria-hidden /> : <Sun className="size-6 text-primary" aria-hidden />}
            {greeting()}, {firstName}
          </h1>
          <p className="mt-1 text-sm capitalize text-muted-foreground">
            {dateLabel}
            {stats?.nextEvent && (
              <>
                {" · "}
                <span className="normal-case">
                  Prochain : {stats.nextEvent.title} à{" "}
                  {fmt(parseISO(stats.nextEvent.startTime), "HH:mm")}
                </span>
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setEventDialogOpen(true)}>
            <Plus className="size-4" aria-hidden />
            Événement
          </Button>
          <Button size="sm" variant="outline" onClick={() => setTaskDialogOpen(true)}>
            <Plus className="size-4" aria-hidden />
            Tâche
          </Button>
          <Button size="sm" variant="outline" onClick={handleSync} disabled={sync.isPending}>
            <RefreshCw className={sync.isPending ? "size-4 animate-spin" : "size-4"} aria-hidden />
            <span className="hidden sm:inline">Synchroniser</span>
          </Button>
        </div>
      </header>

      {/* ---------- Statistiques ---------- */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 sm:gap-4">
        {isLoading || !stats ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-28 rounded-xl" />)
        ) : (
          <>
            <KpiCard
              tone="rose"
              icon={CalendarDays}
              value={stats.eventsToday}
              label="Événements aujourd&apos;hui"
              sub={
                stats.eventsToday > 0
                  ? `de ${fmt(parseISO(stats.todayEvents[0].startTime), "HH:mm")} à ${fmt(parseISO(stats.todayEvents[stats.todayEvents.length - 1].endTime), "HH:mm")}`
                  : "Journée libre"
              }
            />

            <KpiCard
              tone="orange"
              icon={ListTodo}
              value={stats.tasksTodo + stats.tasksDoing}
              label="Tâches actives"
              sub={
                <>
                  {stats.tasksDoing} en cours
                  {stats.tasksOverdue > 0 && (
                    <span className="font-semibold text-white">
                      {" · "}{stats.tasksOverdue} en retard
                    </span>
                  )}
                </>
              }
            />

            <KpiCard
              tone="bleu"
              icon={Mail}
              value={stats.unreadEmails}
              label="Emails non lus"
              sub={
                stats.unprocessedEmails > 0
                  ? `${stats.unprocessedEmails} à analyser`
                  : "Boîte à jour"
              }
            />

            <KpiCard
              tone="jaune"
              icon={CheckCircle2}
              value={stats.tasksDone}
              label="Tâches terminées"
              sub="Gardez le rythme ✨"
            />
          </>
        )}
      </div>

      {/* ---------- Charge de la semaine ---------- */}
      <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base font-medium">
            <Clock className="size-4 text-primary" aria-hidden />
            Semaine à venir
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading || !stats ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <div className="grid grid-cols-7 items-end gap-1 sm:gap-2">
              {stats.weekLoad.map((d) => {
                // d.date = clé "yyyy-MM-dd" calculée côté serveur DANS le fuseau
                // du profil : on décompose la CHAÎNE (parts[2] = jour, lookup du
                // jour de semaine par index) au lieu de new Date(key) — le parseur
                // de "yyyy-MM-dd" le traite comme minuit UTC, qui devient
                // 22:00/20:00 la veille en Europe/Paris / New-York et
                // décalerait le nom du jour affiché d'un cran.
                const [y, m, dayNum] = d.date.split("-").map(Number)
                const weekdayIdx = (new Date(Date.UTC(y, m - 1, dayNum)).getUTCDay() + 6) % 7
                const today = d.date === todayKey
                const maxCount = Math.max(...stats.weekLoad.map((x) => x.count), 1)
                const h = d.count === 0 ? 4 : Math.max(10, (d.count / maxCount) * 56)
                return (
                  <div key={d.date} className="flex flex-col items-center gap-1.5">
                    <span className="text-[10px] tabular-nums text-muted-foreground">
                      {d.count > 0 ? d.count : ""}
                    </span>
                    <div
                      className={`w-full max-w-10 rounded-md transition-all ${today ? "bg-primary" : d.count > 0 ? "bg-primary/50" : "bg-muted"}`}
                      style={{ height: `${h}px` }}
                      role="img"
                      aria-label={`${WEEKDAY_LONG[weekdayIdx]} : ${d.count} événement(s)`}
                    />
                    <span className={`text-[11px] font-medium ${today ? "text-primary" : "text-muted-foreground"}`}>
                      {WEEKDAY_SHORT[weekdayIdx]}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------- Analytique (20-c) ---------- */}
      <section aria-labelledby="analytics-heading" className="space-y-4">
        <div>
          <h2 id="analytics-heading" className="text-lg font-semibold tracking-tight">
            {t("analytics.sectionTitle")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("analytics.sectionDesc")}</p>
        </div>
        <StatsCards stats={analyticsData?.analytics} isLoading={analyticsLoading} />
        <DashboardCharts stats={analyticsData?.analytics} isLoading={analyticsLoading} />
      </section>

      {/* ---------- Agenda du jour + tâches ---------- */}
      {/* QA Task 8 : grid-cols-1 explicite (minmax(0,1fr)) — sans lui, la piste
          auto implicite sous lg prenait la min-content des descriptions truncate
          (white-space:nowrap) → overflow horizontal ~1300px en viewport 375px. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
          <CardHeader className="flex-row items-center justify-between pb-3">
            <CardTitle className="text-base font-medium">Aujourd&apos;hui</CardTitle>
            <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs text-muted-foreground" onClick={() => onNavigate?.("calendar")}>
              Calendrier
              <ArrowUpRight className="size-3.5" aria-hidden />
            </Button>
          </CardHeader>
          <CardContent className="space-y-1">
            {isLoading || !stats ? (
              Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12" />)
            ) : stats.todayEvents.length === 0 ? (
              <button
                onClick={() => setEventDialogOpen(true)}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border py-8 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                <Plus className="size-4" aria-hidden />
                Aucun événement — en ajouter un ?
              </button>
            ) : (
              stats.todayEvents.map((ev) => {
                // Carte partagée EventCard (12-c) : pastille couleur = couleur
                // d'événement ou par source, heures dans le fuseau d'affichage.
                const past = isBefore(parseISO(ev.endTime), now)
                return (
                  <EventCard
                    key={eventKeyOf(ev)}
                    event={ev}
                    compact
                    muted={past}
                    onClick={() => {
                      setEditEvent(ev)
                      setEventDialogOpen(true)
                    }}
                  />
                )
              })
            )}
          </CardContent>
        </Card>

        <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
          <CardHeader className="flex-row items-center justify-between pb-3">
            <CardTitle className="text-base font-medium">Priorités</CardTitle>
            <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs text-muted-foreground" onClick={() => onNavigate?.("tasks")}>
              Kanban
              <ArrowUpRight className="size-3.5" aria-hidden />
            </Button>
          </CardHeader>
          <CardContent className="space-y-1">
            {isLoading || !stats ? (
              Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12" />)
            ) : stats.priorityTasks.length === 0 ? (
              <button
                onClick={() => setTaskDialogOpen(true)}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border py-8 text-sm text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                <Plus className="size-4" aria-hidden />
                Aucune tâche active — en créer une ?
              </button>
            ) : (
              stats.priorityTasks.map((task) => {
                const overdue = task.dueDate && isBefore(parseISO(task.dueDate), now)
                return (
                  <div
                    key={task.id}
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-accent/50"
                  >
                    <button
                      onClick={() => completeTask(task)}
                      className="flex size-6 shrink-0 items-center justify-center rounded-full border border-input text-muted-foreground transition-colors hover:border-emerald-500 hover:text-emerald-500"
                      aria-label={`Marquer « ${task.title} » comme terminée`}
                    >
                      <Check className="size-3.5" aria-hidden />
                    </button>
                    <button
                      className="min-w-0 flex-1 text-left"
                      onClick={() => onNavigate?.("tasks")}
                    >
                      <span className="flex items-center gap-1.5">
                        <Flag
                          className="size-3.5 shrink-0"
                          style={{ color: PRIORITY_COLORS[task.priority] }}
                          aria-hidden
                        />
                        <span className="truncate text-sm font-medium">{task.title}</span>
                        {task.status === "doing" && (
                          <Badge variant="secondary" className="px-1.5 text-[10px] font-normal">en cours</Badge>
                        )}
                      </span>
                      {task.dueDate && (
                        <span className={`block truncate text-xs ${overdue ? "font-medium text-red-500" : "text-muted-foreground"}`}>
                          {overdue ? "En retard · " : "Échéance "}
                          {format(parseISO(task.dueDate), "EEE d MMM · HH:mm", { locale: fr })}
                        </span>
                      )}
                    </button>
                  </div>
                )
              })
            )}
          </CardContent>
        </Card>
      </div>

      {/* ---------- Derniers emails ---------- */}
      <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
        <CardHeader className="flex-row items-center justify-between pb-3">
          <CardTitle className="flex items-center gap-2 text-base font-medium">
            <Mail className="size-4 text-violet-500" aria-hidden />
            Derniers emails
          </CardTitle>
          <Button variant="ghost" size="sm" className="h-8 gap-1 text-xs text-muted-foreground" onClick={() => onNavigate?.("emails")}>
            Boîte de réception
            <ArrowUpRight className="size-3.5" aria-hidden />
          </Button>
        </CardHeader>
        <CardContent className="space-y-1">
          {isLoading || !stats ? (
            Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12" />)
          ) : stats.recentEmails.length === 0 ? (
            <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border py-8 text-sm text-muted-foreground">
              <Mail className="size-4" aria-hidden />
              Aucun email — synchronisez votre boîte
            </div>
          ) : (
            stats.recentEmails.map((email) => (
              <button
                key={email.id}
                onClick={() => onNavigate?.("emails", email.id)}
                className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent/50"
              >
                <span className={`size-2 shrink-0 rounded-full ${email.isRead ? "bg-transparent" : "bg-violet-500"}`} aria-hidden />
                <span className="w-28 shrink-0 truncate text-xs text-muted-foreground sm:w-40">
                  {email.fromName ?? email.fromAddress}
                </span>
                <span className={`min-w-0 flex-1 truncate text-sm ${email.isRead ? "font-normal" : "font-semibold"}`}>
                  {email.subject}
                </span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {format(parseISO(email.receivedAt), isToday(parseISO(email.receivedAt)) ? "HH:mm" : "d MMM", { locale: fr })}
                </span>
                {!email.isProcessed && (
                  <Badge variant="outline" className="hidden gap-1 border-violet-500/30 text-[10px] text-violet-500 sm:inline-flex">
                    <Sparkles className="size-2.5" aria-hidden />
                    IA
                  </Badge>
                )}
              </button>
            ))
          )}
        </CardContent>
      </Card>

      {/* ---------- Dialogs ---------- */}
      <EventDialog
        open={eventDialogOpen}
        onOpenChange={(o) => {
          setEventDialogOpen(o)
          if (!o) setEditEvent(null)
        }}
        event={editEvent}
        defaultDate={new Date()}
      />
      <TaskModal open={taskDialogOpen} onOpenChange={setTaskDialogOpen} />
    </div>
  )
}
