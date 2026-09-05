"use client"

// Orbit — Dialog création/édition/suppression d'événement (formulaire riche)
// ─────────────────────────────────────────────────────────────────────────────
// API : <EventDialog open onOpenChange event defaultDate defaultTimezone
//                     occurrenceStart source />
// Le formulaire vit dans un composant interne (EventForm) remonté par `key` à
// chaque ouverture (contenu Radix démonté à la fermeture) → initialisation
// directe dans useState, AUCUN setState dans useEffect (pattern maison).
//
// RÈGLE D'OR (fuseaux) : les instants sont TOUJOURS UTC en stockage/échange.
// En interne, ce formulaire ne manipule que des CHAÎNES MURALES
// ("yyyy-MM-dd" / "HH:mm") dans le fuseau de référence de l'événement :
//   chargement : instant UTC → utcToWall() → getUTC*() → chaînes ;
//   submit     : chaînes → Date.UTC() (murale) → wallToUtc() → toISOString().
// Jamais de new Date("yyyy-MM-dd") (dérive tz), jamais de format(date-fns)
// sur un instant UTC sans passage par wallToFormatable().
//
// CONVENTION defaultDate : la Date est un INSTANT (JS Date = point sur la
// ligne de temps UTC). On affiche sa conversion murale dans le fuseau
// sélectionné via utcToWall(defaultDate, tz) — l'appelant (12-c) enverra des
// instants corrects ; le navigateur est cohérent par défaut.

import { useMemo, useState } from "react"
import { addDays, format, isSameDay } from "date-fns"
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
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Bell,
  CalendarDays,
  ChevronDown,
  Loader2,
  MapPin,
  Plus,
  Repeat,
  Trash2,
  Users,
  X,
} from "lucide-react"
import { TimezoneSelector } from "@/components/orbit/timezone-selector"
import { DateTimePicker } from "@/components/orbit/datetime-picker"
import { ColorPicker } from "@/components/orbit/color-picker"
import { useEventMutations, type EventInput } from "@/lib/api-client"
import { useTimezone } from "@/hooks/useTimezone"
import { eventCreateSchema, eventUpdateSchema } from "@/lib/validators"
import { isValidTimezone, utcToWall, wallToFormatable, wallToUtc } from "@/lib/timezone"
import type {
  EventAttendee,
  EventDto,
  EventReminder,
  EventSource,
  RecurrenceRule,
} from "@/lib/types"
import { cn } from "@/lib/utils"

// ---------- Constantes & helpers muraux ----------

const DAY_MS = 86_400_000

/** Initiales des jours (0 = lundi … 6 = dimanche). */
const DAY_LABELS = ["L", "M", "M", "J", "V", "S", "D"]
const DAY_NAMES = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]

const NTH_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "1er" },
  { value: 2, label: "2e" },
  { value: 3, label: "3e" },
  { value: 4, label: "4e" },
  { value: -1, label: "dernier" },
]

const SOURCE_LABELS: Record<EventSource, string> = {
  manual: "Manuel",
  email_extract: "Extrait d'un email",
  ai: "Créé par l'IA",
  import: "Importé",
}

const ATTENDEE_STATUS: Record<EventAttendee["status"], { label: string; className: string }> = {
  pending: { label: "en attente", className: "border-border bg-muted/50 text-muted-foreground" },
  accepted: { label: "accepté", className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" },
  declined: { label: "refusé", className: "border-destructive/40 bg-destructive/10 text-destructive" },
}

const STATUS_CYCLE: Record<EventAttendee["status"], EventAttendee["status"]> = {
  pending: "accepted",
  accepted: "declined",
  declined: "pending",
}

/** Erreurs zod → emplacements d'erreur du formulaire (premier message en repli). */
const ZOD_FIELD_MAP: Record<string, keyof FormErrors> = {
  title: "title",
  startTime: "start",
  endTime: "end",
  timezone: "timezone",
  "recurrence.interval": "interval",
  "recurrence.count": "count",
  "recurrence.until": "until",
  "recurrence.byDays": "byDays",
}

function zodIssuesToFormErrors(
  issues: { path: string[]; message: string }[]
): FormErrors {
  const errs: FormErrors = {}
  for (const issue of issues) {
    const key = ZOD_FIELD_MAP[issue.path.join(".")]
    if (key && !errs[key]) errs[key] = issue.message
    else if (!errs.form) errs.form = issue.message
  }
  return errs
}

/** Rappel en édition : valeur + unité saisie (minutes converties au submit). */
type ReminderUnit = "minutes" | "hours" | "days"
type ReminderRow = { value: number; unit: ReminderUnit; type: EventReminder["type"] }

const UNIT_FACTORS: Record<ReminderUnit, number> = { minutes: 1, hours: 60, days: 1440 }

function reminderToRow(r: EventReminder): ReminderRow {
  if (r.minutes >= 1440 && r.minutes % 1440 === 0)
    return { value: r.minutes / 1440, unit: "days", type: r.type }
  if (r.minutes >= 60 && r.minutes % 60 === 0)
    return { value: r.minutes / 60, unit: "hours", type: r.type }
  return { value: r.minutes, unit: "minutes", type: r.type }
}

const rowToMinutes = (r: ReminderRow): number =>
  Math.max(0, Math.round(r.value) * UNIT_FACTORS[r.unit])

const QUICK_REMINDERS: { label: string; minutes: number }[] = [
  { label: "5 min", minutes: 5 },
  { label: "15 min", minutes: 15 },
  { label: "1 h", minutes: 60 },
  { label: "1 jour", minutes: 1440 },
]

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const pad2 = (n: number) => String(n).padStart(2, "0")

/** Date murale → "yyyy-MM-dd" (lecture des champs UTC de la Date murale). */
function wallDateStr(w: Date): string {
  return `${w.getUTCFullYear()}-${pad2(w.getUTCMonth() + 1)}-${pad2(w.getUTCDate())}`
}

/** Date murale → "HH:mm". */
function wallTimeStr(w: Date): string {
  return `${pad2(w.getUTCHours())}:${pad2(w.getUTCMinutes())}`
}

/** Chaînes murales → Date murale (champs UTC), null si invalide (31/02…). */
function parseWall(dateStr: string, timeStr: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr ?? "")
  const t = /^(\d{2}):(\d{2})$/.exec(timeStr ?? "")
  if (!m || !t) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const [h, mi] = [Number(t[1]), Number(t[2])]
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi))
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null
  return dt
}

/** Jour de semaine (0 = lundi) d'une chaîne murale "yyyy-MM-dd". */
function weekdayOf(dateStr: string): number | null {
  const d = parseWall(dateStr, "00:00")
  return d ? (d.getUTCDay() + 6) % 7 : null
}

function addHour(time: string): string {
  const [h, m] = time.split(":").map(Number)
  return `${pad2((h + 1) % 24)}:${pad2(m)}`
}

/** Horodatage UTC lisible d'un instant ("2026-09-07 10:00") — champs UTC purs. */
function formatUtcStamp(instant: Date): string {
  return `${instant.getUTCFullYear()}-${pad2(instant.getUTCMonth() + 1)}-${pad2(
    instant.getUTCDate()
  )} ${pad2(instant.getUTCHours())}:${pad2(instant.getUTCMinutes())}`
}

/** Résumé humain d'une règle de récurrence (toast de succès). */
function recurrenceShortLabel(rule: RecurrenceRule): string {
  const unit = rule.frequency === "daily" ? "jour" : rule.frequency === "weekly" ? "semaine" : "mois"
  return rule.interval > 1 ? `tous les ${rule.interval} ${unit}s` : `chaque ${unit}`
}

/** Résumé humain détaillé de la récurrence (édition en direct). */
function buildRecurrenceSummary(args: {
  freq: "none" | "daily" | "weekly" | "monthly"
  interval: number
  byDays: number[]
  monthlyMode: "dom" | "nth"
  nth: number
  nthDay: number
  endMode: "never" | "count" | "until"
  count: number
  untilDate: string
  startDate: string
}): string {
  const { freq, interval, byDays, monthlyMode, nth, nthDay, endMode, count, untilDate, startDate } =
    args
  if (freq === "none") return ""
  const parts: string[] = []
  if (freq === "daily") {
    parts.push(interval > 1 ? `Tous les ${interval} jours` : "Tous les jours")
  } else if (freq === "weekly") {
    const fallbackDay = weekdayOf(startDate)
    const days = (byDays.length ? byDays : fallbackDay !== null ? [fallbackDay] : []).map(
      (d) => DAY_NAMES[d] ?? "?"
    )
    const dayStr = days.length === 7 ? "tous les jours" : days.join(", ")
    if (interval > 1) parts.push(`Tous les ${interval} semaines : ${dayStr}`)
    else parts.push(days.length === 1 ? `Chaque ${dayStr}` : `Chaque semaine : ${dayStr}`)
  } else {
    const dom = parseWall(startDate, "00:00")?.getUTCDate() ?? 1
    if (monthlyMode === "nth") {
      const nthLabel = NTH_OPTIONS.find((o) => o.value === nth)?.label ?? `${nth}e`
      const base = `Le ${nthLabel} ${DAY_NAMES[nthDay] ?? "?"}`
      parts.push(interval > 1 ? `${base} tous les ${interval} mois` : `${base} de chaque mois`)
    } else {
      parts.push(interval > 1 ? `Le ${dom} tous les ${interval} mois` : `Le ${dom} de chaque mois`)
    }
  }
  if (endMode === "count") parts.push(`${count} fois`)
  if (endMode === "until" && untilDate)
    parts.push(`jusqu'au ${untilDate.split("-").reverse().join("/")}`)
  return parts.join(", ")
}

/** Description du toast de succès (formatage MURAL dans le fuseau de l'événement). */
function successDescription(ev: EventDto, rule: RecurrenceRule | null): string {
  const tz = ev.timezone || "UTC"
  const s = wallToFormatable(utcToWall(new Date(ev.startTime), tz))
  const e = wallToFormatable(utcToWall(new Date(ev.endTime), tz))
  let when: string
  if (ev.allDay) {
    // La fin est exclusive → dernier jour inclusif = fin − 1.
    const last = addDays(e, -1)
    when = isSameDay(s, last)
      ? `Journée entière du ${format(s, "EEEE d MMMM", { locale: fr })}`
      : `Du ${format(s, "d MMMM", { locale: fr })} au ${format(last, "d MMMM", { locale: fr })}`
  } else {
    when = `${format(s, "EEEE d MMMM", { locale: fr })} · ${format(s, "HH:mm")}–${format(e, "HH:mm")}`
  }
  return `${when} (${tz})${rule ? ` · répété ${recurrenceShortLabel(rule)}` : ""}`
}

/** Toast non bloquant pour les conflits renvoyés par l'API. */
function notifyConflicts(conflicts: EventDto[] | undefined, tz: string): void {
  if (!conflicts?.length) return
  const names = conflicts.slice(0, 3).map((c) => {
    if (c.allDay) return `${c.title} (journée entière)`
    const cs = wallToFormatable(utcToWall(new Date(c.startTime), c.timezone || tz))
    const ce = wallToFormatable(utcToWall(new Date(c.endTime), c.timezone || tz))
    return `${c.title} (${format(cs, "HH:mm")}–${format(ce, "HH:mm")})`
  })
  toast.warning("Créneau en conflit", {
    description: `Chevauche : ${names.join(", ")}${conflicts.length > 3 ? "…" : ""}`,
  })
}

// ---------- Composant public ----------

export function EventDialog({
  open,
  onOpenChange,
  event,
  defaultDate,
  defaultTimezone,
  defaultTitle,
  defaultDescription,
  defaultEnd,
  defaultLocation,
  defaultAttendees,
  occurrenceStart,
  source,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Événement existant (master OU occurrence) → édition ; null/absent → création. */
  event?: EventDto | null
  /** Instant pré-rempli à la création (clic créneau) — cf. convention en tête de fichier. */
  defaultDate?: Date
  /** Fuseau par défaut à la création (sinon fuseau d'affichage utilisateur). */
  defaultTimezone?: string
  /** Titre/description pré-remplis à la création (ex. suggestion d'email — 12-c). */
  defaultTitle?: string
  defaultDescription?: string
  /** Instant de fin pré-rempli à la création (durée de la suggestion). */
  defaultEnd?: Date
  /** Lieu pré-rempli à la création (extraction IA de l'email). */
  defaultLocation?: string
  /** Participants pré-remplis à la création (emails extraits par l'IA). */
  defaultAttendees?: string[]
  /** Début ISO UTC de l'occurrence visée si event est un master (repli sur event.occurrenceStart). */
  occurrenceStart?: string
  /** Source à la création (l'édition lit celle de l'événement). */
  source?: EventSource
}) {
  const formKey = event
    ? `${event.id}:${event.occurrenceStart ?? occurrenceStart ?? ""}`
    : `new:${defaultDate?.toISOString() ?? ""}:${defaultTimezone ?? ""}:${defaultTitle ?? ""}:${defaultLocation ?? ""}:${defaultAttendees?.length ?? 0}`

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 sm:max-w-2xl">
        <EventForm
          key={formKey}
          event={event ?? null}
          defaultDate={defaultDate}
          defaultTimezone={defaultTimezone}
          defaultTitle={defaultTitle}
          defaultDescription={defaultDescription}
          defaultEnd={defaultEnd}
          defaultLocation={defaultLocation}
          defaultAttendees={defaultAttendees}
          occurrenceStart={occurrenceStart}
          source={source}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}

// ---------- Formulaire interne ----------

type Freq = "none" | "daily" | "weekly" | "monthly"
type EndMode = "never" | "count" | "until"
type FormErrors = Partial<
  Record<
    "title" | "start" | "end" | "timezone" | "interval" | "byDays" | "count" | "until" | "form",
    string
  >
>

function EventForm({
  event,
  defaultDate,
  defaultTimezone,
  defaultTitle,
  defaultDescription,
  defaultEnd,
  defaultLocation,
  defaultAttendees,
  occurrenceStart,
  source,
  onDone,
}: {
  event: EventDto | null
  defaultDate?: Date
  defaultTimezone?: string
  defaultTitle?: string
  defaultDescription?: string
  defaultEnd?: Date
  defaultLocation?: string
  defaultAttendees?: string[]
  occurrenceStart?: string
  source?: EventSource
  onDone: () => void
}) {
  const { create, update, remove } = useEventMutations()
  const { timezone: displayTz } = useTimezone()

  const isEdit = !!event
  const effectiveSource: EventSource = event?.source ?? source ?? "manual"
  const occurrenceStartIso = event?.occurrenceStart ?? occurrenceStart ?? null
  // Portée « série » requise si l'on édite une occurrence (ou un master avec
  // occurrenceStart fourni) : choix single/series proposé en tête de formulaire.
  const seriesContext = isEdit && !!(event!.isOccurrence || (event!.recurrence && occurrenceStartIso))

  // -- Fuseau de référence de l'événement ---------------------------------
  const initialTz =
    event?.timezone && isValidTimezone(event.timezone)
      ? event.timezone
      : defaultTimezone && isValidTimezone(defaultTimezone)
        ? defaultTimezone
        : displayTz

  // -- Chaînes murales de départ/arrivée ----------------------------------
  // Chargement : instant UTC → murale via utcToWall, puis champs UTC en chaînes.
  // (defaultDate = INSTANT — voir convention en tête de fichier.)
  const startWall0 = event
    ? utcToWall(new Date(event.startTime), initialTz)
    : utcToWall(defaultDate ?? new Date(), initialTz)
  // Fin : événement existant, ou instant de suggestion (12-c), sinon null (+1 h par défaut).
  const endWall0 = event
    ? utcToWall(new Date(event.endTime), initialTz)
    : defaultEnd
      ? utcToWall(defaultEnd, initialTz)
      : null

  const [title, setTitle] = useState(event?.title ?? defaultTitle ?? "")
  const [allDay, setAllDay] = useState(event?.allDay ?? false)
  const [startDate, setStartDate] = useState(wallDateStr(startWall0))
  const [startTime, setStartTime] = useState(wallTimeStr(startWall0))
  const [endDate, setEndDate] = useState(
    endWall0
      ? // Fin inclusive pour l'affichage all-day (le stockage est exclusif).
        event?.allDay
        ? wallDateStr(new Date(endWall0.getTime() - DAY_MS))
        : wallDateStr(endWall0)
      : wallDateStr(startWall0)
  )
  const [endTime, setEndTime] = useState(
    !event?.allDay && endWall0 ? wallTimeStr(endWall0) : addHour(wallTimeStr(startWall0))
  )
  const [timezone, setTimezone] = useState(initialTz)
  const [location, setLocation] = useState(event?.location ?? defaultLocation ?? "")
  const [description, setDescription] = useState(
    event?.description ?? defaultDescription ?? ""
  )
  const [color, setColor] = useState<string | null>(event?.color ?? null)

  // -- Récurrence ---------------------------------------------------------
  const rule0 = event?.recurrence ?? null
  const [freq, setFreq] = useState<Freq>(rule0?.frequency ?? "none")
  const [interval, setIntervalN] = useState(rule0?.interval ?? 1)
  const [byDays, setByDays] = useState<number[]>(() =>
    rule0?.byDays?.length ? [...new Set(rule0.byDays)].sort((a, b) => a - b) : []
  )
  const [monthlyMode, setMonthlyMode] = useState<"dom" | "nth">(
    rule0?.nth !== undefined && rule0.nth !== null ? "nth" : "dom"
  )
  const [nth, setNth] = useState(rule0?.nth ?? 1)
  const [nthDay, setNthDay] = useState(
    rule0?.byDays?.[0] ?? weekdayOf(wallDateStr(startWall0)) ?? 1
  )
  const [endMode, setEndMode] = useState<EndMode>(
    rule0?.count !== undefined && rule0.count !== null
      ? "count"
      : rule0?.until
        ? "until"
        : "never"
  )
  const [count, setCount] = useState(rule0?.count ?? 10)
  const [untilDate, setUntilDate] = useState(() =>
    rule0?.until ? wallDateStr(utcToWall(new Date(rule0.until), initialTz)) : ""
  )

  // -- Participants / rappels ----------------------------------------------
  // Participants : édition → liste existante ; création depuis une suggestion
  // IA → emails extraits (statut initial « en attente »).
  const [attendees, setAttendees] = useState<EventAttendee[]>(
    event?.attendees ??
      (defaultAttendees?.length
        ? defaultAttendees.slice(0, 20).map((email) => ({ email, status: "pending" as const }))
        : [])
  )
  const [attendeesOpen, setAttendeesOpen] = useState(false)
  const [attEmail, setAttEmail] = useState("")
  const [attName, setAttName] = useState("")
  const [attError, setAttError] = useState<string | null>(null)

  const [reminders, setReminders] = useState<ReminderRow[]>(
    (event?.reminders ?? []).map(reminderToRow)
  )
  const [remindersOpen, setRemindersOpen] = useState(false)

  // -- Portées & confirmations ----------------------------------------------
  const [scope, setScope] = useState<"single" | "series">("single")
  const [deleteScope, setDeleteScope] = useState<"single" | "series">("single")
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [errors, setErrors] = useState<FormErrors>({})

  const saving = create.isPending || update.isPending || remove.isPending

  // Jour de début (création) : pré-coché et VERROUILLÉ dans les chips hebdo.
  const lockedDay = isEdit ? null : weekdayOf(startDate)
  // Édition d'une occurrence : sélecteur de fuseau actif mais l'heure déplace
  // l'ancre → rappel visuel.
  const seriesNote = seriesContext && scope === "series"

  // Avertissement « passe minuit » : fin < début sur le même jour mural.
  const crossesMidnight =
    !allDay &&
    startDate &&
    endDate === startDate &&
    startTime &&
    endTime !== "" &&
    endTime < startTime

  // Instant UTC correspondant au début saisi (pédagogie « Stocké : … UTC »).
  const storedStamp = useMemo(() => {
    if (!startDate) return null
    const wall = parseWall(startDate, allDay ? "00:00" : startTime || "00:00")
    if (!wall) return null
    return formatUtcStamp(wallToUtc(wall, timezone))
  }, [startDate, startTime, allDay, timezone])

  const recurrenceSummary = useMemo(
    () =>
      buildRecurrenceSummary({
        freq,
        interval,
        byDays,
        monthlyMode,
        nth,
        nthDay,
        endMode,
        count,
        untilDate,
        startDate,
      }),
    [freq, interval, byDays, monthlyMode, nth, nthDay, endMode, count, untilDate, startDate]
  )

  const dayOfMonth = parseWall(startDate, "00:00")?.getUTCDate() ?? 1

  // Rappels push < 60 min ignorés en mode journée entière (filtrés au submit).
  const hasFilteredPush = allDay && reminders.some((r) => r.type === "push" && rowToMinutes(r) < 60)

  // ---------- Gestionnaires ----------

  function handleFreqChange(value: string) {
    const next = value as Freq
    setFreq(next)
    if (next === "weekly" && byDays.length === 0) {
      const day = lockedDay ?? weekdayOf(startDate)
      if (day !== null) setByDays([day]) // jour de début pré-coché
    }
  }

  function handleDaysChange(values: string[]) {
    let days = values.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    const lock = lockedDay
    if (lock !== null && !days.includes(lock)) days.push(lock) // verrouillé
    setByDays([...new Set(days)].sort((a, b) => a - b))
  }

  function addAttendee() {
    const email = attEmail.trim().toLowerCase()
    const name = attName.trim()
    if (!EMAIL_RE.test(email)) return setAttError("Adresse email invalide")
    if (attendees.some((a) => a.email === email)) return setAttError("Ce participant est déjà dans la liste")
    if (attendees.length >= 20) return setAttError("20 participants maximum")
    if (name.length > 120) return setAttError("Nom trop long (120 caractères maximum)")
    setAttendees((list) => [...list, { email, name: name || undefined, status: "pending" }])
    setAttEmail("")
    setAttName("")
    setAttError(null)
  }

  function cycleAttendeeStatus(index: number) {
    setAttendees((list) =>
      list.map((a, i) => (i === index ? { ...a, status: STATUS_CYCLE[a.status] } : a))
    )
  }

  function removeAttendee(index: number) {
    setAttendees((list) => list.filter((_, i) => i !== index))
  }

  function addReminder(minutes: number, type: EventReminder["type"] = "push") {
    if (reminders.length >= 5) return
    if (reminders.some((r) => r.type === type && rowToMinutes(r) === minutes)) return
    setReminders((list) => [...list, reminderToRow({ minutes, type })])
  }

  function updateReminder(index: number, patch: Partial<ReminderRow>) {
    setReminders((list) => list.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  function removeReminder(index: number) {
    setReminders((list) => list.filter((_, i) => i !== index))
  }

  // ---------- Submit ----------

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (saving) return

    const errs: FormErrors = {}

    // -- Validations locales (messages FR sous les champs) --
    const trimmedTitle = title.trim()
    if (!trimmedTitle) errs.title = "Le titre est requis"
    else if (trimmedTitle.length > 200) errs.title = "200 caractères maximum"

    if (!startDate) errs.start = errs.start ?? "La date de début est requise"
    if (!endDate) errs.end = errs.end ?? "La date de fin est requise"
    if (!allDay) {
      if (!startTime) errs.start = errs.start ?? "L'heure de début est requise"
      if (!endTime) errs.end = errs.end ?? "L'heure de fin est requise"
    }

    const startWall = startDate
      ? parseWall(startDate, allDay ? "00:00" : startTime || "00:00")
      : null
    let endWall = endDate ? parseWall(endDate, allDay ? "00:00" : endTime || "00:00") : null
    if (!startWall) errs.start = errs.start ?? "Date de début invalide"
    if (!endWall) errs.end = errs.end ?? "Date de fin invalide"
    const sameDay = Boolean(startDate && endDate && startDate === endDate)

    if (startWall && endWall) {
      if (allDay) {
        // Journée entière : fin ≥ début + 1 jour (minuit mural du lendemain).
        if (endWall.getTime() <= startWall.getTime()) {
          endWall = new Date(endWall.getTime() + DAY_MS)
        }
      } else if (endWall.getTime() <= startWall.getTime()) {
        if (sameDay) {
          // Comportement conservé : la fin passe minuit (+1 jour au submit).
          endWall = new Date(endWall.getTime() + DAY_MS)
        } else {
          errs.end = "La fin doit être après le début"
        }
      }
    }

    const intervalN = Math.floor(Number(interval))
    if (freq !== "none") {
      if (!Number.isFinite(intervalN) || intervalN < 1 || intervalN > 365)
        errs.interval = "L'intervalle doit être compris entre 1 et 365"
      if (freq === "weekly" && byDays.length === 0 && weekdayOf(startDate) === null)
        errs.byDays = "Choisissez au moins un jour"
      if (endMode === "count") {
        const c = Math.floor(Number(count))
        if (!Number.isFinite(c) || c < 1 || c > 500) errs.count = "Entre 1 et 500 occurrences"
      }
      if (endMode === "until" && !untilDate) errs.until = "Choisissez une date de fin"
    }

    // Rappels bornés (0 min → 14 jours).
    if (reminders.some((r) => !Number.isFinite(r.value) || rowToMinutes(r) > 20160 || r.value < 0)) {
      errs.form = "Rappel invalide (maximum 14 jours d'avance)"
    }

    if (Object.keys(errs).length > 0) {
      setErrors(errs)
      focusFirstError(errs)
      return
    }
    setErrors({})

    // -- Conversions murales → instants UTC (règle d'or) --
    const startUtc = wallToUtc(startWall!, timezone)
    const endUtc = wallToUtc(endWall!, timezone)
    if (endUtc.getTime() <= startUtc.getTime()) {
      // Décalage DST extrême (transition à l'heure choisie) — repli défensif.
      setErrors({ end: "La fin doit être après le début dans ce fuseau" })
      document.getElementById("evf-end")?.focus()
      return
    }
    const startIso = startUtc.toISOString()
    const endIso = endUtc.toISOString()

    // -- Récurrence → RecurrenceRule --
    let recurrence: RecurrenceRule | null = null
    if (freq !== "none" && !(isEdit && scope === "single")) {
      recurrence = { frequency: freq, interval: intervalN }
      if (freq === "weekly") {
        const fallback = weekdayOf(startDate)
        const days = byDays.length ? byDays : fallback !== null ? [fallback] : []
        if (days.length) recurrence.byDays = [...new Set(days)].sort((a, b) => a - b)
      }
      if (freq === "monthly" && monthlyMode === "nth") {
        recurrence.nth = nth
        recurrence.byDays = [nthDay]
      }
      if (endMode === "count") recurrence.count = Math.floor(Number(count))
      if (endMode === "until" && untilDate) {
        // Jusqu'au (inclusif) : fin de journée murale du date choisie.
        const untilWall = parseWall(untilDate, "23:59")
        if (untilWall) recurrence.until = wallToUtc(untilWall, timezone).toISOString()
      }
    }

    // -- Rappels (push < 60 min filtrés en journée entière) --
    const remindersOut: EventReminder[] = reminders
      .map((r) => ({ minutes: rowToMinutes(r), type: r.type }))
      .filter((r) => r.minutes <= 20160)
      .filter((r) => !(allDay && r.type === "push" && r.minutes < 60))

    const attendeesOut = attendees.map((a) => ({
      email: a.email,
      name: a.name,
      status: a.status,
    }))

    try {
      if (!isEdit) {
        // -- Création --
        const input = {
          title: trimmedTitle,
          description: description.trim() || undefined,
          location: location.trim() || undefined,
          startTime: startIso,
          endTime: endIso,
          allDay,
          timezone,
          color,
          recurrence,
          attendees: attendeesOut.length ? attendeesOut : null,
          reminders: remindersOut.length ? remindersOut : null,
          source: effectiveSource,
        }
        // Défense en profondeur : mêmes schémas que le serveur, messages FR.
        const parsed = eventCreateSchema.safeParse(input)
        if (!parsed.success) {
          const errs = zodIssuesToFormErrors(
            parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message }))
          )
          setErrors(errs)
          focusFirstError(errs)
          return
        }
        const res = await create.mutateAsync(input)
        toast.success("Événement créé", { description: successDescription(res.event, recurrence) })
        notifyConflicts(res.conflicts, timezone)
      } else {
        // -- Édition (scope « single » détache l'occurrence, sinon série/simple) --
        const single = seriesContext && scope === "single"
        // Clé d'occurrence : identifie l'occurrence D'ORIGINE dans la série
        // (l'heure saisie peut avoir changé — c'est l'ancre d'exception qui compte).
        const occurrenceKey = occurrenceStartIso ?? event!.startTime
        const input: Partial<EventInput> = {
          title: trimmedTitle,
          description: description.trim() || null,
          location: location.trim() || null,
          startTime: startIso,
          endTime: endIso,
          allDay,
          timezone,
          color,
          // Une occurrence détachée n'est jamais récurrente (validateur serveur).
          recurrence: single ? undefined : recurrence,
          // [] = vidage explicite (PATCH remplace les listes).
          attendees: attendeesOut,
          reminders: remindersOut,
        }
        const parsed = eventUpdateSchema.safeParse({
          ...input,
          ...(single ? { scope: "single" as const, occurrenceStart: occurrenceKey } : {}),
        })
        if (!parsed.success) {
          const errs = zodIssuesToFormErrors(
            parsed.error.issues.map((i) => ({ path: i.path.map(String), message: i.message }))
          )
          setErrors(errs)
          focusFirstError(errs)
          return
        }
        const res = await update.mutateAsync({
          id: event!.id,
          input,
          ...(single ? { scope: "single" as const, occurrenceStart: occurrenceKey } : {}),
        })
        toast.success(
          single ? "Occurrence mise à jour" : "Événement mis à jour",
          {
            description: successDescription(
              res.event,
              single ? null : recurrence
            ),
          }
        )
        notifyConflicts(res.conflicts, timezone)
      }
      onDone()
    } catch (err) {
      toast.error((err as Error).message ?? "Une erreur est survenue")
    }
  }

  async function handleDelete() {
    if (!event) return
    const single = seriesContext && deleteScope === "single"
    // Clé d'occurrence d'origine (cf. submit).
    const occurrenceKey = occurrenceStartIso ?? event.startTime
    try {
      await remove.mutateAsync({
        id: event.id,
        ...(single ? { scope: "single" as const, occurrenceStart: occurrenceKey } : {}),
      })
      if (single) {
        toast.success("Occurrence supprimée", {
          description: "La série continue pour les autres occurrences.",
        })
      } else if (event.recurrence) {
        toast.success("Série supprimée", { description: "Toutes les occurrences ont été retirées." })
      } else {
        toast.success("Événement supprimé")
      }
      setConfirmDelete(false)
      onDone()
    } catch (err) {
      toast.error((err as Error).message ?? "Suppression impossible")
    }
  }

  /** Focus sur le premier champ en erreur (ordre du formulaire). */
  function focusFirstError(errs: FormErrors) {
    for (const key of ["title", "start", "end", "timezone", "interval", "count", "until"] as const) {
      if (errs[key]) {
        document.getElementById(`evf-${key}`)?.focus()
        break
      }
    }
  }

  // ---------- Rendu ----------

  return (
    <>
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <DialogHeader className="text-left">
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <CalendarDays className="size-5 text-primary" aria-hidden />
            {isEdit ? "Modifier l'événement" : "Nouvel événement"}
            {event?.recurrence && !seriesContext && (
              <Badge variant="outline" className="gap-1 font-normal">
                <Repeat className="size-3" aria-hidden />
                Série
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Ajustez les détails de votre événement."
              : "Ajoutez un rendez-vous à votre calendrier Orbit."}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="-mx-1 max-h-[calc(100vh-16rem)] px-1">
          <div className="space-y-5 pb-2">
            {/* Portée : édition d'une occurrence de série */}
            {seriesContext && (
              <fieldset className="space-y-2 rounded-lg border bg-muted/30 p-3">
                <legend className="px-1 text-sm font-medium">Événement récurrent</legend>
                <RadioGroup
                  value={scope}
                  onValueChange={(v) => setScope(v as "single" | "series")}
                  className="gap-2"
                >
                  <div className="flex min-h-11 items-center gap-2">
                    <RadioGroupItem value="single" id="scope-single" />
                    <Label htmlFor="scope-single" className="cursor-pointer font-normal">
                      Cette occurrence uniquement
                    </Label>
                  </div>
                  <div className="flex min-h-11 items-center gap-2">
                    <RadioGroupItem value="series" id="scope-series" />
                    <Label htmlFor="scope-series" className="cursor-pointer font-normal">
                      Toute la série
                    </Label>
                  </div>
                </RadioGroup>
              </fieldset>
            )}

            {/* Titre */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor="evf-title">Titre</Label>
                {effectiveSource !== "manual" && (
                  <Badge variant="secondary" className="font-normal">
                    {SOURCE_LABELS[effectiveSource]}
                  </Badge>
                )}
              </div>
              <Input
                id="evf-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Ex. Réunion d'équipe"
                maxLength={200}
                autoFocus
                aria-invalid={!!errors.title}
                aria-describedby={errors.title ? "evf-title-error" : undefined}
                className="h-11"
              />
              {errors.title && (
                <p id="evf-title-error" role="alert" className="text-sm text-destructive">
                  {errors.title}
                </p>
              )}
            </div>

            {/* Toute la journée */}
            <div className="flex items-center justify-between gap-3 rounded-lg border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="evf-allday" className="cursor-pointer">
                  Toute la journée
                </Label>
                <p className="text-xs text-muted-foreground">
                  Masque les heures ; le fuseau reste utile pour la récurrence.
                </p>
              </div>
              <Switch
                id="evf-allday"
                checked={allDay}
                onCheckedChange={setAllDay}
                aria-label="Événement toute la journée"
              />
            </div>

            {/* Début / Fin (chaînes murales) */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <DateTimePicker
                label="Début"
                inputId="evf-start"
                date={startDate}
                time={allDay ? "00:00" : startTime}
                onDateChange={setStartDate}
                onTimeChange={setStartTime}
                timeDisabled={allDay}
                error={errors.start}
              />
              <DateTimePicker
                label="Fin"
                inputId="evf-end"
                date={endDate}
                time={allDay ? "00:00" : endTime}
                onDateChange={setEndDate}
                onTimeChange={setEndTime}
                timeDisabled={allDay}
                error={errors.end}
              />
            </div>
            {crossesMidnight && (
              <p className="text-xs text-amber-600 dark:text-amber-400" role="status">
                L&apos;heure de fin précède le début : l&apos;événement passera minuit (fin au jour
                suivant).
              </p>
            )}
            {allDay && (
              <p className="text-xs text-muted-foreground">
                Journée entière : l&apos;événement s&apos;étend du début au jour de fin inclus.
              </p>
            )}

            {/* Fuseau + pédagogie UTC */}
            <div className="space-y-2">
              <Label htmlFor="evf-timezone">Fuseau horaire</Label>
              <TimezoneSelector id="evf-timezone" value={timezone} onChange={setTimezone} />
              <p className="text-xs text-muted-foreground" aria-live="polite">
                {storedStamp ? `Stocké : ${storedStamp} UTC` : "Stocké : UTC"}
              </p>
              {seriesNote && (
                <p className="text-xs text-muted-foreground">
                  L&apos;heure s&apos;applique à toutes les occurrences de la série.
                </p>
              )}
            </div>

            {/* Lieu */}
            <div className="space-y-2">
              <Label htmlFor="evf-location">Lieu (optionnel)</Label>
              <div className="relative">
                <MapPin
                  className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  id="evf-location"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="Ex. Salle Kepler, 12 rue des Lilas"
                  maxLength={500}
                  className="h-11 pl-9"
                />
              </div>
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label htmlFor="evf-desc">Description (optionnel)</Label>
              <Textarea
                id="evf-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Détails, ordre du jour, notes…"
                rows={3}
                maxLength={5000}
              />
            </div>

            {/* Couleur */}
            <div className="space-y-2">
              <Label>Couleur</Label>
              <ColorPicker value={color} onChange={setColor} />
            </div>

            {/* Récurrence — masquée pour une occurrence (remplacée par la portée) */}
            {!seriesContext && (
              <fieldset className="space-y-3">
                <legend className="px-1 text-sm font-medium">Répétition</legend>
                <Select value={freq} onValueChange={handleFreqChange}>
                  <SelectTrigger className="h-11 w-full sm:w-64" aria-label="Fréquence">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Ne se répète pas</SelectItem>
                    <SelectItem value="daily">Quotidien</SelectItem>
                    <SelectItem value="weekly">Hebdomadaire</SelectItem>
                    <SelectItem value="monthly">Mensuel</SelectItem>
                  </SelectContent>
                </Select>

                {freq !== "none" && (
                  <div className="space-y-4 rounded-lg border p-3">
                    {/* Intervalle */}
                    <div className="flex flex-wrap items-center gap-2">
                      <Label htmlFor="evf-interval" className="text-muted-foreground">
                        {freq === "weekly" ? "Toutes les" : "Tous les"}
                      </Label>
                      <Input
                        id="evf-interval"
                        type="number"
                        min={1}
                        max={365}
                        value={interval}
                        onChange={(e) => setIntervalN(Number(e.target.value))}
                        className="h-11 w-20"
                        aria-invalid={!!errors.interval}
                      />
                      <span className="text-sm text-muted-foreground">
                        {freq === "daily" ? "jours" : freq === "weekly" ? "semaines" : "mois"}
                      </span>
                      {errors.interval && (
                        <p role="alert" className="w-full text-sm text-destructive">
                          {errors.interval}
                        </p>
                      )}
                    </div>

                    {/* Jours (hebdomadaire) */}
                    {freq === "weekly" && (
                      <div className="space-y-2">
                        <span className="text-sm text-muted-foreground">Jours</span>
                        <ToggleGroup
                          type="multiple"
                          variant="outline"
                          value={byDays.map(String)}
                          onValueChange={handleDaysChange}
                          className="flex-wrap gap-1.5"
                          aria-label="Jours de répétition"
                        >
                          {DAY_LABELS.map((lbl, i) => {
                            const locked = lockedDay === i
                            return (
                              <Tooltip key={i}>
                                <TooltipTrigger asChild>
                                  <ToggleGroupItem
                                    value={String(i)}
                                    aria-label={DAY_NAMES[i]}
                                    className="size-11 min-w-11 border-l px-0 data-[state=on]:border-primary data-[state=on]:bg-primary/10 data-[state=on]:text-primary"
                                  >
                                    {lbl}
                                  </ToggleGroupItem>
                                </TooltipTrigger>
                                {locked && (
                                  <TooltipContent>Jour de la première occurrence</TooltipContent>
                                )}
                              </Tooltip>
                            )
                          })}
                        </ToggleGroup>
                        {errors.byDays && (
                          <p role="alert" className="text-sm text-destructive">
                            {errors.byDays}
                          </p>
                        )}
                      </div>
                    )}

                    {/* Mensuel : jour du mois OU n-ième jour de semaine */}
                    {freq === "monthly" && (
                      <RadioGroup
                        value={monthlyMode}
                        onValueChange={(v) => setMonthlyMode(v as "dom" | "nth")}
                        className="gap-3"
                      >
                        <div className="flex min-h-11 items-center gap-2">
                          <RadioGroupItem value="dom" id="monthly-dom" />
                          <Label htmlFor="monthly-dom" className="cursor-pointer font-normal">
                            Le {dayOfMonth} du mois
                          </Label>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <RadioGroupItem value="nth" id="monthly-nth" />
                          <Label htmlFor="monthly-nth" className="cursor-pointer font-normal">
                            Le
                          </Label>
                          <Select
                            value={String(nth)}
                            onValueChange={(v) => setNth(Number(v))}
                            disabled={monthlyMode !== "nth"}
                          >
                            <SelectTrigger className="h-11 w-24" aria-label="Rang du jour">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {NTH_OPTIONS.map((o) => (
                                <SelectItem key={o.value} value={String(o.value)}>
                                  {o.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Select
                            value={String(nthDay)}
                            onValueChange={(v) => setNthDay(Number(v))}
                            disabled={monthlyMode !== "nth"}
                          >
                            <SelectTrigger className="h-11 w-36" aria-label="Jour de semaine">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {DAY_NAMES.map((name, i) => (
                                <SelectItem key={name} value={String(i)}>
                                  {name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </RadioGroup>
                    )}

                    {/* Fin de série */}
                    <div className="space-y-2">
                      <span className="text-sm text-muted-foreground">Fin</span>
                      <RadioGroup
                        value={endMode}
                        onValueChange={(v) => setEndMode(v as EndMode)}
                        className="gap-3"
                      >
                        <div className="flex min-h-11 items-center gap-2">
                          <RadioGroupItem value="never" id="end-never" />
                          <Label htmlFor="end-never" className="cursor-pointer font-normal">
                            Sans fin
                          </Label>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <RadioGroupItem value="count" id="end-count" />
                          <Label htmlFor="end-count" className="cursor-pointer font-normal">
                            Après
                          </Label>
                          <Input
                            id="evf-count"
                            type="number"
                            min={1}
                            max={500}
                            value={count}
                            disabled={endMode !== "count"}
                            onChange={(e) => setCount(Number(e.target.value))}
                            className="h-11 w-20"
                            aria-invalid={!!errors.count}
                          />
                          <span className="text-sm text-muted-foreground">occurrences</span>
                          {errors.count && (
                            <p role="alert" className="w-full text-sm text-destructive">
                              {errors.count}
                            </p>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <RadioGroupItem value="until" id="end-until" />
                          <Label htmlFor="end-until" className="cursor-pointer font-normal">
                            Jusqu&apos;au
                          </Label>
                          <Input
                            id="evf-until"
                            type="date"
                            value={untilDate}
                            disabled={endMode !== "until"}
                            onChange={(e) => setUntilDate(e.target.value)}
                            className="h-11 w-40"
                            aria-invalid={!!errors.until}
                          />
                          {errors.until && (
                            <p role="alert" className="w-full text-sm text-destructive">
                              {errors.until}
                            </p>
                          )}
                        </div>
                      </RadioGroup>
                    </div>

                    {/* Résumé humain en direct */}
                    <p aria-live="polite" className="text-sm text-muted-foreground">
                      {recurrenceSummary || "Répétition active"}
                    </p>
                  </div>
                )}
              </fieldset>
            )}

            {/* Participants */}
            <fieldset className="space-y-1">
              <Collapsible open={attendeesOpen} onOpenChange={setAttendeesOpen}>
                <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-lg py-2 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="flex items-center gap-2">
                    <Users className="size-4 text-muted-foreground" aria-hidden />
                    Participants
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge variant="secondary" className="font-normal">
                      {attendees.length}
                    </Badge>
                    <ChevronDown
                      className={cn(
                        "size-4 text-muted-foreground transition-transform",
                        attendeesOpen && "rotate-180"
                      )}
                      aria-hidden
                    />
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-3 pt-2">
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <Input
                      type="email"
                      value={attEmail}
                      onChange={(e) => setAttEmail(e.target.value)}
                      placeholder="email@exemple.fr"
                      aria-label="Email du participant"
                      className="h-11"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault()
                          addAttendee()
                        }
                      }}
                    />
                    <Input
                      value={attName}
                      onChange={(e) => setAttName(e.target.value)}
                      placeholder="Nom (optionnel)"
                      aria-label="Nom du participant"
                      className="h-11"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault()
                          addAttendee()
                        }
                      }}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      className="h-11"
                      onClick={addAttendee}
                      disabled={attendees.length >= 20}
                    >
                      <Plus className="size-4" aria-hidden />
                      Ajouter
                    </Button>
                  </div>
                  {attError && (
                    <p role="alert" className="text-sm text-destructive">
                      {attError}
                    </p>
                  )}
                  {attendees.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Aucun participant — 20 maximum.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {attendees.map((a, i) => (
                        <li
                          key={a.email}
                          className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
                        >
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">
                              {a.name || a.email}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">{a.email}</p>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              onClick={() => cycleAttendeeStatus(i)}
                              className="cursor-pointer rounded-md p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              aria-label={`Statut : ${ATTENDEE_STATUS[a.status].label} (cliquer pour changer)`}
                            >
                              <Badge
                                variant="outline"
                                className={cn("font-normal", ATTENDEE_STATUS[a.status].className)}
                              >
                                {ATTENDEE_STATUS[a.status].label}
                              </Badge>
                            </button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="size-11"
                              onClick={() => removeAttendee(i)}
                              aria-label={`Retirer ${a.name || a.email}`}
                            >
                              <X className="size-4" aria-hidden />
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </CollapsibleContent>
              </Collapsible>
            </fieldset>

            {/* Rappels */}
            <fieldset className="space-y-1">
              <Collapsible open={remindersOpen} onOpenChange={setRemindersOpen}>
                <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-lg py-2 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <span className="flex items-center gap-2">
                    <Bell className="size-4 text-muted-foreground" aria-hidden />
                    Rappels
                  </span>
                  <span className="flex items-center gap-2">
                    <Badge variant="secondary" className="font-normal">
                      {reminders.length}
                    </Badge>
                    <ChevronDown
                      className={cn(
                        "size-4 text-muted-foreground transition-transform",
                        remindersOpen && "rotate-180"
                      )}
                      aria-hidden
                    />
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent className="space-y-3 pt-2">
                  {/* Raccourcis */}
                  <div className="flex flex-wrap gap-2">
                    {QUICK_REMINDERS.map((q) => (
                      <Button
                        key={q.label}
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-9"
                        onClick={() => addReminder(q.minutes)}
                        disabled={reminders.length >= 5}
                      >
                        {q.label}
                      </Button>
                    ))}
                  </div>

                  {reminders.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      Aucun rappel — 5 maximum par événement.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {reminders.map((r, i) => (
                        <li
                          key={i}
                          className="flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
                        >
                          <Input
                            type="number"
                            min={0}
                            value={r.value}
                            onChange={(e) => updateReminder(i, { value: Number(e.target.value) })}
                            className="h-11 w-20"
                            aria-label="Délai du rappel"
                          />
                          <Select
                            value={r.unit}
                            onValueChange={(v) => updateReminder(i, { unit: v as ReminderUnit })}
                          >
                            <SelectTrigger className="h-11 w-40" aria-label="Unité du délai">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="minutes">minutes avant</SelectItem>
                              <SelectItem value="hours">heures avant</SelectItem>
                              <SelectItem value="days">jours avant</SelectItem>
                            </SelectContent>
                          </Select>
                          <Select
                            value={r.type}
                            onValueChange={(v) =>
                              updateReminder(i, { type: v as EventReminder["type"] })
                            }
                          >
                            <SelectTrigger className="h-11 w-28" aria-label="Canal du rappel">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="push">Push</SelectItem>
                              <SelectItem value="email">Email</SelectItem>
                            </SelectContent>
                          </Select>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="ml-auto size-11"
                            onClick={() => removeReminder(i)}
                            aria-label="Supprimer ce rappel"
                          >
                            <X className="size-4" aria-hidden />
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}

                  <Button
                    type="button"
                    variant="outline"
                    className="h-11"
                    onClick={() => setReminders((l) => [...l, { value: 15, unit: "minutes", type: "push" }])}
                    disabled={reminders.length >= 5}
                  >
                    <Plus className="size-4" aria-hidden />
                    Ajouter un rappel
                  </Button>

                  {hasFilteredPush && (
                    <p className="text-xs text-amber-600 dark:text-amber-400" role="status">
                      Journée entière : les rappels push de moins d&apos;une heure seront ignorés.
                    </p>
                  )}
                </CollapsibleContent>
              </Collapsible>
            </fieldset>

            {errors.form && (
              <p role="alert" className="text-sm text-destructive">
                {errors.form}
              </p>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="gap-2 sm:gap-0">
          {isEdit ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => setConfirmDelete(true)}
              className="mr-auto text-destructive hover:text-destructive"
              aria-label="Supprimer l'événement"
            >
              <Trash2 className="size-4" aria-hidden />
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onDone} disabled={saving}>
            Annuler
          </Button>
          <Button type="submit" disabled={saving}>
            {saving && <Loader2 className="size-4 animate-spin" aria-hidden />}
            {isEdit ? "Enregistrer" : "Créer"}
          </Button>
        </DialogFooter>
      </form>

      {/* Confirmation de suppression (portée pour les séries) */}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {seriesContext
                ? deleteScope === "single"
                  ? "Supprimer cette occurrence ?"
                  : "Supprimer toute la série ?"
                : "Supprimer cet événement ?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {seriesContext
                ? deleteScope === "single"
                  ? `« ${event?.title} » sera retiré de la série — les autres occurrences sont conservées.`
                  : `Toute la série « ${event?.title} » sera supprimée, passée et future.`
                : `« ${event?.title} » sera définitivement retiré de votre calendrier.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {seriesContext && (
            <RadioGroup
              value={deleteScope}
              onValueChange={(v) => setDeleteScope(v as "single" | "series")}
              className="gap-2"
            >
              <div className="flex min-h-11 items-center gap-2">
                <RadioGroupItem value="single" id="del-single" />
                <Label htmlFor="del-single" className="cursor-pointer font-normal">
                  Supprimer cette occurrence uniquement
                </Label>
              </div>
              <div className="flex min-h-11 items-center gap-2">
                <RadioGroupItem value="series" id="del-series" />
                <Label htmlFor="del-series" className="cursor-pointer font-normal">
                  Supprimer toute la série
                </Label>
              </div>
            </RadioGroup>
          )}
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
    </>
  )
}
