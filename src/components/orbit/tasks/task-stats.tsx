"use client";

// Orbit — TaskStats : bandeau compact de statistiques des tâches.
// ─────────────────────────────────────────────────────────────────────────────
// Données : useTaskStats() → GET /api/tasks/stats. Une Card unique :
//  • 4 mini-stats en grid : Total, Complétées cette semaine, En retard
//    (rouge si > 0), Taux de complétion (cercle SVG maison stroke-dasharray) ;
//  • graphique en barres des 7 derniers jours (divs flex à hauteur
//    proportionnelle, aujourd'hui en dernier + surligné, tooltip title).
// Aucune dépendance de charting — tout est CSS/SVG inline.

import { CheckCircle2, ClipboardList, TrendingUp, TriangleAlert } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { useTaskStats } from "@/lib/api-client"
import type { TaskStatsDto } from "@/lib/types"

/** Cercle de progression SVG (taux 0..1) — arc cyan de marque. */
function ProgressRing({ value, label }: { value: number; label: string }) {
  const radius = 17
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(1, value))
  return (
    <svg
      viewBox="0 0 44 44"
      className="size-11 shrink-0"
      role="img"
      aria-label={`${label} : ${Math.round(clamped * 100)} %`}
    >
      {/* Piste de fond */}
      <circle
        cx="22"
        cy="22"
        r={radius}
        fill="none"
        strokeWidth="4"
        className="stroke-muted"
      />
      {/* Arc de progression (rotation -90° pour démarrer en haut) */}
      <circle
        cx="22"
        cy="22"
        r={radius}
        fill="none"
        strokeWidth="4"
        strokeLinecap="round"
        className="stroke-primary transition-[stroke-dashoffset] duration-500"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped)}
        transform="rotate(-90 22 22)"
      />
      <text
        x="22"
        y="22"
        textAnchor="middle"
        dominantBaseline="central"
        className="fill-foreground text-[10px] font-semibold tabular-nums"
      >
        {Math.round(clamped * 100)}%
      </text>
    </svg>
  )
}

/** Une mini-stat (icône + valeur + libellé). */
function StatItem({
  icon: Icon,
  value,
  label,
  hint,
  iconClassName,
  children,
}: {
  icon: React.ElementType
  value?: string | number
  label: string
  hint?: string
  iconClassName?: string
  /** Rendu custom (ex. : ProgressRing) à la place de la valeur. */
  children?: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      {children ?? (
        <span
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground",
            iconClassName
          )}
        >
          <Icon className="size-4" aria-hidden="true" />
        </span>
      )}
      <div className="min-w-0">
        {children ? (
          <p className="text-[11px] leading-tight text-muted-foreground">{label}</p>
        ) : (
          <>
            <p className="text-lg font-semibold leading-tight tabular-nums">{value}</p>
            <p className="truncate text-[11px] leading-tight text-muted-foreground">{label}</p>
          </>
        )}
        {hint ? (
          <p className="truncate text-[10px] leading-tight text-muted-foreground/80">{hint}</p>
        ) : null}
      </div>
    </div>
  )
}

/** Graphique barres des 7 derniers jours (aujourd'hui en dernier). */
function WeekChart({ week }: { week: TaskStatsDto["week"] }) {
  const max = Math.max(...week.map((d) => d.completed), 1)
  return (
    <div className="flex items-end justify-between gap-1.5 sm:gap-2" role="img" aria-label="Tâches complétées ces 7 derniers jours">
      {week.map((day, index) => {
        const isToday = index === week.length - 1 // aujourd'hui en dernier (contrat)
        const height = day.completed === 0 ? 4 : Math.max(8, Math.round((day.completed / max) * 40))
        return (
          <div
            key={day.date}
            className="flex min-w-0 flex-1 flex-col items-center gap-1"
            title={`${day.label} : ${day.completed} tâche${day.completed > 1 ? "s" : ""} complétée${day.completed > 1 ? "s" : ""}`}
          >
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {day.completed > 0 ? day.completed : ""}
            </span>
            <div
              className={cn(
                "w-full max-w-8 rounded-md transition-all",
                isToday ? "bg-primary" : day.completed > 0 ? "bg-primary/45" : "bg-muted"
              )}
              style={{ height: `${height}px` }}
            />
            <span
              className={cn(
                "text-[10px] font-medium",
                isToday ? "text-primary" : "text-muted-foreground"
              )}
            >
              {day.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Bandeau compact : toujours visible au-dessus du Kanban/de la liste. */
function TaskStats({ className }: { className?: string }) {
  const { data, isLoading } = useTaskStats()

  if (isLoading || !data) {
    return (
      <Card className={cn("border-border/60 bg-card/70 py-0", className)}>
        <CardContent className="flex items-center gap-6 p-4">
          <Skeleton className="h-9 w-20" />
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-20" />
          <Skeleton className="size-11 rounded-full" />
          <Skeleton className="hidden h-11 flex-1 sm:block" />
        </CardContent>
      </Card>
    )
  }

  const stats = data.stats
  const ratePercent = Math.round(stats.completionRate * 100)

  return (
    <Card className={cn("border-border/60 bg-card/70 py-0", className)}>
      <CardContent className="grid grid-cols-2 items-center gap-x-4 gap-y-3 p-4 sm:grid-cols-4 lg:grid-cols-[repeat(3,minmax(0,auto))_auto_minmax(6rem,1fr)]">
        <StatItem
          icon={ClipboardList}
          value={stats.total}
          label="Tâches au total"
          hint={`dont ${stats.byStatus.archived} archivée${stats.byStatus.archived > 1 ? "s" : ""}`}
        />
        <StatItem
          icon={CheckCircle2}
          value={stats.completedThisWeek}
          label="Complétées cette semaine"
          iconClassName="bg-emerald-500/15 text-emerald-500"
        />
        <StatItem
          icon={stats.overdue > 0 ? TriangleAlert : TrendingUp}
          value={stats.overdue}
          label="En retard"
          iconClassName={
            stats.overdue > 0 ? "bg-red-500/15 text-red-500" : "bg-muted/60 text-muted-foreground"
          }
        />
        <div
          className="flex min-w-0 items-center gap-2.5"
          title={`Tâches actives terminées : ${ratePercent} %`}
        >
          <ProgressRing value={stats.completionRate} label="Taux de complétion" />
          <div className="min-w-0">
            <p className="text-[11px] leading-tight text-muted-foreground">Taux de complétion</p>
            <p className="text-[10px] leading-tight text-muted-foreground/80">
              tâches actives terminées
            </p>
          </div>
        </div>
        {/* Graphe 7 jours — replié sous les stats sur petits écrans */}
        <div className="col-span-2 border-t border-border/50 pt-3 sm:col-span-4 lg:col-span-1 lg:border-l lg:border-t-0 lg:pl-4 lg:pt-0">
          <WeekChart week={stats.week} />
        </div>
      </CardContent>
    </Card>
  )
}

export { TaskStats }
