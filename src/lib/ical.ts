// Orbit — Import/Export iCalendar (RFC 5545) — implémentation autonome, zéro dépendance
// ─────────────────────────────────────────────────────────────────────────────
// Import : dépliage des lignes, propriétés + paramètres (guillemets), DATE vs
// DATE-TIME (UTC / TZID), RRULE → règle Orbit, EXDATE → exceptions, VALARM →
// rappels, échappement texte. Export : VCALENDAR conforme (CRLF, repli à 75
// octets, DTSTAMP, UID stable, RRULE, EXDATE, VALARM, ATTENDEE, COLOR).
//
// Limites assumées (documentées) : TZID non-IANA → UTC ; récurrences YEARLY/
// MINUTELY/HOURLY importées comme événements simples ; durées VALARM positives
// ignorées (un rappel ne peut pas être après l'événement).

import { wallToUtc, isValidTimezone, tzOffsetMs } from "@/lib/timezone"
import type { RecurrenceRule, EventAttendee, EventReminder } from "@/lib/types"

const DAY_CODES = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Événement issu d'un import .ics (prêt à créer en base). */
export type IcsEvent = {
  uid: string
  title: string
  description: string | null
  location: string | null
  start: Date // UTC
  end: Date // UTC
  allDay: boolean
  timezone: string
  color: string | null
  recurrence: RecurrenceRule | null
  exceptions: string[] // ISO UTC (débuts d'occurrences annulées)
  attendees: EventAttendee[]
  reminders: EventReminder[]
}

export type IcsParseResult = {
  events: IcsEvent[]
  warnings: string[]
}

export type IcsExportEvent = {
  id: string
  uid: string // UID stable (externalId ou dérivé de l'id)
  title: string
  description: string | null
  location: string | null
  start: Date // UTC
  end: Date // UTC
  allDay: boolean
  timezone: string
  color: string | null
  recurrence: RecurrenceRule | null
  exceptions: string[]
  attendees: EventAttendee[] | null
  reminders: EventReminder[] | null
  updatedAt: Date
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitives texte
// ─────────────────────────────────────────────────────────────────────────────

/** Échappement RFC 5545 des valeurs TEXT (\\, ;, ,, saut de ligne). */
function escapeText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n")
}

/** Dé-échappement inverse. */
function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\;/g, ";")
    .replace(/\\,/g, ",")
    .replace(/\\\\/g, "\\")
}

/** Découpe une ligne en { name, params, value } — gère les ':' dans les guillemets. */
function parseProperty(line: string): { name: string; params: Record<string, string>; value: string } | null {
  let inQuotes = false
  let colonIdx = -1
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (c === '"') inQuotes = !inQuotes
    else if (c === ":" && !inQuotes) {
      colonIdx = i
      break
    }
  }
  if (colonIdx < 0) return null
  const head = line.slice(0, colonIdx)
  const value = line.slice(colonIdx + 1)

  // Paramètres séparés par ';' hors guillemets.
  const segs: string[] = []
  let cur = ""
  inQuotes = false
  for (const c of head) {
    if (c === '"') {
      inQuotes = !inQuotes
      cur += c
    } else if (c === ";" && !inQuotes) {
      segs.push(cur)
      cur = ""
    } else cur += c
  }
  segs.push(cur)

  const name = segs[0].trim().toUpperCase()
  const params: Record<string, string> = {}
  for (const seg of segs.slice(1)) {
    const eq = seg.indexOf("=")
    if (eq > 0) {
      let v = seg.slice(eq + 1)
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
      params[seg.slice(0, eq).trim().toUpperCase()] = v
    }
  }
  return { name, params, value }
}

/** Repli de ligne RFC 5545 : les continuations commencent par espace/tabulation. */
function unfold(raw: string): string[] {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n[ \t]/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
}

/** Repli à l'export : lignes ≤ 75 octets UTF-8, continuation « \r\n  » (1 espace). */
function fold(line: string): string {
  const bytes = (s: string) => Buffer.byteLength(s, "utf8")
  if (bytes(line) <= 75) return line
  const out: string[] = []
  let chunk = ""
  for (const ch of line) {
    if (bytes(chunk + ch) > 74) {
      out.push(chunk)
      chunk = ch
    } else chunk += ch
  }
  if (chunk) out.push(chunk)
  return out.join("\r\n ")
}

// ─────────────────────────────────────────────────────────────────────────────
// Valeurs date/heure
// ─────────────────────────────────────────────────────────────────────────────

type ParsedDate = { instant: Date; allDay: boolean; tz: string }

/** DTSTART/DTEND/EXDATE : VALUE=DATE, TZID, suffixe Z, flottant → UTC. */
function parseIcsDate(value: string, params: Record<string, string>): ParsedDate | null {
  const v = value.trim()
  const isDateOnly = params.VALUE === "DATE" || /^\d{8}$/.test(v)
  const tzid = params.TZID && isValidTimezone(params.TZID) ? params.TZID : null

  if (isDateOnly) {
    const m = v.match(/^(\d{4})(\d{2})(\d{2})$/)
    if (!m) return null
    const wall = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 0, 0, 0))
    const tz = tzid ?? "UTC"
    return { instant: wallToUtc(wall, tz), allDay: true, tz }
  }

  const m = v.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/)
  if (!m) return null
  const [, y, mo, d, h, mi, s, z] = m
  if (z === "Z") {
    return { instant: new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)), allDay: false, tz: "UTC" }
  }
  const wall = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s))
  const tz = tzid ?? "UTC"
  return { instant: wallToUtc(wall, tz), allDay: false, tz }
}

/** Format DATE-TIME UTC « basique » (YYYYMMDDTHHMMSSZ). */
function toIcsUtc(instant: Date): string {
  const p = (n: number) => String(n).padStart(2, "0")
  return (
    `${instant.getUTCFullYear()}${p(instant.getUTCMonth() + 1)}${p(instant.getUTCDate())}` +
    `T${p(instant.getUTCHours())}${p(instant.getUTCMinutes())}${p(instant.getUTCSeconds())}Z`
  )
}

/** Format DATE « basique » (YYYYMMDD) dans le fuseau de l'événement. */
function toIcsDate(instant: Date, tz: string): string {
  const wall = new Date(instant.getTime() + tzOffsetMs(instant, tz))
  const p = (n: number) => String(n).padStart(2, "0")
  return `${wall.getUTCFullYear()}${p(wall.getUTCMonth() + 1)}${p(wall.getUTCDate())}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Durées (VALARM TRIGGER −PT…)
// ─────────────────────────────────────────────────────────────────────────────

/** « -PT15M » / « -PT1H30M » / « -P1DT12H » → minutes (signe conservé). */
function parseDurationMinutes(value: string): number | null {
  const m = value.trim().match(/^([+-]?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/)
  if (!m) return null
  const sign = m[1] === "-" ? -1 : 1
  const weeks = +(m[2] ?? 0)
  const days = +(m[3] ?? 0)
  const hours = +(m[4] ?? 0)
  const minutes = +(m[5] ?? 0)
  const seconds = +(m[6] ?? 0)
  const total = weeks * 7 * 1440 + days * 1440 + hours * 60 + minutes + seconds / 60
  return total === 0 ? null : sign * Math.round(total)
}

// ─────────────────────────────────────────────────────────────────────────────
// IMPORT — parseIcs
// ─────────────────────────────────────────────────────────────────────────────

export function parseIcs(text: string): IcsParseResult {
  const warnings: string[] = []
  const events: IcsEvent[] = []
  const lines = unfold(text)

  let i = 0
  while (i < lines.length) {
    const prop = parseProperty(lines[i])
    if (!prop || prop.name !== "BEGIN" || prop.value.trim().toUpperCase() !== "VEVENT") {
      i++
      continue
    }
    i++

    // ── Collecte du bloc VEVENT (VALARM imbriqué inclus) ──
    const raw: { name: string; params: Record<string, string>; value: string }[] = []
    let depth = 0
    while (i < lines.length) {
      const p = parseProperty(lines[i])
      if (!p) {
        i++
        continue
      }
      if (p.name === "BEGIN") depth++
      if (p.name === "END") {
        if (depth === 0) break // END:VEVENT
        depth--
      }
      raw.push(p)
      i++
    }
    i++ // consomme le END:VEVENT

    // ── Extraction des propriétés ──
    let uid = ""
    let title = ""
    let description: string | null = null
    let location: string | null = null
    let color: string | null = null
    let dtstart: ParsedDate | null = null
    let dtend: ParsedDate | null = null
    let rule: RecurrenceRule | null = null
    const exceptions: string[] = []
    const attendees: EventAttendee[] = []
    const reminders: EventReminder[] = []
    let inAlarm = false
    let alarmTrigger: string | null = null

    for (const p of raw) {
      switch (p.name) {
        case "BEGIN":
          if (p.value.trim().toUpperCase() === "VALARM") inAlarm = true
          break
        case "END":
          if (inAlarm) {
            if (alarmTrigger) {
              const minutes = parseDurationMinutes(alarmTrigger)
              if (minutes !== null && minutes < 0 && -minutes <= 20160 && reminders.length < 3) {
                reminders.push({ minutes: -minutes, type: "push" })
              }
            }
            inAlarm = false
            alarmTrigger = null
          }
          break
        case "UID":
          uid = p.value.trim()
          break
        case "SUMMARY":
          title = unescapeText(p.value)
          break
        case "DESCRIPTION":
          description = unescapeText(p.value)
          break
        case "LOCATION":
          location = unescapeText(p.value)
          break
        case "COLOR":
        case "X-APPLE-CALENDAR-COLOR": {
          const hex = p.value.trim()
          if (/^#[0-9A-Fa-f]{6}$/.test(hex)) color = hex.toUpperCase()
          break
        }
        case "DTSTART":
          dtstart = parseIcsDate(p.value, p.params)
          break
        case "DTEND":
          dtend = parseIcsDate(p.value, p.params)
          break
        case "RRULE":
          rule = parseRrule(p.value, warnings)
          break
        case "EXDATE": {
          for (const part of p.value.split(",")) {
            const parsed = parseIcsDate(part, p.params)
            if (parsed) exceptions.push(parsed.instant.toISOString())
          }
          break
        }
        case "ATTENDEE": {
          const email = p.value.replace(/^mailto:/i, "").trim()
          if (email && email.includes("@") && attendees.length < 20) {
            const partstat = (p.params.PARTSTAT ?? "pending").toLowerCase()
            attendees.push({
              email,
              name: p.params.CN ? unescapeText(p.params.CN) : undefined,
              status: partstat === "accepted" || partstat === "declined" ? partstat : "pending",
            })
          }
          break
        }
        case "TRIGGER":
          if (inAlarm) alarmTrigger = p.value
          break
        default:
          break // PROPRIÉTÉS IGNORÉES VOLONTAIREMENT (organizer, status, geo…)
      }
    }

    if (!dtstart) {
      warnings.push(`VEVENT ignoré (pas de DTSTART)${uid ? ` : ${uid}` : ""}`)
      continue
    }

    // DTEND absent : joursem entier → +1 jour ; horodaté → +1 h (utilisable).
    let end: Date
    if (dtend) end = dtend.instant
    else end = new Date(dtstart.instant.getTime() + (dtstart.allDay ? 86_400_000 : 3_600_000))

    if (end <= dtstart.instant) {
      end = new Date(dtstart.instant.getTime() + (dtstart.allDay ? 86_400_000 : 3_600_000))
    }

    events.push({
      uid: uid || `orbit-import-${events.length}-${Date.now()}`,
      title: title.trim() || "Événement importé",
      description: description?.trim() || null,
      location: location?.trim() || null,
      start: dtstart.instant,
      end,
      allDay: dtstart.allDay,
      timezone: dtstart.tz,
      color,
      recurrence: rule,
      exceptions,
      attendees,
      reminders,
    })
  }

  return { events, warnings }
}

/** RRULE (sous-chaîne type « FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=10 »). */
function parseRrule(value: string, warnings: string[]): RecurrenceRule | null {
  const parts: Record<string, string> = {}
  for (const seg of value.split(";")) {
    const eq = seg.indexOf("=")
    if (eq > 0) parts[seg.slice(0, eq).trim().toUpperCase()] = seg.slice(eq + 1).trim()
  }

  const freq = (parts.FREQ ?? "").toUpperCase()
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY") {
    if (freq) warnings.push(`Récurrence ${freq} non supportée → événement simple`)
    return null
  }

  const rule: RecurrenceRule = {
    frequency: freq.toLowerCase() as RecurrenceRule["frequency"],
    interval: Math.max(1, Math.min(365, parseInt(parts.INTERVAL ?? "1", 10) || 1)),
  }

  if (parts.UNTIL) {
    const u = parts.UNTIL
    if (/^\d{8}$/.test(u)) {
      const m = u.match(/(\d{4})(\d{2})(\d{2})/)!
      // Date seule → inclusif jusqu'à la fin de cette journée UTC.
      rule.until = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 23, 59, 59)).toISOString()
    } else {
      const parsed = parseIcsDate(u, {})
      if (parsed) rule.until = parsed.instant.toISOString()
    }
  }

  if (parts.COUNT) {
    const c = parseInt(parts.COUNT, 10)
    if (c >= 1) rule.count = Math.min(500, c)
  }

  if (parts.BYDAY) {
    const byDays: number[] = []
    let nth: number | undefined
    for (const token of parts.BYDAY.split(",")) {
      const m = token.trim().match(/^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/)
      if (!m) continue
      const dayIdx = DAY_CODES.indexOf(m[2] as (typeof DAY_CODES)[number])
      if (dayIdx >= 0) byDays.push(dayIdx)
      if (m[1]) {
        const n = parseInt(m[1], 10)
        if (n !== 0 && n >= -1 && n <= 5) nth = n
      }
    }
    if (byDays.length) rule.byDays = byDays
    if (nth !== undefined) rule.nth = nth
  }

  return rule
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT — buildIcs
// ─────────────────────────────────────────────────────────────────────────────

export function buildIcs(events: IcsExportEvent[], calendarName = "Orbit"): string {
  const stamp = toIcsUtc(new Date())
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Orbit//Calendrier personnel FR//FR",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(calendarName)}`,
  ]

  for (const e of events) {
    lines.push("BEGIN:VEVENT")
    lines.push(`UID:${e.uid || `orbit-${e.id}@orbit.local`}`)
    lines.push(`DTSTAMP:${toIcsUtc(e.updatedAt ?? new Date())}`)
    if (e.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${toIcsDate(e.start, e.timezone)}`)
      lines.push(`DTEND;VALUE=DATE:${toIcsDate(e.end, e.timezone)}`)
    } else {
      lines.push(`DTSTART:${toIcsUtc(e.start)}`)
      lines.push(`DTEND:${toIcsUtc(e.end)}`)
    }
    lines.push(`SUMMARY:${escapeText(e.title)}`)
    if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`)
    if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`)
    if (e.color) lines.push(`COLOR:${e.color}`)

    // Récurrence — RRULE + EXDATE (exceptions de série)
    if (e.recurrence) {
      const rrule: string[] = [`FREQ=${e.recurrence.frequency.toUpperCase()}`]
      if (e.recurrence.interval && e.recurrence.interval !== 1) {
        rrule.push(`INTERVAL=${e.recurrence.interval}`)
      }
      if (e.recurrence.until) {
        rrule.push(`UNTIL=${toIcsUtc(new Date(e.recurrence.until))}`)
      }
      if (e.recurrence.count) rrule.push(`COUNT=${e.recurrence.count}`)
      if (e.recurrence.byDays?.length) {
        const prefix = e.recurrence.frequency === "monthly" && e.recurrence.nth ? String(e.recurrence.nth) : ""
        rrule.push(`BYDAY=${e.recurrence.byDays.map((d) => `${prefix}${DAY_CODES[d]}`).join(",")}`)
      }
      lines.push(`RRULE:${rrule.join(";")}`)
      for (const ex of e.exceptions) {
        lines.push(`EXDATE:${toIcsUtc(new Date(ex))}`)
      }
    }

    // Participants
    for (const a of e.attendees ?? []) {
      const cn = a.name ? `;CN="${escapeText(a.name).replace(/"/g, "")}"` : ""
      lines.push(`ATTENDEE${cn};PARTSTAT=${(a.status ?? "pending").toUpperCase()}:mailto:${a.email}`)
    }

    // Rappels (push) → VALARM
    for (const r of (e.reminders ?? []).filter((r) => r.type === "push").slice(0, 3)) {
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `TRIGGER:-PT${Math.max(0, Math.round(r.minutes))}M`)
      lines.push(`DESCRIPTION:${escapeText(`Rappel : ${e.title}`)}`)
      lines.push("END:VALARM")
    }

    lines.push("END:VEVENT")
  }

  lines.push("END:VCALENDAR")
  return lines.map(fold).join("\r\n") + "\r\n"
}
