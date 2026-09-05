// Orbit — Service événements côté serveur : chargement + expansion + conflits
// ─────────────────────────────────────────────────────────────────────────────
// Point d'entrée unique partagé par toutes les routes (liste, création, édition,
// import/export, rappels, stats, assistant) — garantit une seule sémantique
// d'expansion des récurrences et de détection de conflits.

import { db } from "@/lib/db"
import { Prisma } from "@prisma/client"
import { expandEvent, overlaps, type ConflictCandidate } from "@/lib/calendar"
import { toEventDto, toOccurrenceDto, parseRecurrence } from "@/lib/dto"
import type { EventDto } from "@/lib/types"
import type { Event } from "@prisma/client"

/**
 * Normalise une valeur Json pour l'ENTRÉE Prisma : null/undefined → DbNull
 * (NULL SQL — Prisma n'accepte pas `null` nu sur les colonnes Json).
 */
export function toJsonInput(
  value: unknown
): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue {
  if (value === null || value === undefined) return Prisma.DbNull
  return value as Prisma.InputJsonValue
}

/** Nettoie les caractères de contrôle d'un texte libre (anti-injection display). */
export function sanitizeText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim()
}

/**
 * Charge les événements d'un utilisateur dans une plage et expanse les séries
 * récurrentes en occurrences (jamais persistées — cf. lib/calendar.ts).
 * Résultat trié chronologiquement.
 */
export async function loadExpandedEvents(
  userId: string,
  rangeStart: Date,
  rangeEnd: Date,
  maxEvents = 2000
): Promise<EventDto[]> {
  // Remarque : pas de filtre JSON « recurrence IS NOT NULL » (support SQLite
  // inégal) — on récupère tous les masters ancrés avant la fin de plage et on
  // dispatch en mémoire (volume personnel, take de garde).
  const masters = await db.event.findMany({
    where: {
      userId,
      startTime: { lte: rangeEnd },
    },
    orderBy: { startTime: "asc" },
    take: maxEvents,
  })

  const out: EventDto[] = []
  for (const e of masters) {
    const rule = parseRecurrence(e.recurrence)
    const occurrences = expandEvent(
      {
        startTime: e.startTime,
        endTime: e.endTime,
        allDay: e.allDay,
        timezone: e.timezone,
        recurrence: rule,
        recurrenceExceptions: e.recurrenceExceptions,
      },
      rangeStart,
      rangeEnd
    )
    for (const occ of occurrences) {
      out.push(occ.isOccurrence ? toOccurrenceDto(e, occ) : toEventDto(e))
    }
  }

  // Tri chronologique (ISO 8601 Z → tri lexicographique = chronologique)
  out.sort((a, b) => a.startTime.localeCompare(b.startTime))
  return out
}

/**
 * Détecte les conflits horaires d'un créneau candidate (chevauchement strict),
 * en expasant les séries récurrentes existantes. Retourne max 5 conflits.
 */
export async function computeConflicts(
  userId: string,
  candidate: { start: Date; end: Date },
  excludeIds: string[] = []
): Promise<EventDto[]> {
  // Marge d'un jour de part et d'autre : largement suffisante pour capter
  // tout chevauchement réel avec les occurrences voisines.
  const pad = 86_400_000
  const from = new Date(candidate.start.getTime() - pad)
  const to = new Date(candidate.end.getTime() + pad)
  const expanded = await loadExpandedEvents(userId, from, to)

  const excluded = new Set(excludeIds)
  return expanded
    .filter(
      (e) =>
        !excluded.has(e.id) &&
        overlaps(candidate, { start: new Date(e.startTime), end: new Date(e.endTime) })
    )
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
    .slice(0, 5)
}

/** Helpers Prisma : convertit les exceptions (ISO) en tableau JSON dédupliqué. */
export function appendException(existing: unknown, occurrenceStartIso: string): string[] {
  const list = Array.isArray(existing)
    ? (existing as unknown[]).filter((s): s is string => typeof s === "string")
    : []
  return [...new Set([...list, occurrenceStartIso])]
}

/** Vérifie qu'un début d'occurrence appartient bien à la série (anti-abus). */
export function isOccurrenceOfSeries(
  master: Pick<Event, "startTime" | "endTime" | "allDay" | "timezone" | "recurrence" | "recurrenceExceptions">,
  occurrenceStart: Date
): boolean {
  const rule = parseRecurrence(master.recurrence)
  if (!rule) return false
  const pad = 86_400_000
  const occurrences = expandEvent(
    {
      startTime: master.startTime,
      endTime: master.endTime,
      allDay: master.allDay,
      timezone: master.timezone,
      recurrence: rule,
      recurrenceExceptions: [], // exceptions incluses volontairement : elles restent des dates valides de la série
    },
    new Date(occurrenceStart.getTime() - pad),
    new Date(occurrenceStart.getTime() + pad),
    10
  )
  return occurrences.some((o) => o.start.getTime() === occurrenceStart.getTime())
}

/** Type utilitaire pour findConflicts (compat). */
export type { ConflictCandidate }
