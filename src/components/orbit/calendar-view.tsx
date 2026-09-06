"use client"

// Orbit — Vue Calendrier complète : Mois / Semaine / Jour / Agenda
// ─────────────────────────────────────────────────────────────────────────────
// Task 12-c — réécriture totale de l'ancienne vue 3-modes (~900 lignes).
//
// PRINCIPES :
// • RÈGLE D'OR (fuseaux) : les instants du serveur sont TOUJOURS UTC ; tout
//   l'affichage passe par le fuseau choisi (useTimezone) — regroupement par
//   jour via dayKey(e.startTime) (fuseau AFFICHÉ), positionnement des cartes
//   via toWall(e.startTime) (champs UTC = heures murales du fuseau affiché).
// • Grille : les jours affichés sont des dates MURALES dans le fuseau choisi
//   (wallDays) ; la clé wallKey(jour) correspond au dayKey(instant) des
//   événements → colonne correcte quel que soit le fuseau d'affichage.
// • Plage de requête : useCalendar calcule range en fuseau NAVIGATEUR
//   (date-fns local) → on l'élargit de ±2 jours (FETCH_PAD_MS) pour couvrir
//   les événements à cheval sur minuit quand fuseau d'affichage ≠ navigateur.
// • Occurrences expansées : clé React unique = `${id}:${startTime}`
//   (eventKeyOf — un master peut apparaître 12 fois dans la plage).
// • Drag & drop (dnd-kit) : UN droppable par colonne de jour + un par cellule
//   « journée entière ». Le créneau cible (15 min) est calculé aux
//   COORDONNÉES du drop : centre de la carte déposée (active.rect.current
//   .translated) dans le rect de la colonne (over.rect) → minutes, snap 15.
//   Choix documenté : bien plus robuste et performant qu'une grille de
//   448 droppables 15-min (64 lignes × 7 colonnes), et le snap est appliqué
//   au calcul au lieu d'être imposé par la géométrie.
// • MAJ optimiste : patch de TOUS les caches ["events"] via setQueriesData
//   (généralisation du setQueryData(["events","range", clé exacte]) —
//   la clé exacte inclut les ISO start/end et change à chaque plage ; le
//   filtre préfixe ["events"] couvre la plage courante ET le centre de
//   notifications). Rollback = invalidateQueries (vérité serveur).
// • Redimensionnement : poignée basse en pointer events natifs
//   (setPointerCapture) + clavier (flèches haut/bas = ±15 min).
// • Portée série : déplacer/redimensionner une occurrence envoie
//   scope "single" (l'occurrence est détachée — contrat backend 12-a).

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useNewIntent } from "@/lib/ui-intent"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { format } from "date-fns"
import { fr } from "date-fns/locale"
import { toast } from "sonner"
import {
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Download,
  Filter,
  MapPin,
  Plus,
  Repeat,
  Search,
  TriangleAlert,
  Upload,
  Users,
  X,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Skeleton } from "@/components/ui/skeleton"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { EventCard, eventChipStyle, eventKeyOf, SOURCE_ICON, SOURCE_META } from "@/components/orbit/event-card"
import { EventDialog } from "@/components/orbit/event-dialog"
import { TimezoneSelector } from "@/components/orbit/timezone-selector"
import { useCalendar, type CalendarViewMode } from "@/hooks/useCalendar"
import { useTimezone } from "@/hooks/useTimezone"
import { useIsMobile } from "@/hooks/use-mobile"
import {
  exportEvents,
  useEventImport,
  useEventsRange,
  useEventMutations,
  type EventInput,
} from "@/lib/api-client"
import { utcToWall, wallToFormatable } from "@/lib/timezone"
import type { EventDto, EventSource, RecurrenceRule } from "@/lib/types"
import { cn } from "@/lib/utils"

// ---------- Constantes ----------

const DAY_MS = 86_400_000

const WEEKDAY_SHORT = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"] as const
const WEEKDAY_LONG = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"] as const

const HOUR_START = 7
const HOUR_END = 22
const HOUR_ROW_COUNT = HOUR_END - HOUR_START + 1 // 16 lignes : 07:00 → 22:59
const ROW_HEIGHT = 44 // px par ligne d'une heure (cible tactile)
const GRID_MINUTES = HOUR_ROW_COUNT * 60

const MAX_MONTH_CHIPS = 3
const MAX_MOBILE_DOTS = 6
const MIN_EVENT_HEIGHT = 20 // px

/** Marge (jours) autour de la plage useCalendar (calculée en fuseau navigateur). */
const FETCH_PAD_MS = 2 * DAY_MS
/** Extension « Charger plus » de l'agenda : 14 j par clic (borne plage API 400 j). */
const AGENDA_PAGE_DAYS = 14
const AGENDA_MAX_EXTRA = 26

const SOURCE_FILTERS: { value: EventSource; label: string }[] = [
  { value: "manual", label: "Manuel" },
  { value: "email_extract", label: "Email" },
  { value: "ai", label: "IA" },
  { value: "import", label: "Import" },
]

/** Seuil (px) au-delà duquel un pointerdown+click est considéré comme un drag. */
const DRAG_CLICK_THRESHOLD = 6

/** Collision : priorité à ce qui est sous le curseur, sinon intersection géométrique. */
const collisionDetection: CollisionDetection = (args) => {
  const pointerCollisions = pointerWithin(args)
  return pointerCollisions.length > 0 ? pointerCollisions : rectIntersection(args)
}

// ---------- Petites aides ----------

/** Recherche insensible à la casse et aux accents (É → e). */
function fold(value: string): string {
  return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Une erreur est survenue"
}

/** Clé de jour "yyyy-MM-dd" d'une date MURALE (champs UTC = heure affichée). */
function wallKey(wall: Date): string {
  return `${wall.getUTCFullYear()}-${String(wall.getUTCMonth() + 1).padStart(2, "0")}-${String(
    wall.getUTCDate()
  ).padStart(2, "0")}`
}

/** Minuit mural (ms) d'une date murale. */
function wallMidnight(wall: Date): number {
  return Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate())
}

/** Minutes depuis minuit d'une date murale. */
function wallMinutes(wall: Date): number {
  return wall.getUTCHours() * 60 + wall.getUTCMinutes()
}

/** Jour de semaine (0 = lundi … 6 = dimanche) d'une date murale (ms). */
function wallWeekday(wallMs: number): number {
  return (new Date(wallMs).getUTCDay() + 6) % 7
}

/** Formate une date MURALE via date-fns fr (aucune conversion de fuseau). */
function formatWall(wall: Date, pattern: string): string {
  return format(wallToFormatable(wall), pattern, { locale: fr })
}

function snapMinutes(value: number, step = 15): number {
  return Math.round(value / step) * step
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

/** Résumé humain d'une règle de récurrence (« chaque semaine (mardi), 12 fois »). */
function recurrenceSummary(
  rule: RecurrenceRule,
  startWall: Date,
  fmt: (d: Date, p: string) => string
): string {
  const interval = rule.interval
  let base: string
  if (rule.frequency === "daily") {
    base = interval > 1 ? `tous les ${interval} jours` : "chaque jour"
  } else if (rule.frequency === "weekly") {
    const days = (rule.byDays ?? [])
      .slice()
      .sort((a, b) => a - b)
      .map((d) => WEEKDAY_LONG[d] ?? "")
      .filter(Boolean)
      .join(", ")
    base = `${interval > 1 ? `toutes les ${interval} semaines` : "chaque semaine"}${days ? ` (${days})` : ""}`
  } else {
    const prefix = interval > 1 ? `tous les ${interval} mois` : "chaque mois"
    if (rule.nth) {
      const weekday = WEEKDAY_LONG[rule.byDays?.[0] ?? wallWeekday(wallMidnight(startWall))] ?? "jour"
      const nthLabel = rule.nth === -1 ? "dernier" : `${rule.nth}${rule.nth === 1 ? "er" : "e"}`
      base = `${prefix} le ${nthLabel} ${weekday}`
    } else {
      base = `${prefix} le ${startWall.getUTCDate()}`
    }
  }
  if (rule.count) return `${base}, ${rule.count} fois`
  if (rule.until) return `${base}, jusqu'au ${fmt(new Date(rule.until), "d MMMM yyyy")}`
  return base
}

/** Clés des événements horaires qui en chevauchent strictement au moins un autre. */
function computeConflictKeys(events: EventDto[]): Set<string> {
  const out = new Set<string>()
  const spans = events.map((ev) => ({
    key: eventKeyOf(ev),
    s: Date.parse(ev.startTime),
    e: Date.parse(ev.endTime),
  }))
  for (let i = 0; i < spans.length; i += 1) {
    for (let j = i + 1; j < spans.length; j += 1) {
      if (spans[i].s < spans[j].e && spans[j].s < spans[i].e) {
        out.add(spans[i].key)
        out.add(spans[j].key)
      }
    }
  }
  return out
}

// ---------- Placement en couloirs (vue Semaine / Jour) ----------

type LaneItem = {
  event: EventDto
  start: number // minutes depuis 07:00
  end: number
  lane: number
  laneCount: number
}

/**
 * Répartit les événements d'une journée sur des « couloirs » horizontaux
 * quand ils se chevauchent (grappes transitives). Repris de l'ancienne vue.
 */
function assignLanes(items: { event: EventDto; start: number; end: number }[]): LaneItem[] {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end)
  const laneEnds: number[] = []
  const placed: LaneItem[] = sorted.map((item) => {
    let lane = laneEnds.findIndex((end) => end <= item.start)
    if (lane === -1) {
      lane = laneEnds.length
      laneEnds.push(item.end)
    } else {
      laneEnds[lane] = item.end
    }
    return { ...item, lane, laneCount: 1 }
  })

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

// ---------- Tooltip partagé ----------

function EventTooltipBody({
  event,
  fmt,
  displayTz,
  conflict,
}: {
  event: EventDto
  fmt: (d: Date, p: string) => string
  displayTz: string
  conflict?: boolean
}) {
  const start = new Date(event.startTime)
  const end = new Date(event.endTime)
  const tzSuffix = event.timezone && event.timezone !== displayTz ? ` (${event.timezone})` : ""
  const recurring = event.recurrence || event.isOccurrence
  return (
    <div className="max-w-60 space-y-1 text-xs">
      <p className="font-semibold">{event.title}</p>
      <p className="opacity-80">
        {event.allDay
          ? `Journée entière · ${fmt(start, "EEEE d MMMM")}`
          : `${fmt(start, "EEEE d MMMM · HH:mm")} – ${fmt(end, "HH:mm")}${tzSuffix}`}
      </p>
      {event.location && (
        <p className="flex items-center gap-1 opacity-70">
          <MapPin className="size-3 shrink-0" aria-hidden="true" />
          {event.location}
        </p>
      )}
      {event.recurrence && (
        <p className="flex items-center gap-1 opacity-70">
          <Repeat className="size-3 shrink-0" aria-hidden="true" />
          répété : {recurrenceSummary(event.recurrence, utcToWall(start, event.timezone || "UTC"), fmt)}
        </p>
      )}
      {recurring && !event.recurrence && (
        <p className="flex items-center gap-1 opacity-70">
          <Repeat className="size-3 shrink-0" aria-hidden="true" />
          occurrence d&apos;une série
        </p>
      )}
      {conflict && (
        <p className="flex items-center gap-1 font-medium text-destructive">
          <TriangleAlert className="size-3 shrink-0" aria-hidden="true" />
          Conflit d&apos;horaire
        </p>
      )}
    </div>
  )
}

// ---------- Vue Mois ----------

function MonthGrid({
  days,
  monthKey,
  eventsByDay,
  nowInfo,
  fmt,
  displayTz,
  isMobile,
  onCreateForDay,
  onOpen,
  onViewDay,
}: {
  days: Date[]
  monthKey: string
  eventsByDay: Map<string, EventDto[]>
  nowInfo: { key: string; minutes: number }
  fmt: (d: Date, p: string) => string
  displayTz: string
  isMobile: boolean
  onCreateForDay: (wallDay: Date) => void
  onOpen: (event: EventDto) => void
  onViewDay: (wallDay: Date) => void
}) {
  return (
    <section aria-label="Vue mois" className="select-none">
      <div className="grid grid-cols-7 border-b border-border/50">
        {WEEKDAY_SHORT.map((label) => (
          <div
            key={label}
            className="py-2.5 text-center text-xs font-medium text-muted-foreground/80"
          >
            {label}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-px bg-border/50">
        {days.map((dayWall) => {
          const key = wallKey(dayWall)
          const inMonth = key.slice(0, 7) === monthKey
          const isToday = key === nowInfo.key
          const weekend = wallWeekday(wallMidnight(dayWall)) >= 5
          const dayEvents = eventsByDay.get(key) ?? []
          // Journées entières d'abord (usage calendrier classique).
          const ordered = [
            ...dayEvents.filter((ev) => ev.allDay),
            ...dayEvents.filter((ev) => !ev.allDay),
          ]
          const extra = ordered.length - MAX_MONTH_CHIPS
          return (
            <div
              key={key}
              className={cn(
                "flex min-h-[72px] cursor-pointer flex-col gap-1 bg-card p-1.5 transition-colors hover:bg-muted/30 sm:min-h-[104px] sm:p-2",
                inMonth && weekend && "bg-muted/[0.07]",
                !inMonth && "opacity-60"
              )}
              onClick={() => onCreateForDay(dayWall)}
              aria-label={`${formatWall(dayWall, "EEEE d MMMM")} — ${ordered.length} événement${ordered.length > 1 ? "s" : ""}`}
            >
              <span
                className={cn(
                  "flex size-6 items-center justify-center rounded-full text-xs font-medium sm:size-7 sm:text-sm",
                  isToday
                    ? "bg-primary font-semibold text-primary-foreground"
                    : inMonth
                      ? "text-foreground/85"
                      : "text-muted-foreground/40"
                )}
              >
                {formatWall(dayWall, "d")}
              </span>

              {/* Puces (desktop) */}
              <div className="hidden flex-col gap-1 sm:flex">
                {ordered.slice(0, MAX_MONTH_CHIPS).map((ev) => {
                  const chip = eventChipStyle(ev)
                  const recurring = ev.recurrence || ev.isOccurrence
                  return (
                    <Tooltip key={eventKeyOf(ev)}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            onOpen(ev)
                          }}
                          className={cn(
                            "relative flex w-full cursor-pointer items-center gap-1 truncate rounded-md border-l-[3px] px-1.5 py-1 text-left text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            chip.className,
                            ev.allDay && "font-semibold"
                          )}
                          style={chip.style}
                          aria-label={`${ev.title} — ${ev.allDay ? "journée entière" : `${fmt(new Date(ev.startTime), "HH:mm")} – ${fmt(new Date(ev.endTime), "HH:mm")}`}`}
                        >
                          {/* Journée entière : fond légèrement plus dense (voile) */}
                          {ev.allDay && (
                            <span className="pointer-events-none absolute inset-0 rounded-r-md bg-foreground/10" aria-hidden="true" />
                          )}
                          {ev.allDay && <CalendarDays className="relative size-3 shrink-0" aria-hidden="true" />}
                          <span className="relative truncate">{ev.title}</span>
                          {recurring && (
                            <Repeat className="relative size-3 shrink-0 opacity-70" aria-label="récurrent" />
                          )}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        <EventTooltipBody event={ev} fmt={fmt} displayTz={displayTz} />
                      </TooltipContent>
                    </Tooltip>
                  )
                })}
                {extra > 0 && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation()
                      onViewDay(dayWall)
                    }}
                    className="w-fit cursor-pointer px-1 text-left text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    +{extra} autre{extra > 1 ? "s" : ""}
                  </button>
                )}
              </div>

              {/* Points colorés (mobile) */}
              {isMobile && (
                <div className="flex flex-wrap items-center gap-1 sm:hidden">
                  {ordered.slice(0, MAX_MOBILE_DOTS).map((ev) => (
                    <Tooltip key={eventKeyOf(ev)}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation()
                            onOpen(ev)
                          }}
                          className="-m-0.5 flex size-4 cursor-pointer items-center justify-center rounded-full"
                          aria-label={`${ev.title} — ${ev.allDay ? "journée entière" : fmt(new Date(ev.startTime), "HH:mm")}`}
                        >
                          <span
                            className={cn("size-2 rounded-full", !ev.color && SOURCE_META[ev.source].dot)}
                            style={ev.color ? { backgroundColor: ev.color } : undefined}
                          />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        <EventTooltipBody event={ev} fmt={fmt} displayTz={displayTz} />
                      </TooltipContent>
                    </Tooltip>
                  ))}
                  {ordered.length > MAX_MOBILE_DOTS && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation()
                        onViewDay(dayWall)
                      }}
                      className="cursor-pointer text-[10px] text-muted-foreground transition-colors hover:text-foreground"
                    >
                      +{ordered.length - MAX_MOBILE_DOTS}
                    </button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </section>
  )
}

// ---------- Carte horaire (Semaine / Jour) : draggable + redimensionnable ----------

type TimeEventCardProps = {
  event: EventDto
  startMin: number // minutes depuis 07:00 (peut dépasser la grille)
  endMin: number
  lane: number
  laneCount: number
  conflict: boolean
  variant: "week" | "day"
  fmt: (d: Date, p: string) => string
  displayTz: string
  onOpen: (event: EventDto) => void
  onResize: (event: EventDto, durationMin: number) => void
}

function TimeEventCard({
  event,
  startMin,
  endMin,
  lane,
  laneCount,
  conflict,
  variant,
  fmt,
  displayTz,
  onOpen,
  onResize,
}: TimeEventCardProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: eventKeyOf(event),
    data: { event },
  })
  const chip = eventChipStyle(event)
  const recurring = event.recurrence || event.isOccurrence
  const SourceIcon = SOURCE_ICON[event.source]

  const renderStart = clampNumber(startMin, 0, GRID_MINUTES)
  const renderEnd = clampNumber(Math.max(endMin, renderStart + 1), renderStart + 1, GRID_MINUTES)

  // Aperçu pendant le redimensionnement (null = état réel).
  const [previewEnd, setPreviewEnd] = useState<number | null>(null)
  const resizeBaseRef = useRef<{ y: number; endMin: number } | null>(null)
  const previewRef = useRef<number | null>(null)

  const top = (renderStart / 60) * ROW_HEIGHT
  const effectiveEnd = previewEnd ?? renderEnd
  const height = Math.max(((effectiveEnd - renderStart) / 60) * ROW_HEIGHT, MIN_EVENT_HEIGHT)
  const widthPct = 100 / laneCount

  // Clic vs drag (pattern tasks-view) : le clic n'ouvre le dialog que si le
  // pointeur n'a pas bougé de plus de 6 px (sinon c'était un déplacement).
  const pointerOrigin = useRef<{ x: number; y: number } | null>(null)

  function handlePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    pointerOrigin.current = { x: e.clientX, y: e.clientY }
    listeners?.onPointerDown?.(e)
  }

  function handleClick(e: ReactMouseEvent<HTMLDivElement>) {
    e.stopPropagation()
    const origin = pointerOrigin.current
    pointerOrigin.current = null
    if (
      origin &&
      (Math.abs(e.clientX - origin.x) > DRAG_CLICK_THRESHOLD ||
        Math.abs(e.clientY - origin.y) > DRAG_CLICK_THRESHOLD)
    ) {
      return
    }
    onOpen(event)
  }

  // ----- Redimensionnement (pointer events natifs + capture) -----

  function handleResizePointerDown(e: ReactPointerEvent<HTMLDivElement>) {
    // stopPropagation : la poignée ne doit PAS activer le drag dnd-kit de la carte.
    e.stopPropagation()
    e.preventDefault()
    resizeBaseRef.current = { y: e.clientY, endMin }
    previewRef.current = endMin
    setPreviewEnd(endMin)
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function handleResizePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
    const base = resizeBaseRef.current
    if (!base) return
    const delta = ((e.clientY - base.y) / ROW_HEIGHT) * 60
    const target = clampNumber(snapMinutes(base.endMin + delta), renderStart + 15, GRID_MINUTES)
    previewRef.current = target
    setPreviewEnd(target)
  }

  function handleResizePointerUp() {
    const base = resizeBaseRef.current
    const target = previewRef.current
    resizeBaseRef.current = null
    previewRef.current = null
    setPreviewEnd(null)
    if (base && target !== null && target !== base.endMin) {
      onResize(event, clampNumber(target - renderStart, 15, GRID_MINUTES - renderStart))
    }
  }

  /** Bonus clavier : flèches haut/bas = ±15 min (commit immédiat). */
  function handleResizeKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return
    e.preventDefault()
    const delta = e.key === "ArrowDown" ? 15 : -15
    const duration = clampNumber(endMin - renderStart + delta, 15, GRID_MINUTES - renderStart)
    onResize(event, duration)
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          ref={setNodeRef}
          {...attributes}
          {...listeners}
          onPointerDown={handlePointerDown}
          onClick={handleClick}
          className={cn(
            "group/card absolute z-10 cursor-grab select-none overflow-hidden rounded-md border-l-[3px] px-1.5 py-1 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing",
            chip.className,
            isDragging && "opacity-40",
            conflict && "outline-dashed outline-1 outline-offset-[-1px] outline-destructive/80"
          )}
          style={{
            top,
            height,
            left: `calc(${lane * widthPct}% + 2px)`,
            width: `calc(${widthPct}% - 4px)`,
            ...chip.style,
          }}
          aria-label={`${event.title} — ${fmt(new Date(event.startTime), "HH:mm")} – ${fmt(new Date(event.endTime), "HH:mm")}${conflict ? " — conflit d'horaire" : ""}`}
        >
          {variant === "week" ? (
            <>
              <span className="flex items-center gap-1">
                <span className="truncate text-[11px] font-semibold leading-tight">{event.title}</span>
                {recurring && <Repeat className="size-3 shrink-0 opacity-70" aria-label="récurrent" />}
                {conflict && (
                  <TriangleAlert className="size-3 shrink-0 text-destructive" aria-label="Conflit d'horaire" />
                )}
              </span>
              {height >= 34 && (
                <span className="block truncate text-[10px] font-normal leading-tight opacity-75">
                  {fmt(new Date(event.startTime), "HH:mm")}
                </span>
              )}
            </>
          ) : (
            <span className="flex h-full min-w-0 gap-1.5">
              <span className="flex w-12 shrink-0 items-start justify-end pr-1 pt-0.5 text-[11px] font-bold tabular-nums leading-tight">
                {fmt(new Date(event.startTime), "HH:mm")}
              </span>
              <span className="min-w-0 flex-1 overflow-hidden">
                <span className="flex items-center gap-1">
                  <span className="truncate text-[11px] font-semibold leading-tight">{event.title}</span>
                  {recurring && <Repeat className="size-3 shrink-0 opacity-70" aria-label="récurrent" />}
                  {conflict && (
                    <TriangleAlert className="size-3 shrink-0 text-destructive" aria-label="Conflit d'horaire" />
                  )}
                </span>
                {height >= 52 && event.description && (
                  <span className="block truncate text-[10px] leading-tight opacity-70">
                    {event.description}
                  </span>
                )}
                {height >= 62 && event.location && (
                  <span className="flex items-center gap-0.5 truncate text-[10px] leading-tight opacity-70">
                    <MapPin className="size-2.5 shrink-0" aria-hidden="true" />
                    {event.location}
                  </span>
                )}
                {height >= 74 && (event.attendees?.length ?? 0) > 0 && (
                  <span className="mt-0.5 flex items-center gap-1 text-[10px] leading-tight opacity-70">
                    <Users className="size-2.5 shrink-0" aria-hidden="true" />
                    {event.attendees?.length} participant{event.attendees && event.attendees.length > 1 ? "s" : ""}
                  </span>
                )}
                {height >= 74 && event.source !== "manual" && (
                  <Badge
                    variant="outline"
                    className={cn(
                      "mt-0.5 w-fit gap-1 px-1 py-0 text-[9px] leading-none font-normal",
                      SOURCE_META[event.source].badge
                    )}
                  >
                    {SourceIcon && <SourceIcon className="size-2.5" aria-hidden="true" />}
                    {SOURCE_META[event.source].label}
                  </Badge>
                )}
              </span>
            </span>
          )}

          {/* Poignée de redimensionnement (durée) */}
          <div
            role="slider"
            aria-orientation="vertical"
            aria-label={`Redimensionner « ${event.title} » — flèches haut/bas : ±15 minutes`}
            aria-valuenow={Math.round(endMin - renderStart)}
            aria-valuemin={15}
            tabIndex={0}
            className="absolute inset-x-0 bottom-0 flex h-2 cursor-ns-resize items-end justify-center rounded-b-md outline-none transition-colors focus-visible:bg-primary/30 focus-visible:ring-1 focus-visible:ring-ring"
            onPointerDown={handleResizePointerDown}
            onPointerMove={handleResizePointerMove}
            onPointerUp={handleResizePointerUp}
            onKeyDown={handleResizeKeyDown}
          >
            <span className="h-0.5 w-6 rounded-full bg-foreground/40" aria-hidden="true" />
          </div>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top">
        <EventTooltipBody event={event} fmt={fmt} displayTz={displayTz} conflict={conflict} />
      </TooltipContent>
    </Tooltip>
  )
}

// ---------- Cellule « journée entière » (droppable + chips) ----------

function AllDayChip({
  event,
  fmt,
  displayTz,
  onOpen,
}: {
  event: EventDto
  fmt: (d: Date, p: string) => string
  displayTz: string
  onOpen: (event: EventDto) => void
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: eventKeyOf(event),
    data: { event },
  })
  const chip = eventChipStyle(event)
  const pointerOrigin = useRef<{ x: number; y: number } | null>(null)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={setNodeRef}
          type="button"
          {...attributes}
          {...listeners}
          onPointerDown={(e) => {
            pointerOrigin.current = { x: e.clientX, y: e.clientY }
            listeners?.onPointerDown?.(e)
          }}
          onClick={(e) => {
            e.stopPropagation()
            const origin = pointerOrigin.current
            pointerOrigin.current = null
            if (
              origin &&
              (Math.abs(e.clientX - origin.x) > DRAG_CLICK_THRESHOLD ||
                Math.abs(e.clientY - origin.y) > DRAG_CLICK_THRESHOLD)
            ) {
              return
            }
            onOpen(event)
          }}
          className={cn(
            "flex shrink-0 cursor-grab items-center gap-1 rounded-md border-l-[3px] px-1.5 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            chip.className,
            isDragging && "opacity-40"
          )}
          style={chip.style}
          aria-label={`${event.title} — journée entière`}
        >
          <CalendarDays className="size-3 shrink-0" aria-hidden="true" />
          <span className="max-w-32 truncate">{event.title}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top">
        <EventTooltipBody event={event} fmt={fmt} displayTz={displayTz} />
      </TooltipContent>
    </Tooltip>
  )
}

function AllDayCell({
  dayWall,
  events,
  fmt,
  displayTz,
  onOpen,
}: {
  dayWall: Date
  events: EventDto[]
  fmt: (d: Date, p: string) => string
  displayTz: string
  onOpen: (event: EventDto) => void
}) {
  const key = wallKey(dayWall)
  const { setNodeRef, isOver } = useDroppable({
    id: `allday:${key}`,
    data: { wallKey: key, kind: "allday" },
  })
  return (
    <div
      ref={setNodeRef}
      className={cn(
        "orbit-scroll flex min-h-11 items-center gap-1 overflow-x-auto border-l border-border/30 p-1 transition-colors",
        isOver && "bg-primary/10"
      )}
      aria-label={`Journées entières du ${formatWall(dayWall, "d MMMM")}`}
    >
      {events.map((ev) => (
        <AllDayChip key={eventKeyOf(ev)} event={ev} fmt={fmt} displayTz={displayTz} onOpen={onOpen} />
      ))}
    </div>
  )
}

// ---------- Colonne horaire (droppable) ----------

function TimeColumn({
  dayWall,
  lanes,
  conflictKeys,
  nowInfo,
  variant,
  fmt,
  displayTz,
  onCreateAt,
  onOpen,
  onResize,
}: {
  dayWall: Date
  lanes: LaneItem[]
  conflictKeys: Set<string>
  nowInfo: { key: string; minutes: number }
  variant: "week" | "day"
  fmt: (d: Date, p: string) => string
  displayTz: string
  onCreateAt: (wallDay: Date, minutes: number) => void
  onOpen: (event: EventDto) => void
  onResize: (event: EventDto, durationMin: number) => void
}) {
  const key = wallKey(dayWall)
  const { setNodeRef, isOver } = useDroppable({
    id: `col:${key}`,
    data: { wallKey: key, kind: "time" },
  })

  function handleSlotClick(e: ReactMouseEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect()
    // Minutes depuis MINUIT : le haut de la colonne = 07:00 (HOUR_START).
    const raw = HOUR_START * 60 + ((e.clientY - rect.top) / ROW_HEIGHT) * 60
    // Arrondi demi-heure au clic sur un créneau vide (comportement historique),
    // borné à la grille visible 07:00 → 22:30.
    onCreateAt(
      dayWall,
      clampNumber(
        snapMinutes(raw, 30),
        HOUR_START * 60,
        HOUR_START * 60 + GRID_MINUTES - 30
      )
    )
  }

  const nowTop =
    nowInfo.key === key && nowInfo.minutes >= 0 && nowInfo.minutes <= GRID_MINUTES
      ? (nowInfo.minutes / 60) * ROW_HEIGHT
      : null

  return (
    <div
      ref={setNodeRef}
      onClick={handleSlotClick}
      className={cn(
        "relative cursor-pointer border-l border-border/30 transition-colors",
        isOver && "bg-primary/5"
      )}
      style={{ height: HOUR_ROW_COUNT * ROW_HEIGHT }}
      aria-label={`Créneaux du ${formatWall(dayWall, "EEEE d MMMM")} — clic pour créer un événement`}
    >
      {/* Trame horaire (44 px / ligne) */}
      {Array.from({ length: HOUR_ROW_COUNT }, (_, i) => (
        <div key={i} className={cn("h-11", i > 0 && "border-t border-border/50")} aria-hidden="true" />
      ))}

      {lanes.map((item) => (
        <TimeEventCard
          key={eventKeyOf(item.event)}
          event={item.event}
          startMin={item.start}
          endMin={item.end}
          lane={item.lane}
          laneCount={item.laneCount}
          conflict={conflictKeys.has(eventKeyOf(item.event))}
          variant={variant}
          fmt={fmt}
          displayTz={displayTz}
          onOpen={onOpen}
          onResize={onResize}
        />
      ))}

      {/* Ligne « maintenant » (fuseau d'affichage) */}
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

// ---------- Grille Semaine / Jour (partagée) ----------

function TimeGridView({
  days,
  eventsByDay,
  variant,
  fmt,
  displayTz,
  toWall,
  nowInfo,
  onCreateAt,
  onOpen,
  onResize,
  onViewDay,
}: {
  days: Date[]
  eventsByDay: Map<string, EventDto[]>
  variant: "week" | "day"
  fmt: (d: Date, p: string) => string
  displayTz: string
  toWall: (d: Date) => Date
  nowInfo: { key: string; minutes: number }
  onCreateAt: (wallDay: Date, minutes: number) => void
  onOpen: (event: EventDto) => void
  onResize: (event: EventDto, durationMin: number) => void
  onViewDay: (wallDay: Date) => void
}) {
  const hours = useMemo(
    () => Array.from({ length: HOUR_ROW_COUNT }, (_, i) => HOUR_START + i),
    []
  )
  const colsTemplate =
    variant === "week" ? "grid-cols-[2.75rem_repeat(7,minmax(0,1fr))]" : "grid-cols-[2.75rem_minmax(0,1fr)]"

  // Positionnement par colonne + conflits + hors-grille (variante jour).
  const layout = useMemo(() => {
    const lanes = new Map<string, LaneItem[]>()
    const early = new Map<string, EventDto[]>()
    const late = new Map<string, EventDto[]>()
    const conflicts = new Map<string, Set<string>>()
    const allDay = new Map<string, EventDto[]>()
    for (const day of days) {
      const key = wallKey(day)
      const dayEvents = eventsByDay.get(key) ?? []
      const timed = dayEvents.filter((ev) => !ev.allDay)
      conflicts.set(key, computeConflictKeys(timed))
      allDay.set(
        key,
        dayEvents.filter((ev) => ev.allDay)
      )
      const items: { event: EventDto; start: number; end: number }[] = []
      const earlyList: EventDto[] = []
      const lateList: EventDto[] = []
      for (const ev of timed) {
        const start = wallMinutes(toWall(new Date(ev.startTime))) - HOUR_START * 60
        const end = wallMinutes(toWall(new Date(ev.endTime))) - HOUR_START * 60
        if (variant === "day") {
          // Sections « Plus tôt / Plus tard » hors de la grille 07:00 → 22:59.
          if (start < 0) {
            earlyList.push(ev)
            continue
          }
          if (start >= GRID_MINUTES) {
            lateList.push(ev)
            continue
          }
          items.push({ event: ev, start, end: Math.max(end, start + 1) })
        } else {
          if (start >= GRID_MINUTES) continue // après la grille : invisible en semaine
          const s = clampNumber(start, 0, GRID_MINUTES - 1)
          const e = clampNumber(Math.max(end, s + 1), s + 1, GRID_MINUTES)
          items.push({ event: ev, start: s, end: e })
        }
      }
      lanes.set(key, assignLanes(items))
      early.set(key, earlyList)
      late.set(key, lateList)
    }
    return { lanes, early, late, conflicts, allDay }
  }, [days, eventsByDay, toWall, variant])

  const dayKey0 = days.length > 0 ? wallKey(days[0]) : ""
  const earlyList = layout.early.get(dayKey0) ?? []
  const lateList = layout.late.get(dayKey0) ?? []

  return (
    <section
      aria-label={variant === "week" ? "Vue semaine" : "Vue jour"}
      className={cn("select-none", variant === "week" && "orbit-scroll overflow-x-auto")}
    >
      <div className={cn(variant === "week" && "min-w-[900px]")}>
        {/* En-têtes des jours (semaine) */}
        {variant === "week" && (
          <div className={cn("grid border-b border-border/50", colsTemplate)}>
            <div aria-hidden="true" />
            {days.map((dayWall) => {
              const key = wallKey(dayWall)
              const isToday = key === nowInfo.key
              return (
                <div key={key} className="py-2 text-center">
                  <button
                    type="button"
                    onClick={() => onViewDay(dayWall)}
                    className={cn(
                      "inline-flex cursor-pointer items-baseline gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      isToday
                        ? "bg-primary/15 font-semibold text-primary"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                    aria-label={`Voir le ${formatWall(dayWall, "EEEE d MMMM")}`}
                  >
                    <span>{WEEKDAY_SHORT[wallWeekday(wallMidnight(dayWall))]}</span>
                    <span>{formatWall(dayWall, "d")}</span>
                  </button>
                </div>
              )
            })}
          </div>
        )}

        {/* Rangée « journée entière » */}
        <div className={cn("grid border-b border-border/50 bg-muted/20", colsTemplate)}>
          <div className="flex items-center justify-end pr-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            Journée
          </div>
          {days.map((dayWall) => (
            <AllDayCell
              key={`ad-${wallKey(dayWall)}`}
              dayWall={dayWall}
              events={layout.allDay.get(wallKey(dayWall)) ?? []}
              fmt={fmt}
              displayTz={displayTz}
              onOpen={onOpen}
            />
          ))}
        </div>

        {/* Plus tôt (hors grille, vue jour) */}
        {variant === "day" && earlyList.length > 0 && (
          <div className="border-b border-border/50">
            <p className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              Plus tôt
            </p>
            <div className="flex flex-col gap-0.5 px-2 pb-2">
              {earlyList.map((ev) => (
                <EventCard key={eventKeyOf(ev)} event={ev} onClick={onOpen} fmt={fmt} compact />
              ))}
            </div>
          </div>
        )}

        {/* Corps : gouttière des heures + colonnes */}
        <div className={cn("grid", colsTemplate)}>
          <div aria-hidden="true">
            {hours.map((h, i) => (
              <div key={h} className="h-11 border-t border-border/50">
                {i % 2 === 0 && (
                  <span className="block -translate-y-1/2 pr-2 text-right text-[10px] leading-none text-muted-foreground">
                    {`${String(h).padStart(2, "0")}:00`}
                  </span>
                )}
              </div>
            ))}
          </div>
          {days.map((dayWall) => {
            const key = wallKey(dayWall)
            return (
              <TimeColumn
                key={`col-${key}`}
                dayWall={dayWall}
                lanes={layout.lanes.get(key) ?? []}
                conflictKeys={layout.conflicts.get(key) ?? new Set()}
                nowInfo={nowInfo}
                variant={variant}
                fmt={fmt}
                displayTz={displayTz}
                onCreateAt={onCreateAt}
                onOpen={onOpen}
                onResize={onResize}
              />
            )
          })}
        </div>

        {/* Plus tard (hors grille, vue jour) */}
        {variant === "day" && lateList.length > 0 && (
          <div className="border-t border-border/50">
            <p className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              Plus tard
            </p>
            <div className="flex flex-col gap-0.5 px-2 pb-2">
              {lateList.map((ev) => (
                <EventCard key={eventKeyOf(ev)} event={ev} onClick={onOpen} fmt={fmt} compact />
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

// ---------- Vue Agenda ----------

function AgendaView({
  days,
  eventsByDay,
  nowInfo,
  fmt,
  onOpen,
  canLoadMore,
  onLoadMore,
  loadingMore,
}: {
  days: Date[]
  eventsByDay: Map<string, EventDto[]>
  nowInfo: { key: string; minutes: number }
  fmt: (d: Date, p: string) => string
  onOpen: (event: EventDto) => void
  canLoadMore: boolean
  onLoadMore: () => void
  loadingMore: boolean
}) {
  return (
    <div>
      <ScrollArea className="orbit-scroll max-h-[70vh]">
        <div className="divide-y divide-border/50">
          {days.map((dayWall) => {
            const key = wallKey(dayWall)
            const list = eventsByDay.get(key) ?? []
            const isToday = key === nowInfo.key
            return (
              <section
                key={key}
                aria-label={`Agenda du ${formatWall(dayWall, "EEEE d MMMM yyyy")}`}
              >
                <header
                  className={cn(
                    "sticky top-0 z-10 flex items-center justify-between bg-card/95 px-3 py-1.5 text-xs font-semibold backdrop-blur-sm",
                    isToday ? "text-primary" : "text-muted-foreground"
                  )}
                >
                  {isToday ? "aujourd'hui" : formatWall(dayWall, "EEEE d MMMM")}
                  {list.length > 0 && (
                    <span className="text-[10px] font-normal tabular-nums opacity-70">
                      {list.length}
                    </span>
                  )}
                </header>
                <div className="flex flex-col gap-0.5 px-2 pb-1.5 pt-1">
                  {list.map((ev) => (
                    <EventCard key={eventKeyOf(ev)} event={ev} onClick={onOpen} fmt={fmt} />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      </ScrollArea>
      {canLoadMore && (
        <div className="border-t border-border/50 p-2">
          <Button
            variant="ghost"
            className="h-11 w-full cursor-pointer"
            onClick={onLoadMore}
            disabled={loadingMore}
          >
            {loadingMore ? "Chargement…" : `Charger plus (${AGENDA_PAGE_DAYS} jours)`}
          </Button>
        </div>
      )}
    </div>
  )
}

// ---------- Squelettes / états ----------

function CalendarSkeleton({ mode }: { mode: CalendarViewMode }) {
  return (
    <div role="status" aria-label="Chargement du calendrier" className="space-y-2">
      <span className="sr-only">Chargement du calendrier…</span>
      {mode === "month" ? (
        <div className="grid grid-cols-7 gap-1">
          {Array.from({ length: 42 }, (_, i) => (
            <Skeleton key={i} className="h-[72px] rounded-md sm:h-[104px]" />
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-20 rounded-lg" />
          ))}
        </div>
      )}
    </div>
  )
}

// ---------- Composant principal ----------

export function CalendarView() {
  const isMobile = useIsMobile()

  // Mode initial : agenda sur mobile (matchMedia SYNCHRONE au premier rendu —
  // useIsMobile ne se résout qu'après le premier effet, trop tard pour l'init
  // de useCalendar qui capture le mode une seule fois).
  const [initialMode] = useState<CalendarViewMode>(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches
      ? "agenda"
      : "month"
  )
  const { viewMode, cursor, range, setMode, setCursor, goToday, prev, next } = useCalendar({
    mode: initialMode,
  })
  const { timezone: displayTz, setTimezone, toWall, wallToUtcDate, fmt, dayKey } = useTimezone()
  const qc = useQueryClient()
  const { update } = useEventMutations()
  const importMutation = useEventImport()

  // Horloge discrète (ligne « maintenant », jour courant) — 60 s.
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(id)
  }, [])
  const nowWall = toWall(now)
  const nowInfo = { key: wallKey(nowWall), minutes: wallMinutes(nowWall) - HOUR_START * 60 }

  // ----- Plage de requête (±2 jours + extension agenda) -----

  // « Charger plus » : extension locale (14 j par clic), réinitialisée quand la
  // plage useCalendar change — ajustement d'état PENDANT le rendu (pattern React
  // officiel, sans useEffect).
  const rangeKey = `${range.start.getTime()}:${range.end.getTime()}`
  const [agendaState, setAgendaState] = useState<{ key: string; extra: number }>({
    key: rangeKey,
    extra: 0,
  })
  if (agendaState.key !== rangeKey) setAgendaState({ key: rangeKey, extra: 0 })
  const agendaExtra = agendaState.key === rangeKey ? agendaState.extra : 0

  const queryRange = useMemo(() => {
    const start = new Date(range.start.getTime() - FETCH_PAD_MS)
    const extraMs = viewMode === "agenda" ? agendaExtra * AGENDA_PAGE_DAYS * DAY_MS : 0
    return { start, end: new Date(range.end.getTime() + FETCH_PAD_MS + extraMs) }
  }, [range, viewMode, agendaExtra])

  const { data, isLoading, isError, refetch } = useEventsRange(queryRange.start, queryRange.end)

  // keepPreviousData maison pour « Charger plus » : pendant l'extension, la
  // nouvelle clé n'a pas encore de données → on garde la page précédente
  // (sous-ensemble de la nouvelle plage) au lieu d'un flash de squelettes.
  const lastEventsRef = useRef<EventDto[]>([])
  if (data) lastEventsRef.current = data.events
  const extending = isLoading && agendaExtra > 0 && !data
  const events = data?.events ?? (extending ? lastEventsRef.current : [])

  // ----- Recherche + filtres -----

  const [search, setSearch] = useState("")
  const [sourceFilters, setSourceFilters] = useState<Set<EventSource>>(() => new Set())
  const [allDayOnly, setAllDayOnly] = useState(false)
  const [recurringOnly, setRecurringOnly] = useState(false)
  const filterCount = sourceFilters.size + (allDayOnly ? 1 : 0) + (recurringOnly ? 1 : 0)

  const filtered = useMemo(() => {
    const q = fold(search.trim())
    return events.filter((ev) => {
      if (
        q &&
        !fold(ev.title).includes(q) &&
        !fold(ev.description ?? "").includes(q) &&
        !fold(ev.location ?? "").includes(q)
      ) {
        return false
      }
      if (sourceFilters.size > 0 && !sourceFilters.has(ev.source)) return false
      if (allDayOnly && !ev.allDay) return false
      if (recurringOnly && !(ev.recurrence || ev.isOccurrence)) return false
      return true
    })
  }, [events, search, sourceFilters, allDayOnly, recurringOnly])

  // Regroupement par jour DANS LE FUSEAU AFFICHÉ (dayKey de useTimezone).
  const eventsByDay = useMemo(() => {
    const map = new Map<string, EventDto[]>()
    for (const ev of filtered) {
      const key = dayKey(new Date(ev.startTime))
      const list = map.get(key)
      if (list) list.push(ev)
      else map.set(key, [ev])
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.startTime.localeCompare(b.startTime) || a.endTime.localeCompare(b.endTime))
    }
    return map
  }, [filtered, dayKey])

  // Jours affichés : dates MURALES dans le fuseau d'affichage (cf. tête de fichier).
  const wallDays = useMemo(() => {
    const wallCursor = toWall(cursor)
    const midnight = wallMidnight(wallCursor)
    if (viewMode === "month") {
      const y = wallCursor.getUTCFullYear()
      const mIdx = wallCursor.getUTCMonth()
      const first = Date.UTC(y, mIdx, 1)
      const gridStart = first - wallWeekday(first) * DAY_MS
      return Array.from({ length: 42 }, (_, i) => new Date(gridStart + i * DAY_MS))
    }
    if (viewMode === "week") {
      const monday = midnight - wallWeekday(midnight) * DAY_MS
      return Array.from({ length: 7 }, (_, i) => new Date(monday + i * DAY_MS))
    }
    if (viewMode === "day") return [new Date(midnight)]
    const count = AGENDA_PAGE_DAYS * (1 + agendaExtra)
    return Array.from({ length: count }, (_, i) => new Date(midnight + i * DAY_MS))
  }, [viewMode, cursor, toWall, agendaExtra])

  const monthKey = useMemo(() => wallKey(toWall(cursor)).slice(0, 7), [cursor, toWall])

  const title = useMemo(() => {
    if (viewMode === "month") return fmt(cursor, "MMMM yyyy")
    if (viewMode === "week") {
      const a = wallDays[0]
      const b = wallDays[6]
      return wallKey(a).slice(0, 7) === wallKey(b).slice(0, 7)
        ? `${formatWall(a, "d")} – ${formatWall(b, "d MMMM yyyy")}`
        : `${formatWall(a, "d MMMM")} – ${formatWall(b, "d MMMM yyyy")}`
    }
    if (viewMode === "day") return fmt(cursor, "EEEE d MMMM yyyy")
    return `${formatWall(wallDays[0], "d")} – ${formatWall(wallDays[wallDays.length - 1], "d MMMM")}`
  }, [viewMode, cursor, fmt, wallDays])

  // ----- Dialog création / édition -----

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<EventDto | null>(null)
  const [dialogDate, setDialogDate] = useState<Date | undefined>(undefined)

  // Intention globale « nouvel événement » (palette Ctrl+K / raccourci Ctrl+N) :
  // abonnement au store d'intentions (rattrape aussi les intentions émises
  // pendant le chargement différé de la vue — cf. lib/ui-intent).
  useNewIntent("event", () => {
    setEditing(null)
    setDialogDate(undefined)
    setDialogOpen(true)
  })

  const openCreate = useCallback(
    (instant: Date) => {
      setEditing(null)
      setDialogDate(instant)
      setDialogOpen(true)
    },
    []
  )

  const openEdit = useCallback((event: EventDto) => {
    setEditing(event)
    setDialogDate(undefined)
    setDialogOpen(true)
  }, [])

  const handleDialogOpenChange = useCallback((open: boolean) => {
    setDialogOpen(open)
    if (!open) {
      setEditing(null)
      setDialogDate(undefined)
    }
  }, [])

  const defaultInstantAt = useCallback(
    (wallDay: Date, minutes: number) =>
      wallToUtcDate(new Date(wallMidnight(wallDay) + minutes * 60_000)),
    [wallToUtcDate]
  )

  /** Création depuis un jour (mois) : aujourd'hui → heure courante, sinon 09:00 murale. */
  const openCreateForDay = useCallback(
    (wallDay: Date) => {
      const w = toWall(new Date())
      const minutes =
        wallKey(w) === wallKey(wallDay)
          ? // Heure courante (arrondie 30 min) — minutes depuis MINUIT, la
            // journée étant libre jusqu'à 23:30 en dehors de la grille.
            clampNumber(Math.ceil(wallMinutes(w) / 30) * 30, 0, 23 * 60 + 30)
          : 9 * 60
      openCreate(defaultInstantAt(wallDay, minutes))
    },
    [openCreate, toWall, defaultInstantAt]
  )

  /** Création depuis un créneau cliqué (semaine/jour) — avec garde anti post-drag. */
  const handleCreateAt = useCallback(
    (wallDay: Date, minutes: number) => {
      if (suppressClickRef.current) return
      openCreate(defaultInstantAt(wallDay, minutes))
    },
    [openCreate, defaultInstantAt]
  )

  const viewDay = useCallback(
    (wallDay: Date) => {
      // Midi mural ≈ le bon jour quel que soit le fuseau.
      setCursor(wallToUtcDate(new Date(wallMidnight(wallDay) + 12 * 3_600_000)))
      setMode("day")
    },
    [setCursor, setMode, wallToUtcDate]
  )

  // ----- Import / export iCal -----

  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleImportChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = "" // permet de re-choisir le même fichier
      if (!file) return
      try {
        const res = await importMutation.mutateAsync(file)
        if (res.imported > 0) {
          toast.success(
            `${res.imported} événement${res.imported > 1 ? "s" : ""} importé${res.imported > 1 ? "s" : ""}, ${res.skipped} ignoré${res.skipped > 1 ? "s" : ""}`,
            {
              description:
                res.warnings.length > 0 ? res.warnings.slice(0, 3).join(" · ") : undefined,
            }
          )
        } else {
          toast.info("Aucun nouvel événement importé", {
            description: `${res.skipped} ignoré${res.skipped > 1 ? "s" : ""} (doublons ou entrées invalides)${res.warnings.length > 0 ? ` · ${res.warnings.slice(0, 2).join(" · ")}` : ""}`,
          })
        }
      } catch (err) {
        toast.error("Import impossible", { description: errMessage(err) })
      }
    },
    [importMutation]
  )

  const handleExport = useCallback(async () => {
    try {
      const filename = await exportEvents({ start: range.start, end: range.end })
      toast.success("Calendrier exporté (iCal)", { description: filename })
    } catch (err) {
      toast.error("Export impossible", { description: errMessage(err) })
    }
  }, [range])

  // ----- Mutations drag & drop / resize (optimistes) -----

  const [activeDrag, setActiveDrag] = useState<{ event: EventDto; width: number | null } | null>(
    null
  )
  /** Vrai juste après un drop : le clic généré par le pointerup est ignoré. */
  const suppressClickRef = useRef(false)
  const suppressClickOnce = useCallback(() => {
    suppressClickRef.current = true
    window.setTimeout(() => {
      suppressClickRef.current = false
    }, 0)
  }, [])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: DRAG_CLICK_THRESHOLD } })
  )

  /** Patch optimiste de TOUS les caches ["events"] (plage courante + notifications). */
  const patchEventsCaches = useCallback(
    (eventKey: string, patch: Partial<EventDto>) => {
      qc.setQueriesData<{ events: EventDto[] }>({ queryKey: ["events"] }, (old) =>
        old
          ? {
              events: old.events.map((ev) => (eventKeyOf(ev) === eventKey ? { ...ev, ...patch } : ev)),
            }
          : old
      )
    },
    [qc]
  )

  const mutateEventTime = useCallback(
    async (ev: EventDto, input: Partial<EventInput>, okLabel: string, okDescription?: string) => {
      const eventKey = eventKeyOf(ev)
      patchEventsCaches(eventKey, {
        ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
        ...(input.endTime !== undefined ? { endTime: input.endTime } : {}),
        ...(input.allDay !== undefined ? { allDay: input.allDay } : {}),
      })
      try {
        await update.mutateAsync({
          id: ev.id,
          input,
          // occurrence → détachement de la série (contrat scope "single", 12-a).
          ...(ev.isOccurrence ? { scope: "single" as const } : {}),
          ...(ev.occurrenceStart ? { occurrenceStart: ev.occurrenceStart } : {}),
        })
        toast.success(okLabel, { description: okDescription })
      } catch (err) {
        // Rollback : retour à la vérité serveur (pattern tasks-view).
        void qc.invalidateQueries({ queryKey: ["events"] })
        toast.error("Modification impossible", { description: errMessage(err) })
      }
    },
    [patchEventsCaches, qc, update]
  )

  /** Déplace un événement sur un créneau (snap 15 min) ou en journée entière. */
  const commitMove = useCallback(
    (
      ev: EventDto,
      target: { wallKey: string; kind: "time" | "allday"; minutes: number }
    ) => {
      const durMs = Math.max(15 * 60_000, Date.parse(ev.endTime) - Date.parse(ev.startTime))
      const [y, m, d] = target.wallKey.split("-").map(Number)
      const startWallMs = Date.UTC(y, m - 1, d)
      let input: Partial<EventInput>
      let description: string
      if (target.kind === "allday") {
        // Journée entière : minuits muraux, durée en jours (min 1).
        const durDays = ev.allDay ? Math.max(1, Math.ceil(durMs / DAY_MS)) : 1
        input = {
          allDay: true,
          startTime: wallToUtcDate(new Date(startWallMs)).toISOString(),
          endTime: wallToUtcDate(new Date(startWallMs + durDays * DAY_MS)).toISOString(),
        }
        description = `${ev.title} · ${formatWall(new Date(startWallMs), "EEEE d MMMM")} (journée entière)`
      } else {
        // target.minutes = minutes depuis MINUIT (fuseau d'affichage) —
        // borné à la grille visible 07:00 → 22:45 (snap 15 min).
        const minutes = clampNumber(
          snapMinutes(target.minutes),
          HOUR_START * 60,
          HOUR_START * 60 + GRID_MINUTES - 15
        )
        const startMs = startWallMs + minutes * 60_000
        const durMin = ev.allDay ? 60 : Math.round(durMs / 60_000)
        input = {
          ...(ev.allDay ? { allDay: false } : {}),
          startTime: wallToUtcDate(new Date(startMs)).toISOString(),
          endTime: wallToUtcDate(new Date(startMs + durMin * 60_000)).toISOString(),
        }
        description = `${ev.title} · ${formatWall(new Date(startMs), "EEE d MMMM 'à' HH:mm")}`
      }
      if (
        input.startTime === ev.startTime &&
        input.endTime === ev.endTime &&
        (input.allDay ?? ev.allDay) === ev.allDay
      ) {
        return // déjà exactement là
      }
      void mutateEventTime(ev, input, "Événement déplacé", description)
    },
    [mutateEventTime, wallToUtcDate]
  )

  const commitResize = useCallback(
    (ev: EventDto, durationMin: number) => {
      const startMs = Date.parse(ev.startTime)
      const endIso = new Date(startMs + durationMin * 60_000).toISOString()
      if (endIso === ev.endTime) return
      void mutateEventTime(ev, { startTime: ev.startTime, endTime: endIso }, "Durée mise à jour", `${ev.title} · ${durationMin} min`)
    },
    [mutateEventTime]
  )

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const ev = events.find((e) => eventKeyOf(e) === String(event.active.id)) ?? null
      setActiveDrag(
        ev ? { event: ev, width: event.active.rect.current.initial?.width ?? null } : null
      )
    },
    [events]
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveDrag(null)
      suppressClickOnce()
      const { active, over } = event
      if (!over) return
      const ev = (active.data.current as { event?: EventDto } | undefined)?.event
      const overData = over.data.current as
        | { wallKey?: string; kind?: "time" | "allday" }
        | undefined
      if (!ev || !overData?.wallKey) return

      if (overData.kind === "allday") {
        commitMove(ev, { wallKey: overData.wallKey, kind: "allday", minutes: 0 })
        return
      }
      // Créneau cible : centre de la CARTE déposée dans le rect de la colonne
      // (dnd-kit expose les deux rects en coordonnées viewport). Minutes depuis
      // MINUIT = 07:00 (haut de colonne) + position dans la grille.
      const translated = active.rect.current.translated
      const rect = over.rect
      const fallback = wallMinutes(toWall(new Date(ev.startTime)))
      const minutes =
        translated && rect
          ? HOUR_START * 60 + ((translated.top + translated.height / 2 - rect.top) / ROW_HEIGHT) * 60
          : fallback
      commitMove(ev, { wallKey: overData.wallKey, kind: "time", minutes })
    },
    [commitMove, suppressClickOnce, toWall]
  )

  const handleDragCancel = useCallback(() => {
    setActiveDrag(null)
    suppressClickOnce()
  }, [suppressClickOnce])

  const titleOfDraggable = useCallback(
    (id: string | number): string =>
      events.find((ev) => eventKeyOf(ev) === String(id))?.title ?? "l'événement",
    [events]
  )

  const overLabel = useCallback((over: { data?: { current?: unknown } }): string => {
    const data = over.data?.current as { wallKey?: string; kind?: string } | undefined
    if (!data?.wallKey) return "cette zone"
    const [y, m, d] = data.wallKey.split("-").map(Number)
    const dateLabel = formatWall(new Date(Date.UTC(y, m - 1, d)), "EEEE d MMMM")
    return data.kind === "allday" ? `journée entière du ${dateLabel}` : `créneau du ${dateLabel}`
  }, [])

  // ----- Handlers UI -----

  const handleModeChange = useCallback(
    (value: string) => {
      if (value === "month" || value === "week" || value === "day" || value === "agenda") {
        setMode(value)
      }
    },
    [setMode]
  )

  const toggleSource = useCallback((src: EventSource, checked: boolean) => {
    setSourceFilters((prev) => {
      const next = new Set(prev)
      if (checked) next.add(src)
      else next.delete(src)
      return next
    })
  }, [])

  const resetFilters = useCallback(() => {
    setSourceFilters(new Set())
    setAllDayOnly(false)
    setRecurringOnly(false)
  }, [])

  const clearSearchAndFilters = useCallback(() => {
    setSearch("")
    resetFilters()
  }, [resetFilters])

  const handleLoadMore = useCallback(() => {
    setAgendaState((s) => (s.key === rangeKey ? { ...s, extra: s.extra + 1 } : s))
  }, [rangeKey])

  // ----- Rendu -----

  const prevLabel =
    viewMode === "month"
      ? "Mois précédent"
      : viewMode === "week"
        ? "Semaine précédente"
        : viewMode === "day"
          ? "Jour précédent"
          : "Période précédente"
  const nextLabel =
    viewMode === "month"
      ? "Mois suivant"
      : viewMode === "week"
        ? "Semaine suivante"
        : viewMode === "day"
          ? "Jour suivant"
          : "Période suivante"

  const noResult =
    !isLoading && !isError && filtered.length === 0 && (search.trim() !== "" || filterCount > 0)
  const zeroDiscreet =
    !isLoading &&
    !isError &&
    events.length === 0 &&
    search.trim() === "" &&
    filterCount === 0 &&
    viewMode !== "agenda"
  const agendaEmpty =
    viewMode === "agenda" && !isLoading && !isError && events.length === 0 && filterCount === 0

  const bodyContent =
    isLoading && !extending ? (
      <CalendarSkeleton mode={viewMode} />
    ) : isError ? (
      <Card className="flex-row items-center justify-center gap-3 py-12 text-center">
        <p className="px-6 text-sm text-muted-foreground">Impossible de charger le calendrier.</p>
        <Button variant="outline" className="h-11" onClick={() => void refetch()}>
          Réessayer
        </Button>
      </Card>
    ) : (
      <>
        {noResult && (
          <div
            role="status"
            className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-border/60 px-4 py-2.5 text-sm text-muted-foreground"
          >
            <span>
              {search.trim()
                ? `Aucun résultat pour « ${search.trim()} »`
                : "Aucun événement ne correspond aux filtres actifs"}
            </span>
            <Button variant="ghost" size="sm" className="h-9 cursor-pointer gap-1" onClick={clearSearchAndFilters}>
              <X className="size-3.5" aria-hidden="true" />
              Effacer
            </Button>
          </div>
        )}
        {zeroDiscreet && (
          <p className="rounded-lg border border-dashed border-border/60 px-4 py-2 text-sm text-muted-foreground">
            Aucun événement sur cette période.
          </p>
        )}

        {agendaEmpty ? (
          <Card className="flex flex-col items-center gap-3 py-14 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
              <CalendarDays className="size-6 text-primary" aria-hidden="true" />
            </div>
            <p className="max-w-sm px-6 text-sm text-muted-foreground">
              Aucun événement sur cette période. Votre calendrier Orbit attend son prochain
              rendez-vous.
            </p>
            <Button
              variant="accent"
              className="h-11"
              onClick={() => openCreateForDay(wallDays[0] ?? toWall(cursor))}
            >
              <Plus className="size-4" aria-hidden="true" />
              Nouvel événement
            </Button>
          </Card>
        ) : (
          <Card className="gap-0 overflow-hidden py-0">
            {viewMode === "month" ? (
              <MonthGrid
                days={wallDays}
                monthKey={monthKey}
                eventsByDay={eventsByDay}
                nowInfo={nowInfo}
                fmt={fmt}
                displayTz={displayTz}
                isMobile={isMobile}
                onCreateForDay={openCreateForDay}
                onOpen={openEdit}
                onViewDay={viewDay}
              />
            ) : viewMode === "agenda" ? (
              <AgendaView
                days={wallDays}
                eventsByDay={eventsByDay}
                nowInfo={nowInfo}
                fmt={fmt}
                onOpen={openEdit}
                canLoadMore={agendaExtra < AGENDA_MAX_EXTRA}
                onLoadMore={handleLoadMore}
                loadingMore={extending}
              />
            ) : (
              <TimeGridView
                days={wallDays}
                eventsByDay={eventsByDay}
                variant={viewMode}
                fmt={fmt}
                displayTz={displayTz}
                toWall={toWall}
                nowInfo={nowInfo}
                onCreateAt={handleCreateAt}
                onOpen={openEdit}
                onResize={commitResize}
                onViewDay={viewDay}
              />
            )}
          </Card>
        )}
      </>
    )

  return (
    <section aria-label="Calendrier" className="flex flex-col gap-4">
      {/* Annonces polites (lecteur d'écran) */}
      <p className="sr-only" aria-live="polite">
        {isLoading
          ? "Chargement du calendrier…"
          : isError
            ? "Erreur de chargement du calendrier"
            : `${events.length} événement${events.length > 1 ? "s" : ""} chargé${events.length > 1 ? "s" : ""} sur la période affichée`}
      </p>

      {/* ---------- Barre d'outils ---------- */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="w-full min-w-0 truncate text-base font-medium lowercase tracking-tight text-foreground/90 sm:w-auto sm:max-w-64 sm:text-lg lg:max-w-none">
          {title}
        </h2>
        <nav className="flex items-center gap-1.5" aria-label="Navigation dans le calendrier">
          <Button
            variant="outline"
            size="icon"
            className="size-11 cursor-pointer"
            onClick={prev}
            aria-label={prevLabel}
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="size-11 cursor-pointer"
            onClick={next}
            aria-label={nextLabel}
          >
            <ChevronRight className="size-4" aria-hidden="true" />
          </Button>
          <Button variant="ghost" className="h-11 cursor-pointer px-4" onClick={goToday}>
            Aujourd&apos;hui
          </Button>
        </nav>

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <ToggleGroup
            type="single"
            variant="outline"
            value={viewMode}
            onValueChange={handleModeChange}
            aria-label="Mode d'affichage du calendrier"
          >
            <ToggleGroupItem value="month" className="h-11 cursor-pointer px-2.5 sm:px-3">
              Mois
            </ToggleGroupItem>
            <ToggleGroupItem value="week" className="h-11 cursor-pointer px-2.5 sm:px-3">
              Semaine
            </ToggleGroupItem>
            <ToggleGroupItem value="day" className="h-11 cursor-pointer px-2.5 sm:px-3">
              Jour
            </ToggleGroupItem>
            <ToggleGroupItem value="agenda" className="h-11 cursor-pointer px-2.5 sm:px-3">
              Agenda
            </ToggleGroupItem>
          </ToggleGroup>

          <Tooltip>
            <TooltipTrigger asChild>
              <div className="w-40 sm:w-52">
                <TimezoneSelector value={displayTz} onChange={setTimezone} />
              </div>
            </TooltipTrigger>
            <TooltipContent>Fuseau d&apos;affichage — les événements sont stockés en UTC.</TooltipContent>
          </Tooltip>
          <span className="sr-only">Fuseau</span>
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:flex-1">
          <div className="relative min-w-0 flex-1 sm:max-w-xs">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher un événement…"
              className="h-11 pl-9"
              aria-label="Rechercher un événement par titre, description ou lieu"
            />
          </div>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="h-11 cursor-pointer gap-2">
                <Filter className="size-4" aria-hidden="true" />
                <span className="hidden sm:inline">Filtres</span>
                {filterCount > 0 && (
                  <Badge variant="secondary" className="px-1.5 tabular-nums">
                    {filterCount}
                  </Badge>
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-64">
              <div className="space-y-1">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                  Source
                </p>
                {SOURCE_FILTERS.map(({ value, label }) => (
                  <label
                    key={value}
                    className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md px-1 py-1 text-sm transition-colors hover:bg-accent/40"
                  >
                    <Checkbox
                      checked={sourceFilters.has(value)}
                      onCheckedChange={(c) => toggleSource(value, c === true)}
                      aria-label={`Filtrer par source : ${label}`}
                    />
                    {label}
                  </label>
                ))}
                <div className="mt-2 border-t border-border/60 pt-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                    Affichage
                  </p>
                  <label className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md px-1 py-1 text-sm transition-colors hover:bg-accent/40">
                    <Checkbox
                      checked={allDayOnly}
                      onCheckedChange={(c) => setAllDayOnly(c === true)}
                      aria-label="Afficher uniquement les événements journée entière"
                    />
                    Toute la journée
                  </label>
                  <label className="flex min-h-11 cursor-pointer items-center gap-2.5 rounded-md px-1 py-1 text-sm transition-colors hover:bg-accent/40">
                    <Checkbox
                      checked={recurringOnly}
                      onCheckedChange={(c) => setRecurringOnly(c === true)}
                      aria-label="Afficher uniquement les événements récurrents"
                    />
                    Récurrents
                  </label>
                </div>
                <div className="pt-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-9 w-full cursor-pointer"
                    onClick={resetFilters}
                    disabled={filterCount === 0}
                  >
                    Réinitialiser
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>

          <div className="flex items-center gap-1.5">
            <input
              ref={fileInputRef}
              type="file"
              accept=".ics,text/calendar"
              className="hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(e) => void handleImportChange(e)}
            />
            <Button
              variant="outline"
              size="icon"
              className="size-11 cursor-pointer"
              onClick={() => fileInputRef.current?.click()}
              disabled={importMutation.isPending}
              aria-label="Importer un fichier iCal (.ics)"
              title="Importer un fichier iCal (.ics)"
            >
              <Upload className="size-4" aria-hidden="true" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="size-11 cursor-pointer"
              onClick={() => void handleExport()}
              aria-label="Exporter la période affichée en iCal"
              title="Exporter la période affichée en iCal"
            >
              <Download className="size-4" aria-hidden="true" />
            </Button>
            <Button
              variant="accent"
              className="h-11 cursor-pointer"
              onClick={() => openCreateForDay(toWall(cursor))}
            >
              <Plus className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">Nouvel événement</span>
            </Button>
          </div>
        </div>
      </header>

      {/* ---------- Corps (DnD actif en vues Semaine / Jour) ---------- */}
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
        accessibility={{
          announcements: {
            onDragStart: ({ active }) =>
              `Événement saisi : ${titleOfDraggable(active.id)}. Déplacez-le puis déposez-le sur un créneau.`,
            onDragOver: ({ over }) => (over ? `Survol : ${overLabel(over)}.` : ""),
            onDragEnd: ({ over }) =>
              over ? `Événement déposé sur ${overLabel(over)}.` : "Déplacement annulé.",
            onDragCancel: () => "Déplacement annulé.",
          },
        }}
      >
        {bodyContent}
        <DragOverlay>
          {activeDrag ? (
            <div
              className="w-44 rotate-2 cursor-grabbing rounded-md border border-border bg-card p-2 opacity-90 shadow-xl"
              style={{ width: activeDrag.width ?? 176 }}
            >
              <p className="truncate text-xs font-semibold">{activeDrag.event.title}</p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">
                {activeDrag.event.allDay
                  ? "Journée entière"
                  : fmt(new Date(activeDrag.event.startTime), "HH:mm")}
              </p>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      <EventDialog
        open={dialogOpen}
        onOpenChange={handleDialogOpenChange}
        event={editing}
        defaultDate={dialogDate}
        defaultTimezone={displayTz}
      />
    </section>
  )
}

