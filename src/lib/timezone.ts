// Orbit — Utilitaires fuseaux horaires (zéro dépendance : pure API Intl)
// ─────────────────────────────────────────────────────────────────────────────
// RÈGLE D'OR : les instants sont TOUJOURS stockés et échangés en UTC (ISO 8601,
// suffixe Z). La timezone IANA de référence d'un événement est stockée à part
// (Event.timezone) ; la timezone d'AFFICHAGE est celle de l'utilisateur
// (préférence profil → fuseau du navigateur → UTC).
//
// Convention « murale » : une Date dont les champs UTC (getUTCFullYear, etc.)
// contiennent l'heure locale du fuseau visé. Toute l'arithmétique de calendrier
// (récurrences, journées, événements toute la journée) se fait sur ces valeurs
// murales — pas de dérive DST car on opère sur une ligne de temps pseudo-UTC.

/** Vérifie qu'une chaîne est un identifiant IANA valide ("Europe/Paris"…). */
export function isValidTimezone(tz: string): boolean {
  if (!tz || tz.length > 64) return false
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/** Décalage (ms) entre UTC et le fuseau `tz` à l'instant donné. */
export function tzOffsetMs(instant: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
  const parts = dtf.formatToParts(instant)
  const map: Record<string, number> = {}
  for (const p of parts) if (p.type !== "literal") map[p.type] = Number(p.value)
  const asUtc = Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second)
  return asUtc - instant.getTime()
}

/** Instant UTC → Date « murale » dans tz (les champs UTC contiennent l'heure locale). */
export function utcToWall(instant: Date, tz: string): Date {
  return new Date(instant.getTime() + tzOffsetMs(instant, tz))
}

/** Date « murale » dans tz → instant UTC réel.
 *  Heures ambiguës (retour d'heure d'été) : l'occurrence la plus tôt est choisie. */
export function wallToUtc(wall: Date, tz: string): Date {
  // Première approximation : on suppose que le décalage au instant-murale est correct…
  const guess = wall.getTime() - tzOffsetMs(wall, tz)
  // …puis on raffine une fois (le décalage à l'instant estimé peut différer près
  // d'une transition DST — l'astuce classique du polyfill Temporal).
  return new Date(wall.getTime() - tzOffsetMs(new Date(guess), tz))
}

/** Clone « formatable » : Date locale dont les champs LOCAUX (getFullYear, getHours…)
 *  contiennent les valeurs murales → utilisable directement avec date-fns
 *  `format(date, "HH:mm", { locale: fr })` sans décalage. */
export function wallToFormatable(wall: Date): Date {
  return new Date(
    wall.getUTCFullYear(),
    wall.getUTCMonth(),
    wall.getUTCDate(),
    wall.getUTCHours(),
    wall.getUTCMinutes(),
    0,
    0
  )
}

/** Formate un instant UTC directement dans un fuseau via Intl (fr-FR). */
export function formatInTz(instant: Date, tz: string, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat("fr-FR", { timeZone: tz, ...opts }).format(instant)
  } catch {
    return new Intl.DateTimeFormat("fr-FR", opts).format(instant)
  }
}

/** Clé de jour « yyyy-MM-dd » de l'instant, dans le fuseau donné. */
export function dayKeyInTz(instant: Date, tz: string): string {
  // en-CA produit nativement le format yyyy-MM-dd.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant)
}

/** Début (00:00 murale) du jour de l'instant, dans le fuseau donné → instant UTC. */
export function startOfDayInTz(instant: Date, tz: string): Date {
  const key = dayKeyInTz(instant, tz)
  const [y, m, d] = key.split("-").map(Number)
  return wallToUtc(new Date(Date.UTC(y, m - 1, d, 0, 0, 0)), tz)
}

/** Fuseau du navigateur (côté client) — UTC en cas d'échec. */
export function getBrowserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

/** Libellé court d'un fuseau pour l'UI (ex. « UTC+2 — Europe/Paris »). */
export function timezoneLabel(tz: string, at: Date = new Date()): string {
  // Arrondi à la minute (l'offset Intl peut porter des sous-secondes)
  const offset = Math.round(tzOffsetMs(at, tz) / 60_000) * 60_000
  const sign = offset < 0 ? "-" : "+"
  const abs = Math.abs(offset)
  const h = String(Math.floor(abs / 3_600_000)).padStart(2, "0")
  const m = String(Math.floor((abs % 3_600_000) / 60_000)).padStart(2, "0")
  return `UTC${sign}${h}:${m} — ${tz}`
}

/** Fuseaux proposés dans le sélecteur (priorité Europe/Afrique). */
export const COMMON_TIMEZONES: string[] = [
  "UTC",
  "Europe/Paris",
  "Europe/London",
  "Europe/Lisbon",
  "Europe/Madrid",
  "Europe/Brussels",
  "Europe/Berlin",
  "Europe/Zurich",
  "Africa/Dakar",
  "Africa/Casablanca",
  "Africa/Abidjan",
  "Africa/Lagos",
  "Africa/Cairo",
  "America/New_York",
  "America/Chicago",
  "America/Mexico_City",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Asia/Dubai",
  "Asia/Riyadh",
  "Asia/Kolkata",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Australia/Sydney",
  "Pacific/Auckland",
]
