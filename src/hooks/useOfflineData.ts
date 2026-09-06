"use client";

// Orbit — Données offline (live queries Dexie + expansion des récurrences)
// ───────────────────────────────────────────────────────────────────────────
// Source des vues quand l'app est hors ligne (réel ou simulé) : cache local
// Dexie, réactif (toute mutation optimiste/mise en file apparaît immédiatement).
// Les entités _syncStatus « deleted » (suppression en file) sont filtrées.
//
// expandLocalEvents : les événements sont stockés MASTERS (récurrence non
// expansée, comme en base) — l'expansion client utilise le MÊME moteur que
// le serveur (lib/calendar.expandEvent : exceptions, until/count honorés).

import { useLiveQuery } from "dexie-react-hooks";
import { db, type LocalEvent, type LocalTask, type LocalEmail } from "@/lib/offline/indexeddb";
import { expandEvent } from "@/lib/calendar";
import type { EventDto } from "@/lib/types";

/** Tâches consultables hors ligne (suppressions en file exclues). */
export function useOfflineTasks(): LocalTask[] {
  const rows = useLiveQuery(() => db.tasks.toArray(), []);
  return (rows ?? []).filter((task) => task._syncStatus !== "deleted");
}

/** Emails consultables hors ligne (suppressions en file exclues). */
export function useOfflineEmails(): LocalEmail[] {
  const rows = useLiveQuery(() => db.emails.toArray(), []);
  return (rows ?? []).filter((email) => email._syncStatus !== "deleted");
}

/** Événements MASTERS consultables hors ligne (récurrence non expansée). */
export function useOfflineEvents(): LocalEvent[] {
  const rows = useLiveQuery(() => db.events.toArray(), []);
  return (rows ?? []).filter((event) => event._syncStatus !== "deleted");
}

/**
 * Expanse les masters locaux en occurrences EventDto (même contrat que
 * GET /api/events?start&end — isOccurrence/seriesId/occurrenceStart inclus).
 */
export function expandLocalEvents(masters: LocalEvent[], start?: Date, end?: Date): EventDto[] {
  const rangeStart = start ?? new Date(Date.now() - 400 * 86_400_000);
  const rangeEnd = end ?? new Date(Date.now() + 400 * 86_400_000);
  const out: EventDto[] = [];

  for (const master of masters) {
    const occurrences = expandEvent(
      {
        startTime: new Date(master.startTime),
        endTime: new Date(master.endTime),
        allDay: master.allDay,
        timezone: master.timezone,
        recurrence: master.recurrence,
        recurrenceExceptions: master.recurrenceExceptions,
      },
      rangeStart,
      rangeEnd
    );
    for (const occurrence of occurrences) {
      out.push({
        ...master,
        startTime: occurrence.start.toISOString(),
        endTime: occurrence.end.toISOString(),
        isOccurrence: occurrence.isOccurrence,
        seriesId: occurrence.isOccurrence ? master.id : null,
        occurrenceStart: occurrence.isOccurrence ? occurrence.start.toISOString() : null,
      });
    }
  }
  return out.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}
