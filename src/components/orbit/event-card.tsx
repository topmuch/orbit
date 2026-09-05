"use client"

// Orbit — Carte d'événement horizontale (composant partagé)
// ─────────────────────────────────────────────────────────────────────────────
// API : <EventCard event onClick? compact? muted? className? fmt? />
// Utilisée par la vue Agenda du calendrier et disponible pour le dashboard.
// Couleur : barre 3px = event.color (hex) sinon couleur sémantique par source.
// Les heures sont formatées dans le fuseau d'affichage (RÈGLE D'OR : jamais de
// format date-fns direct sur un instant UTC). DEUX sources possibles :
// • prop `fmt` — fournie par le parent qui possède le fuseau d'affichage
//   (CalendarView via son TimezoneSelector) → propagée à toutes les cartes ;
// • fallback useTimezone() local (fuseau du navigateur) — utilisé quand le
//   parent n'a pas de sélecteur de fuseau (dashboard, notifications).
//   La prop est nécessaire car useTimezone est un état PAR INSTANCE (hook local
//   12-b non partageable sans contexte) : sans elle, l'Agenda afficherait les
//   heures dans le fuseau du navigateur même après un changement de fuseau.

import { CalendarDays, Mail, MapPin, Repeat, Sparkles, Upload, Users } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { useTimezone } from "@/hooks/useTimezone"
import type { CSSProperties } from "react"
import type { EventDto, EventSource } from "@/lib/types"
import { cn } from "@/lib/utils"

// ---------- Métadonnées par source (partagées avec calendar-view) ----------

export type SourceMeta = {
  /** Label FR court. */
  label: string
  /** Pastille / barre de couleur (chips, cartes, puces mobiles). */
  chip: string
  /** Pastille ronde mobile. */
  dot: string
  /** Badge outline (vue Jour / carte). */
  badge: string
}

/** Couleurs par source : manuel = primaire, email = émeraude, IA = violet, import = sarcelle. */
export const SOURCE_META: Record<EventSource, SourceMeta> = {
  manual: {
    label: "Manuel",
    chip: "border-l-primary bg-primary/15 text-primary hover:bg-primary/25",
    dot: "bg-primary",
    badge: "border-primary/40 bg-primary/10 text-primary",
  },
  email_extract: {
    label: "Email",
    chip: "border-l-emerald-500 bg-emerald-500/15 text-emerald-600 hover:bg-emerald-500/25 dark:text-emerald-400",
    dot: "bg-emerald-500",
    badge: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  ai: {
    label: "IA",
    chip: "border-l-violet-500 bg-violet-500/15 text-violet-600 hover:bg-violet-500/25 dark:text-violet-400",
    dot: "bg-violet-500",
    badge: "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  },
  import: {
    label: "Import",
    chip: "border-l-teal-500 bg-teal-500/15 text-teal-600 hover:bg-teal-500/25 dark:text-teal-400",
    dot: "bg-teal-500",
    badge: "border-teal-500/40 bg-teal-500/10 text-teal-600 dark:text-teal-400",
  },
}

/** Icône fine par source (badges). */
export const SOURCE_ICON: Record<EventSource, React.ElementType | null> = {
  manual: null,
  email_extract: Mail,
  ai: Sparkles,
  import: Upload,
}

/** Clé React unique d'un événement (occurrences = id master + instant de début). */
export function eventKeyOf(event: EventDto): string {
  return `${event.id}:${event.startTime}`
}

/**
 * Style de puce/carte : couleur personnalisée (hex) en style inline, sinon
 * classes sémantiques par source. Retourne className de base + style optionnel.
 */
export function eventChipStyle(event: EventDto): {
  className: string
  style?: CSSProperties
} {
  if (event.color) {
    return {
      className: "border-l-[3px] bg-transparent hover:brightness-110",
      style: {
        borderLeftColor: event.color,
        backgroundColor: `${event.color}26`,
      },
    }
  }
  return { className: SOURCE_META[event.source].chip }
}

// ---------- Carte ----------

export function EventCard({
  event,
  onClick,
  compact = false,
  muted = false,
  className,
  fmt: fmtProp,
}: {
  event: EventDto
  /** Clic sur la carte (édition). */
  onClick?: (event: EventDto) => void
  /** Version compacte : une seule ligne, sans description. */
  compact?: boolean
  /** Événement passé → atténué (titre barré). */
  muted?: boolean
  className?: string
  /** Formateur du fuseau d'affichage du parent (sinon fuseau navigateur). */
  fmt?: (d: Date, p: string) => string
}) {
  const { fmt: ownFmt } = useTimezone()
  const fmt = fmtProp ?? ownFmt
  const start = new Date(event.startTime)
  const end = new Date(event.endTime)
  const chip = eventChipStyle(event)
  const recurring = !!(event.recurrence || event.isOccurrence)
  const attendees = event.attendees?.length ?? 0
  const SourceIcon = SOURCE_ICON[event.source]
  const sourceMeta = SOURCE_META[event.source]
  const past = muted && end.getTime() < Date.now()
  // Événement qui se termine un autre jour (dans le fuseau d'affichage) :
  // on l'indique visuellement (2e ligne « → HH:mm ») et dans le libellé (+N j).
  const dayDiff = event.allDay
    ? 0
    : Math.round(
        (new Date(fmt(end, "yyyy-MM-dd")).getTime() -
          new Date(fmt(start, "yyyy-MM-dd")).getTime()) /
          86_400_000,
      )
  const crossMidnight = dayDiff > 0

  return (
    <button
      type="button"
      onClick={() => onClick?.(event)}
      className={cn(
        "group flex w-full items-stretch gap-0 overflow-hidden rounded-lg text-left",
        "cursor-pointer border border-transparent transition-colors",
        "hover:border-border hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:pointer-events-none",
        className,
      )}
      aria-label={`${event.allDay ? "Journée entière" : `${fmt(start, "HH:mm")} – ${fmt(end, "HH:mm")}${crossMidnight ? ` (+${dayDiff} j)` : ""}`} — ${event.title}`}
    >
      {/* Barre de couleur 3px (couleur d'événement ou par source) */}
      <span
        aria-hidden="true"
        className={cn("w-[3px] shrink-0", !event.color && SOURCE_META[event.source].dot, "rounded-l-lg")}
        style={event.color ? { backgroundColor: event.color } : undefined}
      />

      <span className="flex min-w-0 flex-1 items-center gap-2.5 px-3 py-2">
        {/* Heure (dans le fuseau d'affichage) */}
        <span className="w-14 shrink-0 text-sm font-bold tabular-nums text-foreground/90 sm:w-16">
          {event.allDay ? (
            <CalendarDays className="size-4 text-primary" aria-hidden="true" />
          ) : (
            fmt(start, "HH:mm")
          )}
          {crossMidnight && (
            <span
              className="block text-[10px] font-semibold leading-tight text-muted-foreground/80"
              title={`Se termine le lendemain (${fmt(end, "d MMMM 'à' HH:mm")})`}
            >
              → {fmt(end, "HH:mm")}
            </span>
          )}
          <span className="sr-only">
            {event.allDay
              ? "Journée entière"
              : `de ${fmt(start, "HH:mm")} à ${fmt(end, "HH:mm")}${crossMidnight ? ` le lendemain` : ""}`}
          </span>
        </span>

        {/* Contenu */}
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span
              className={cn(
                "truncate text-sm font-medium",
                past && "text-muted-foreground line-through decoration-muted-foreground/50",
              )}
            >
              {event.title}
            </span>
            {recurring && (
              <Repeat className="size-3 shrink-0 text-muted-foreground/80" aria-label="Événement récurrent" />
            )}
          </span>
          {!compact && event.description && (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">{event.description}</span>
          )}
          {!compact && event.location && (
            <span className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground/80">
              <MapPin className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{event.location}</span>
            </span>
          )}
        </span>

        {/* Badges */}
        <span className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
          {event.allDay && (
            <Badge variant="outline" className="gap-1 px-1.5 text-[10px] font-normal text-muted-foreground">
              <CalendarDays className="size-2.5" aria-hidden="true" />
              Journée entière
            </Badge>
          )}
          {event.source !== "manual" && (
            <Badge variant="outline" className={cn("gap-1 px-1.5 text-[10px] font-normal", sourceMeta.badge)}>
              {SourceIcon && <SourceIcon className="size-2.5" aria-hidden="true" />}
              {sourceMeta.label}
            </Badge>
          )}
          {attendees > 0 && (
            <Badge variant="outline" className="gap-1 px-1.5 text-[10px] font-normal text-muted-foreground">
              <Users className="size-2.5" aria-hidden="true" />
              {attendees}
              <span className="sr-only">participant{attendees > 1 ? "s" : ""}</span>
            </Badge>
          )}
        </span>
      </span>
    </button>
  )
}

