// Orbit — Helpers calendrier : expansion des récurrences, conflits, plages
// ─────────────────────────────────────────────────────────────────────────────
// PRINCIPE (piège classique évité) : les occurrences d'une série ne sont JAMAIS
// persistées en base — la série est stockée une seule fois (master + règle JSON)
// puis « expansée » à la volée dans la plage visible. L'arithmétique se fait sur
// des dates « murales » dans le fuseau de l'événement (cf. lib/timezone.ts), ce
// qui garde 09:00 à 09:00 à travers les transitions DST.

import { utcToWall, wallToUtc, dayKeyInTz } from "@/lib/timezone"
import type { RecurrenceRule } from "@/lib/types"

const DAY_MS = 86_400_000
/** Garde-fou anti-boucle infinie / déni de service (plages énormes, règles folles). */
const MAX_ITERATIONS = 5_000
/** Plage maximale acceptée par l'API (jours) — au-delà, la plage est tronquée. */
export const MAX_RANGE_DAYS = 400

// ─────────────────────────────────────────────────────────────────────────────
// Types internes
// ─────────────────────────────────────────────────────────────────────────────

/** Ce dont l'expansion a besoin — compatible Prisma Event et DTO. */
export type RecurrenceSource = {
  startTime: Date // UTC — ancre = première occurrence de la série
  endTime: Date // UTC — durée de référence (endTime − startTime)
  allDay: boolean
  timezone: string
  recurrence: RecurrenceRule | null
  recurrenceExceptions?: unknown
}

/** Une occurrence expansée (matérialisée à la volée, jamais en base). */
export type Occurrence = {
  start: Date
  end: Date
  /** true si c'est l'occurrence d'une série récurrente. */
  isOccurrence: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Lecture défensive des champs JSON
// ─────────────────────────────────────────────────────────────────────────────

function parseExceptions(raw: unknown): Set<number> {
  if (!Array.isArray(raw)) return new Set()
  const out = new Set<number>()
  for (const item of raw) {
    if (typeof item !== "string") continue
    const t = Date.parse(item)
    if (!Number.isNaN(t)) out.add(t)
  }
  return out
}

function sanitizeRule(rule: RecurrenceRule | null): RecurrenceRule | null {
  if (!rule || !rule.frequency) return null
  const interval = Math.max(1, Math.min(365, Math.floor(rule.interval ?? 1)))
  const clean: RecurrenceRule = { frequency: rule.frequency, interval }
  if (rule.until && !Number.isNaN(Date.parse(rule.until))) clean.until = rule.until
  if (typeof rule.count === "number") clean.count = Math.max(1, Math.min(500, Math.floor(rule.count)))
  if (Array.isArray(rule.byDays)) {
    clean.byDays = rule.byDays
      .map((d) => Math.floor(d))
      .filter((d) => d >= 0 && d <= 6)
      .slice(0, 7)
  }
  if (typeof rule.nth === "number" && rule.nth !== 0) clean.nth = Math.max(-1, Math.min(5, rule.nth))
  return clean
}

/** « until » → instant limite inclusif (date seule → fin de journée UTC). */
function untilToInstant(rule: RecurrenceRule): number | null {
  if (!rule.until) return null
  const iso = rule.until
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return null
  // Date seule (yyyy-MM-dd) : inclusif jusqu'à la fin de cette journée UTC.
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return t + DAY_MS - 1
  return t
}

// ─────────────────────────────────────────────────────────────────────────────
// Générateurs murales (une seule implémentation partagée, cursifs sur les ms)
// ─────────────────────────────────────────────────────────────────────────────

/** Index du jour de semaine (0 = lundi … 6 = dimanche) d'une date murale. */
function wallWeekday(wallMs: number): number {
  return (new Date(wallMs).getUTCDay() + 6) % 7
}

/** Lundi 00:00 (murale) de la semaine contenant wallMs. */
function wallMonday(wallMs: number): number {
  return wallMs - wallWeekday(wallMs) * DAY_MS - (wallMs % DAY_MS)
}

/**
 * Itérateur des débuts d'occurrences (ms murales, croissant, ancre incluse).
 * `fastForwardUntil` (ms murales) permet de sauter directement près de la plage
 * visée — uniquement utilisable quand `count` est absent (le décompte d'occurrences
 * doit alors partir de l'ancre).
 */
function* occurrenceWallGenerator(
  anchorWallMs: number,
  rule: RecurrenceRule,
  fastForwardUntil: number | null
): Generator<number> {
  const timeOfDay = anchorWallMs % DAY_MS
  const byDays = rule.byDays?.length ? [...new Set(rule.byDays)].sort((a, b) => a - b) : null

  switch (rule.frequency) {
    case "daily": {
      const period = rule.interval * DAY_MS
      let cursor = anchorWallMs
      if (fastForwardUntil !== null && cursor < fastForwardUntil) {
        const skip = Math.ceil((fastForwardUntil - cursor) / period)
        cursor += skip * period
      }
      while (true) {
        yield cursor
        cursor += period
      }
    }

    case "weekly": {
      // Jours de semaine visés (0 = lundi) — par défaut : celui de l'ancre.
      const days = byDays ?? [wallWeekday(anchorWallMs)]
      const period = rule.interval * 7 * DAY_MS
      let monday = wallMonday(anchorWallMs)
      if (fastForwardUntil !== null && monday + 7 * DAY_MS < fastForwardUntil) {
        const skip = Math.floor((wallMonday(fastForwardUntil) - monday) / period)
        if (skip > 0) monday += skip * period
      }
      while (true) {
        for (const d of days) {
          const occ = monday + d * DAY_MS + timeOfDay
          // Dans la semaine de l'ancre, on ne démarre pas avant l'ancre elle-même.
          if (occ >= anchorWallMs) yield occ
        }
        monday += period
      }
    }

    case "monthly": {
      const anchor = new Date(anchorWallMs)
      const anchorDay = anchor.getUTCDate()
      const anchorWeekday = wallWeekday(anchorWallMs)
      let y = anchor.getUTCFullYear()
      let mIdx = anchor.getUTCMonth() // 0-based
      if (fastForwardUntil !== null) {
        const ff = new Date(fastForwardUntil)
        const monthsDiff = (ff.getUTCFullYear() - y) * 12 + (ff.getUTCMonth() - mIdx)
        if (monthsDiff > 0) {
          const skip = Math.ceil(monthsDiff / rule.interval) * rule.interval
          mIdx += skip
        }
      }
      while (true) {
        // Résout le « n-ième jour de semaine du mois » (nth = -1 → dernier)…
        let occMs: number | null = null
        if (rule.nth && byDays?.length) {
          occMs = nthWeekdayOfMonthMs(y, mIdx, byDays[0], rule.nth, timeOfDay)
        } else if (rule.nth) {
          occMs = nthWeekdayOfMonthMs(y, mIdx, anchorWeekday, rule.nth, timeOfDay)
        } else {
          // …ou le jour du mois de l'ancre (mois trop courts → occurrence sautée).
          const daysInMonth = new Date(Date.UTC(y, mIdx + 1, 0)).getUTCDate()
          if (anchorDay <= daysInMonth) {
            occMs = Date.UTC(y, mIdx, anchorDay) + timeOfDay
          }
        }
        if (occMs !== null && occMs >= anchorWallMs) yield occMs
        mIdx += rule.interval
        while (mIdx > 11) {
          mIdx -= 12
          y += 1
        }
      }
    }
  }
}

/** Millisecondes murales du n-ième (ou dernier si nth = -1) jour de semaine du mois. */
function nthWeekdayOfMonthMs(year: number, monthIdx: number, weekday: number, nth: number, timeOfDay: number): number | null {
  if (nth > 0) {
    const first = Date.UTC(year, monthIdx, 1)
    const firstWeekday = wallWeekday(first)
    const offset = (weekday - firstWeekday + 7) % 7
    const day = 1 + offset + (nth - 1) * 7
    const daysInMonth = new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate()
    if (day > daysInMonth) return null
    return Date.UTC(year, monthIdx, day) + timeOfDay
  }
  // nth = -1 → dernière occurrence du mois
  const last = Date.UTC(year, monthIdx + 1, 0)
  const lastWeekday = wallWeekday(last)
  const offset = (lastWeekday - weekday + 7) % 7
  return last - offset * DAY_MS + timeOfDay
}

// ─────────────────────────────────────────────────────────────────────────────
// Expansion publique
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Expanse un événement en occurrences dans [rangeStart, rangeEnd[.
 * - Événement simple : 0 ou 1 occurrence (si chevauchement de plage).
 * - Série récurrente : occurrences générées à la volée, exceptions filtrées,
 *   `until`/`count` honorés, plafond anti-déni-de-service.
 */
export function expandEvent(
  src: RecurrenceSource,
  rangeStart: Date,
  rangeEnd: Date,
  maxOccurrences = 300
): Occurrence[] {
  const rule = sanitizeRule(src.recurrence ?? null)
  const duration = Math.max(0, src.endTime.getTime() - src.startTime.getTime())
  const tz = src.timezone || "UTC"
  const exceptions = parseExceptions(src.recurrenceExceptions)

  // Événement simple
  if (!rule) {
    if (src.startTime < rangeEnd && new Date(src.startTime.getTime() + duration) > rangeStart) {
      if (exceptions.has(src.startTime.getTime())) return []
      return [{ start: src.startTime, end: new Date(src.startTime.getTime() + duration), isOccurrence: false }]
    }
    return []
  }

  // Série récurrente
  const untilInstant = untilToInstant(rule)
  const count = rule.count ?? Infinity
  const tzWallRangeStart = utcToWall(rangeStart, tz).getTime()
  const tzWallRangeEnd = utcToWall(rangeEnd, tz).getTime()
  const anchorWallMs = utcToWall(src.startTime, tz).getTime()
  // Fast-forward uniquement si l'on n'a pas besoin de compter depuis l'ancre.
  const fastForward = rule.count ? null : tzWallRangeStart

  const out: Occurrence[] = []
  let emitted = 0
  let iterations = 0

  for (const wallMs of occurrenceWallGenerator(anchorWallMs, rule, fastForward)) {
    if (++iterations > MAX_ITERATIONS) break
    if (emitted >= count || out.length >= maxOccurrences) break

    const start = wallToUtc(new Date(wallMs), tz)
    // Dépasse la fin de plage (générateur croissant) → terminé.
    if (start.getTime() >= rangeEnd.getTime()) break
    if (untilInstant !== null && start.getTime() > untilInstant) break

    emitted++ // l'occurrence existe (décompte `count`), même hors plage
    const end = new Date(start.getTime() + duration)
    if (end.getTime() <= rangeStart.getTime()) continue // hors plage (avant)
    if (exceptions.has(start.getTime())) continue // occurrence annulée/éditée à part
    out.push({ start, end, isOccurrence: true })
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Conflits horaires
// ─────────────────────────────────────────────────────────────────────────────

export type ConflictCandidate = {
  id: string
  title: string
  start: Date
  end: Date
  allDay?: boolean
  isOccurrence?: boolean
}

/** Chevauchement strict : a.start < b.end && b.start < a.end. */
export function overlaps(a: { start: Date; end: Date }, b: { start: Date; end: Date }): boolean {
  return a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime()
}

/** Renvoie les événements en conflit avec le créneau candidate (max `limit`). */
export function findConflicts(
  candidate: { start: Date; end: Date },
  others: ConflictCandidate[],
  excludeIds: string[] = [],
  limit = 5
): ConflictCandidate[] {
  const excluded = new Set(excludeIds)
  return others
    .filter((o) => !excluded.has(o.id) && overlaps(candidate, o))
    .sort((a, b) => a.start.getTime() - b.start.getTime())
    .slice(0, limit)
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers de plage
// ─────────────────────────────────────────────────────────────────────────────

/** Borner une plage demandée par le client (anti-abus, cf. MAX_RANGE_DAYS). */
export function clampRange(start: Date, end: Date): { start: Date; end: Date } {
  const maxEnd = new Date(start.getTime() + MAX_RANGE_DAYS * DAY_MS)
  return { start, end: end > maxEnd ? maxEnd : end }
}

/** Groupe des occurrences par jour (clé yyyy-MM-dd dans le fuseau donné). */
export function groupByDay<T extends { start: Date }>(items: T[], tz: string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const key = dayKeyInTz(item.start, tz)
    const bucket = map.get(key)
    if (bucket) bucket.push(item)
    else map.set(key, [item])
  }
  return map
}
