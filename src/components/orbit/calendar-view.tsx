"use client"

// Orbit — Vue Calendrier (Mois / Semaine / Jour)
// Tâche 8-a — composant autonome : données via useEvents(), mutations via EventDialog.

import { useCallback, useEffect, useMemo, useState } from "react"
import type { MouseEvent as ReactMouseEvent } from "react"
import {
  addDays,
  addMonths,
  addWeeks,
  differenceInCalendarWeeks,
  differenceInMinutes,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  getDay,
  isSameDay,
  isSameMonth,
  isToday,
  set,
  startOfMonth,
  startOfWeek,
} from "date-fns"
import { fr } from "date-fns/locale"
import { CalendarDays, ChevronLeft, ChevronRight, Mail, Plus, Sparkles } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { EventDialog } from "@/components/orbit/event-dialog"
import { useEvents } from "@/lib/api-client"
import type { EventDto, EventSource } from "@/lib/types"
import { cn } from "@/lib/utils"

// ---------- Constantes ----------

type ViewMode = "month" | "week" | "day"

/** Événements indexés par jour local (clé "yyyy-MM-dd") */
type EventMap = Map<string, EventDto[]>

type SourceStyle = {
  /** Cartes / puces : bordure gauche 3px + fond teinté */
  chip: string
  /** Pastille mobile */
  dot: string
  /** Badge de source (vue Jour) */
  badge: string
  label: string
}

const SOURCE_STYLES: Record<EventSource, SourceStyle> = {
  manual: {
    chip: "border-l-primary bg-primary/15 text-primary hover:bg-primary/25",
    dot: "bg-primary",
    badge: "border-primary bg-primary/15 text-primary",
    label: "Manuel",
  },
  email_extract: {
    chip: "border-l-emerald-500 bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/25 dark:text-emerald-400",
    dot: "bg-emerald-500",
    badge: "border-emerald-500 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
    label: "Email",
  },
  ai: {
    chip: "border-l-violet-500 bg-violet-500/15 text-violet-600 hover:bg-violet-500/25 dark:text-violet-400",
    dot: "bg-violet-500",
    badge: "border-violet-500 bg-violet-500/15 text-violet-600 dark:text-violet-400",
    label: "IA",
  },
  import: {
    chip: "border-l-teal-500 bg-teal-500/15 text-teal-600 hover:bg-teal-500/25 dark:text-teal-400",
    dot: "bg-teal-500",
    badge: "border-teal-500 bg-teal-500/15 text-teal-600 dark:text-teal-400",
    label: "Import",
  },
}

const WEEKDAY_LABELS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"] as const
const WEEK_OPTIONS = { weekStartsOn: 1 } as const

const HOUR_START = 7
const HOUR_END = 22
const HOUR_ROW_COUNT = HOUR_END - HOUR_START + 1 // 16 lignes : 07:00 → 22:59
const ROW_HEIGHT = 44 // px par ligne d'une heure
const GRID_MINUTES = HOUR_ROW_COUNT * 60

const MAX_MONTH_CHIPS = 3
const MAX_MOBILE_DOTS = 6
const MIN_EVENT_HEIGHT = 20 // px

// ---------- Petites aides ----------

function dayKey(d: Date): string {
  return format(d, "yyyy-MM-dd")
}

function eventStart(ev: EventDto): Date {
  return new Date(ev.startTime)
}

function eventEnd(ev: EventDto): Date {
  return new Date(ev.endTime)
}

function timeRange(ev: EventDto): string {
  return `${format(eventStart(ev), "HH:mm")} – ${format(eventEnd(ev), "HH:mm")}`
}

function hourLabel(hour: number): string {
  return format(new Date(2024, 0, 1, hour), "HH:mm")
}

function atHour(day: Date, hour: number): Date {
  return set(day, { hours: hour, minutes: 0, seconds: 0, milliseconds: 0 })
}

/** Le jour donné, à l'heure courante (création depuis une case du mois) */
function withCurrentTime(day: Date): Date {
  const now = new Date()
  return set(day, {
    hours: now.getHours(),
    minutes: now.getMinutes(),
    seconds: 0,
    milliseconds: 0,
  })
}

function isWeekendDay(day: Date): boolean {
  const dow = getDay(day)
  return dow === 0 || dow === 6
}

// ---------- Placement des événements (vue Semaine) ----------

type LaneEvent = {
  event: EventDto
  start: number // minutes depuis 07:00
  end: number
  lane: number
  laneCount: number
}

/**
 * Répartit les événements d'une journée sur des « couloirs » horizontaux
 * quand ils se chevauchent (grappes transitives).
 */
function assignLanes(items: { event: EventDto; start: number; end: number }[]): LaneEvent[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end)
  const laneEnds: number[] = []
  const placed: LaneEvent[] = sorted.map((item) => {
    let lane = laneEnds.findIndex((end) => end <= item.start)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(item.end)
    } else {
      laneEnds[lane] = item.end
    }
    return { ...item, lane, laneCount: 1 }
  })

  // Grappes : événements qui se chevauchent transitivement
  let i = 0
  while (i < placed.length) {
    let clusterEnd = placed[i].end
    let j = i
    while (j + 1 < placed.length && placed[j + 1].start < clusterEnd) {
      j += 1
      clusterEnd = Math.max(clusterEnd, placed[j].end)
    }
    let laneCount = 0
    for (let k = i; k <= j; k += 1) laneCount = Math.max(laneCount, placed[k].lane + 1)
    for (let k = i; k <= j; k += 1) placed[k].laneCount = laneCount
    i = j + 1
  }
  return placed
}

// ---------- Vue Mois ----------

type MonthGridProps = {
  cursor: Date
  eventsByDay: EventMap
  onCreate: (date: Date) => void
  onEdit: (event: EventDto) => void
  onViewDay: (day: Date) => void
}

function MonthGrid({ cursor, eventsByDay, onCreate, onEdit, onViewDay }: MonthGridProps) {
  // 6 semaines complètes à partir du lundi précédant le 1er du mois
  const days = useMemo(() => {
    const monthStart = startOfMonth(cursor)
    const monthEnd = endOfMonth(cursor)
    const gridStart = startOfWeek(monthStart, WEEK_OPTIONS)
    const weeks = Math.max(
      differenceInCalendarWeeks(monthEnd, monthStart, WEEK_OPTIONS) + 1,
      6,
    )
    return eachDayOfInterval({ start: gridStart, end: addDays(gridStart, weeks * 7 - 1) })
  }, [cursor])

  return (
    <section aria-label="Vue mois" className="select-none">
      <div className="grid grid-cols-7 border-b border-border/50">
        {WEEKDAY_LABELS.map((label) => (
          <div
            key={label}
            className="py-2.5 text-center text-xs font-medium text-muted-foreground/80"
          >
            {label}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px bg-border/50">
        {days.map((day) => {
          const inMonth = isSameMonth(day, cursor)
          const today = isToday(day)
          const dayEvents = eventsByDay.get(dayKey(day)) ?? []
          const extra = dayEvents.length - MAX_MONTH_CHIPS
          return (
            <div
              key={dayKey(day)}
              className={cn(
                "flex min-h-[64px] cursor-pointer flex-col gap-1 bg-card p-1.5 transition-colors hover:bg-muted/30 sm:min-h-[96px] sm:p-2",
                inMonth && isWeekendDay(day) && "bg-muted/[0.07]",
              )}
              onClick={() => onCreate(withCurrentTime(day))}
            >
              <span
                className={cn(
                  "flex size-6 items-center justify-center rounded-full text-xs font-medium sm:size-7 sm:text-sm",
                  today
                    ? "bg-primary font-semibold text-primary-foreground"
                    : inMonth
                      ? "text-foreground/85"
                      : "text-muted-foreground/40",
                )}
              >
                {format(day, "d")}
              </span>

              {/* Puces (desktop) */}
              <div className="hidden flex-col gap-1 sm:flex">
                {dayEvents.slice(0, MAX_MONTH_CHIPS).map((ev) => (
                  <Tooltip key={ev.id}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onEdit(ev)
                        }}
                        className={cn(
                          "w-full cursor-pointer truncate rounded-md border-l-[3px] px-1.5 py-1 text-left text-xs font-medium transition-colors",
                          SOURCE_STYLES[ev.source].chip,
                        )}
                        aria-label={`${ev.title} — ${timeRange(ev)}`}
                      >
                        {ev.title}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-56">
                      <span className="font-medium">{ev.title}</span>
                      <span className="opacity-70"> · {timeRange(ev)}</span>
                    </TooltipContent>
                  </Tooltip>
                ))}
                {extra > 0 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onViewDay(day)
                    }}
                    className="w-fit cursor-pointer px-1 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    +{extra} autre{extra > 1 ? "s" : ""}
                  </button>
                )}
              </div>

              {/* Points colorés (mobile) */}
              <div className="flex flex-wrap items-center gap-1 sm:hidden">
                {dayEvents.slice(0, MAX_MOBILE_DOTS).map((ev) => (
                  <Tooltip key={ev.id}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          onEdit(ev)
                        }}
                        className="-m-0.5 flex size-4 cursor-pointer items-center justify-center rounded-full"
                        aria-label={`${ev.title} — ${timeRange(ev)}`}
                      >
                        <span
                          className={cn("size-2 rounded-full", SOURCE_STYLES[ev.source].dot)}
                        />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" className="max-w-56">
                      <span className="font-medium">{ev.title}</span>
                      <span className="opacity-70"> · {timeRange(ev)}</span>
                    </TooltipContent>
                  </Tooltip>
                ))}
                {dayEvents.length > MAX_MOBILE_DOTS && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onViewDay(day)
                    }}
                    className="cursor-pointer text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    +{dayEvents.length - MAX_MOBILE_DOTS}
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ---------- Vue Semaine ----------

type WeekColumnProps = {
  day: Date
  lanes: LaneEvent[]
  nowTop: number | null
  onSlotClick: (e: ReactMouseEvent<HTMLDivElement>, day: Date) => void
  onEdit: (event: EventDto) => void
}

function WeekColumn({ day, lanes, nowTop, onSlotClick, onEdit }: WeekColumnProps) {
  return (
    <div
      className="relative cursor-pointer border-l border-border/30"
      style={{ height: HOUR_ROW_COUNT * ROW_HEIGHT }}
      onClick={(e) => onSlotClick(e, day)}
      onDoubleClick={(e) => onSlotClick(e, day)}
    >
      {/* Trame horaire */}
      {Array.from({ length: HOUR_ROW_COUNT }, (_, i) => (
        <div
          key={i}
          className={cn("h-11", i > 0 && "border-t border-border/50")}
          aria-hidden="true"
        />
      ))}

      {/* Événements positionnés en absolu */}
      {lanes.map(({ event, start, end, lane, laneCount }) => {
        const top = (start / 60) * ROW_HEIGHT
        const height = Math.max(((end - start) / 60) * ROW_HEIGHT, MIN_EVENT_HEIGHT)
        const widthPct = 100 / laneCount
        return (
          <Tooltip key={event.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onEdit(event)
                }}
                className={cn(
                  "absolute z-10 cursor-pointer overflow-hidden rounded-md border-l-[3px] px-1.5 py-1 text-left transition-colors",
                  SOURCE_STYLES[event.source].chip,
                )}
                style={{
                  top,
                  height,
                  left: `calc(${lane * widthPct}% + 2px)`,
                  width: `calc(${widthPct}% - 4px)`,
                }}
                aria-label={`${event.title} — ${timeRange(event)}`}
              >
                <span className="block truncate text-[11px] font-semibold leading-tight">
                  {event.title}
                </span>
                {height >= 34 && (
                  <span className="block truncate text-[10px] font-normal leading-tight opacity-75">
                    {format(eventStart(event), "HH:mm")}
                  </span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-56">
              <span className="font-medium">{event.title}</span>
              <span className="opacity-70"> · {timeRange(event)}</span>
            </TooltipContent>
          </Tooltip>
        )
      })}

      {/* Ligne « maintenant » */}
      {nowTop !== null && (
        <div
          className="pointer-events-none absolute inset-x-0 z-20"
          style={{ top: nowTop }}
          aria-hidden="true"
        >
          <div className="h-px bg-primary/70" />
          <div className="absolute left-0 top-1/2 size-1.5 -translate-y-1/2 rounded-full bg-primary" />
        </div>
      )}
    </div>
  )
}

type WeekGridProps = {
  cursor: Date
  eventsByDay: EventMap
  onCreate: (date: Date) => void
  onEdit: (event: EventDto) => void
}

function WeekGrid({ cursor, eventsByDay, onCreate, onEdit }: WeekGridProps) {
  const days = useMemo(
    () =>
      eachDayOfInterval({
        start: startOfWeek(cursor, WEEK_OPTIONS),
        end: endOfWeek(cursor, WEEK_OPTIONS),
      }),
    [cursor],
  )
  const hours = useMemo(
    () => Array.from({ length: HOUR_ROW_COUNT }, (_, i) => HOUR_START + i),
    [],
  )

  // Horloge discrète pour la ligne « maintenant » (rafraîchie chaque minute)
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(id)
  }, [])
  const nowTop = useMemo(() => {
    if (!days.some((d) => isSameDay(d, now))) return null
    const minutes = differenceInMinutes(now, atHour(now, HOUR_START))
    return minutes >= 0 && minutes <= GRID_MINUTES ? (minutes / 60) * ROW_HEIGHT : null
  }, [days, now])

  // Positionnement des événements par colonne
  const lanesByDay = useMemo(() => {
    const map = new Map<string, LaneEvent[]>()
    for (const day of days) {
      const base = atHour(day, HOUR_START)
      const items: { event: EventDto; start: number; end: number }[] = []
      for (const ev of eventsByDay.get(dayKey(day)) ?? []) {
        const start = Math.max(differenceInMinutes(eventStart(ev), base), 0)
        const end = Math.min(
          Math.max(differenceInMinutes(eventEnd(ev), base), start + 1),
          GRID_MINUTES,
        )
        if (start < GRID_MINUTES) items.push({ event: ev, start, end })
      }
      map.set(dayKey(day), assignLanes(items))
    }
    return map
  }, [days, eventsByDay])

  /** Création sur un créneau : position convertie en minutes, arrondie à la demi-heure */
  function handleSlotClick(e: ReactMouseEvent<HTMLDivElement>, day: Date) {
    const rect = e.currentTarget.getBoundingClientRect()
    const raw = ((e.clientY - rect.top) / ROW_HEIGHT) * 60
    const minutes = Math.min(Math.max(Math.round(raw / 30) * 30, 0), GRID_MINUTES - 30)
    onCreate(
      set(day, {
        hours: HOUR_START + Math.floor(minutes / 60),
        minutes: minutes % 60,
        seconds: 0,
        milliseconds: 0,
      }),
    )
  }

  return (
    <section aria-label="Vue semaine" className="orbit-scroll overflow-x-auto">
      <div className="min-w-[900px] select-none">
        {/* En-têtes des jours */}
        <div className="grid grid-cols-[2.75rem_repeat(7,minmax(0,1fr))] border-b border-border/50">
          <div aria-hidden="true" />
          {days.map((day) => (
            <div key={dayKey(day)} className="py-2 text-center">
              <span
                className={cn(
                  "inline-flex items-baseline gap-1.5 rounded-full px-2.5 py-1 text-xs",
                  isToday(day)
                    ? "bg-primary/15 font-semibold text-primary"
                    : "text-muted-foreground",
                )}
              >
                <span>{WEEKDAY_LABELS[(getDay(day) + 6) % 7]}</span>
                <span>{format(day, "d")}</span>
              </span>
            </div>
          ))}
        </div>

        {/* Corps : gouttière des heures + 7 colonnes */}
        <div className="grid grid-cols-[2.75rem_repeat(7,minmax(0,1fr))]">
          <div aria-hidden="true">
            {hours.map((h, i) => (
              <div key={h} className="h-11 border-t border-border/50">
                {i % 2 === 0 && (
                  <span className="block -translate-y-1/2 pr-2 text-right text-[10px] leading-none text-muted-foreground">
                    {hourLabel(h)}
                  </span>
                )}
              </div>
            ))}
          </div>
          {days.map((day) => (
            <WeekColumn
              key={dayKey(day)}
              day={day}
              lanes={lanesByDay.get(dayKey(day)) ?? []}
              nowTop={nowTop !== null && isSameDay(day, now) ? nowTop : null}
              onSlotClick={handleSlotClick}
              onEdit={onEdit}
            />
          ))}
        </div>
      </div>
    </section>
  )
}

// ---------- Vue Jour ----------

type AgendaRowProps = {
  event: EventDto
  onEdit: (event: EventDto) => void
  onSlotCreate?: () => void
}

function AgendaRow({ event, onEdit, onSlotCreate }: AgendaRowProps) {
  const style = SOURCE_STYLES[event.source]
  return (
    <div
      className={cn(
        "flex items-stretch pr-2",
        onSlotCreate && "cursor-pointer transition-colors hover:bg-muted/20",
      )}
      onClick={onSlotCreate}
    >
      <span className="w-16 shrink-0 py-3 pl-3 text-sm font-bold tabular-nums">
        {format(eventStart(event), "HH:mm")}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onEdit(event)
        }}
        className={cn(
          "my-1 flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg border-l-[3px] py-2 pl-3 pr-2.5 text-left transition-colors",
          style.chip,
        )}
        aria-label={`${event.title} — ${timeRange(event)}`}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{event.title}</span>
          {event.description && (
            <span className="mt-0.5 block truncate text-xs opacity-70">
              {event.description}
            </span>
          )}
        </span>
        {event.source !== "manual" && (
          <Badge variant="outline" className={cn("shrink-0", style.badge)}>
            {event.source === "email_extract" ? (
              <Mail aria-hidden="true" />
            ) : (
              <Sparkles aria-hidden="true" />
            )}
            {style.label}
          </Badge>
        )}
      </button>
    </div>
  )
}

type DayAgendaProps = {
  day: Date
  events: EventDto[]
  onCreate: (date: Date) => void
  onEdit: (event: EventDto) => void
}

function DayAgenda({ day, events, onCreate, onEdit }: DayAgendaProps) {
  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
        <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
          <CalendarDays className="size-6 text-primary" aria-hidden="true" />
        </div>
        <p className="text-sm text-muted-foreground">Aucun événement ce jour-là</p>
        <Button variant="outline" className="h-11" onClick={() => onCreate(withCurrentTime(day))}>
          <Plus className="size-4" aria-hidden="true" />
          Ajouter un événement
        </Button>
      </div>
    )
  }

  // Répartition : avant 07:00, par créneau horaire (07:00 → 22:59), après 22:59
  const early: EventDto[] = []
  const late: EventDto[] = []
  const byHour: EventDto[][] = Array.from({ length: HOUR_ROW_COUNT }, () => [])
  for (const ev of events) {
    const hour = eventStart(ev).getHours()
    if (hour < HOUR_START) early.push(ev)
    else if (hour > HOUR_END) late.push(ev)
    else byHour[hour - HOUR_START].push(ev)
  }

  const earlyBlock = early.length > 0 && (
    <div className="border-t border-border/50">
      <p className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
        Plus tôt
      </p>
      {early.map((ev) => (
        <AgendaRow key={ev.id} event={ev} onEdit={onEdit} />
      ))}
    </div>
  )

  const lateBlock = late.length > 0 && (
    <div className="border-t border-border/50">
      <p className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
        Plus tard
      </p>
      {late.map((ev) => (
        <AgendaRow key={ev.id} event={ev} onEdit={onEdit} />
      ))}
    </div>
  )

  return (
    <section aria-label="Vue jour">
      {earlyBlock}
      {byHour.map((hourEvents, i) => {
        const hour = HOUR_START + i
        return (
          <div
            key={hour}
            className="border-t border-border/50 first:border-t-0"
          >
            {hourEvents.length === 0 ? (
              <button
                type="button"
                className="flex min-h-[44px] w-full cursor-pointer items-center px-3 text-left transition-colors hover:bg-muted/25"
                onClick={() => onCreate(atHour(day, hour))}
                aria-label={`Ajouter un événement à ${hourLabel(hour)}`}
              >
                <span className="text-xs tabular-nums text-muted-foreground/70">
                  {hourLabel(hour)}
                </span>
              </button>
            ) : (
              hourEvents.map((ev) => (
                <AgendaRow
                  key={ev.id}
                  event={ev}
                  onEdit={onEdit}
                  onSlotCreate={() => onCreate(atHour(day, hour))}
                />
              ))
            )}
          </div>
        )
      })}
      {lateBlock}
    </section>
  )
}

// ---------- Composant principal ----------

export function CalendarView() {
  const { data, isLoading, isError, refetch } = useEvents()

  const [view, setView] = useState<ViewMode>("month")
  const [cursor, setCursor] = useState(() => new Date())

  // Dialog création / édition
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<EventDto | null>(null)
  const [dialogDate, setDialogDate] = useState<Date | undefined>(undefined)

  const events = useMemo(() => data?.events ?? [], [data])
  const eventsByDay = useMemo(() => {
    const map: EventMap = new Map()
    for (const ev of events) {
      const key = dayKey(eventStart(ev))
      const list = map.get(key)
      if (list) list.push(ev)
      else map.set(key, [ev])
    }
    return map
  }, [events])

  const openCreate = useCallback((date: Date) => {
    setEditing(null)
    setDialogDate(date)
    setDialogOpen(true)
  }, [])

  const openEdit = useCallback((event: EventDto) => {
    setEditing(event)
    setDialogOpen(true)
  }, [])

  const viewDay = useCallback((day: Date) => {
    setCursor(day)
    setView("day")
  }, [])

  const title = useMemo(() => {
    if (view === "month") return format(cursor, "MMMM yyyy", { locale: fr })
    if (view === "week") {
      const weekStart = startOfWeek(cursor, WEEK_OPTIONS)
      const weekEnd = endOfWeek(cursor, WEEK_OPTIONS)
      return isSameMonth(weekStart, weekEnd)
        ? `${format(weekStart, "d", { locale: fr })} – ${format(weekEnd, "d MMMM yyyy", { locale: fr })}`
        : `${format(weekStart, "d MMMM", { locale: fr })} – ${format(weekEnd, "d MMMM yyyy", { locale: fr })}`
    }
    return format(cursor, "EEEE d MMMM yyyy", { locale: fr })
  }, [view, cursor])

  const goPrev = useCallback(() => {
    setCursor((c) =>
      view === "month" ? addMonths(c, -1) : view === "week" ? addWeeks(c, -1) : addDays(c, -1),
    )
  }, [view])

  const goNext = useCallback(() => {
    setCursor((c) =>
      view === "month" ? addMonths(c, 1) : view === "week" ? addWeeks(c, 1) : addDays(c, 1),
    )
  }, [view])

  const goToday = useCallback(() => setCursor(new Date()), [])

  const handleViewChange = useCallback((value: string) => {
    if (value === "month" || value === "week" || value === "day") setView(value)
  }, [])

  const prevLabel =
    view === "month" ? "Mois précédent" : view === "week" ? "Semaine précédente" : "Jour précédent"
  const nextLabel =
    view === "month" ? "Mois suivant" : view === "week" ? "Semaine suivante" : "Jour suivant"

  return (
    <section aria-label="Calendrier" className="flex flex-col gap-4">
      {/* Barre d'outils */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="w-full min-w-0 truncate text-base font-medium lowercase tracking-tight text-foreground/90 sm:w-auto sm:max-w-64 sm:text-lg lg:max-w-none">
          {title}
        </h2>
        <nav className="flex items-center gap-1.5" aria-label="Navigation dans le calendrier">
          <Button
            variant="outline"
            size="icon"
            className="size-11"
            onClick={goPrev}
            aria-label={prevLabel}
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-11"
            onClick={goNext}
            aria-label={nextLabel}
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </Button>
          <Button variant="ghost" className="h-11 px-4" onClick={goToday}>
            Aujourd&apos;hui
          </Button>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <ToggleGroup
            type="single"
            variant="outline"
            value={view}
            onValueChange={handleViewChange}
            aria-label="Mode d'affichage du calendrier"
          >
            <ToggleGroupItem value="month" className="h-11 cursor-pointer px-3">
              Mois
            </ToggleGroupItem>
            <ToggleGroupItem value="week" className="h-11 cursor-pointer px-3">
              Semaine
            </ToggleGroupItem>
            <ToggleGroupItem value="day" className="h-11 cursor-pointer px-3">
              Jour
            </ToggleGroupItem>
          </ToggleGroup>
          <Button className="h-11" onClick={() => openCreate(withCurrentTime(cursor))}>
            <Plus className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Nouvel événement</span>
          </Button>
        </div>
      </header>

      {/* Corps */}
      {isLoading ? (
        <div role="status" aria-label="Chargement du calendrier" className="space-y-2 p-4">
          <span className="sr-only">Chargement du calendrier…</span>
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-16 w-full rounded-lg sm:h-24" />
          ))}
        </div>
      ) : isError ? (
        <Card className="items-center gap-3 py-12 text-center">
          <p className="px-6 text-sm text-muted-foreground">
            Impossible de charger le calendrier.
          </p>
          <Button variant="outline" className="h-11" onClick={() => void refetch()}>
            Réessayer
          </Button>
        </Card>
      ) : events.length === 0 ? (
        <Card className="items-center gap-3 py-14 text-center">
          <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
            <CalendarDays className="size-6 text-primary" aria-hidden="true" />
          </div>
          <p className="max-w-sm px-6 text-sm text-muted-foreground">
            Aucun événement pour l&apos;instant. Votre calendrier Orbit attend son premier
            rendez-vous.
          </p>
          <Button className="h-11" onClick={() => openCreate(withCurrentTime(cursor))}>
            <Plus className="size-4" aria-hidden="true" />
            Nouvel événement
          </Button>
        </Card>
      ) : (
        <Card className="gap-0 overflow-hidden py-0">
          {view === "month" ? (
            <MonthGrid
              cursor={cursor}
              eventsByDay={eventsByDay}
              onCreate={openCreate}
              onEdit={openEdit}
              onViewDay={viewDay}
            />
          ) : view === "week" ? (
            <WeekGrid
              cursor={cursor}
              eventsByDay={eventsByDay}
              onCreate={openCreate}
              onEdit={openEdit}
            />
          ) : (
            <DayAgenda
              day={cursor}
              events={eventsByDay.get(dayKey(cursor)) ?? []}
              onCreate={openCreate}
              onEdit={openEdit}
            />
          )}
        </Card>
      )}

      <EventDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        event={editing}
        defaultDate={dialogDate}
      />
    </section>
  )
}
