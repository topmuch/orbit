"use client"

// Orbit — Fuseau d'affichage de l'utilisateur (préférence locale + persistance profil)
// ─────────────────────────────────────────────────────────────────────────────
// Le navigateur est la source de vérité AU MONTAGE (le DTO de session ne porte
// pas le fuseau ; /api/profile n'expose pas de GET) — la préférence est
// PERSISTÉE côté profil à chaque changement (PATCH /api/profile, fire-and-forget).
// RÈGLE D'OR respectée : tous les helpers passent par src/lib/timezone.ts
// (utcToWall / wallToUtc / wallToFormatable) — jamais de format direct d'un
// instant UTC par date-fns.

import { useCallback, useState } from "react"
import { format } from "date-fns"
import { fr } from "date-fns/locale"
import { toast } from "sonner"
import {
  dayKeyInTz,
  getBrowserTimezone,
  isValidTimezone,
  utcToWall,
  wallToFormatable,
  wallToUtc,
} from "@/lib/timezone"
import { useProfileMutation } from "@/lib/api-client"

export type UseTimezone = {
  /** Fuseau IANA d'affichage courant. */
  timezone: string
  /** Change le fuseau d'affichage + persiste la préférence profil (toast discret). */
  setTimezone: (tz: string) => void
  /** Instant UTC → Date « murale » dans le fuseau d'affichage. */
  toWall: (date: Date) => Date
  /** Date « murale » dans le fuseau d'affichage → instant UTC réel. */
  wallToUtcDate: (wall: Date) => Date
  /** Formate un instant UTC dans le fuseau d'affichage (date-fns, locale fr).
   *  Passe systématiquement par utcToWall + wallToFormatable. */
  fmt: (date: Date, pattern: string) => string
  /** Clé de jour « yyyy-MM-dd » d'un instant, dans le fuseau d'affichage. */
  dayKey: (date: Date) => string
}

export function useTimezone(): UseTimezone {
  const [timezone, setTimezoneState] = useState<string>(() => getBrowserTimezone())
  const { mutate: persistProfile } = useProfileMutation()

  const setTimezone = useCallback(
    (tz: string) => {
      if (!isValidTimezone(tz)) return
      setTimezoneState(tz)
      // Persistance fire-and-forget : l'affichage ne dépend jamais du serveur.
      persistProfile(
        { timezone: tz },
        {
          onSuccess: () =>
            toast.info("Fuseau horaire enregistré", {
              description: tz,
              duration: 2000,
            }),
          onError: (err) =>
            toast.error("Fuseau non enregistré", { description: err.message }),
        }
      )
    },
    [persistProfile]
  )

  const toWall = useCallback((date: Date) => utcToWall(date, timezone), [timezone])

  const wallToUtcDate = useCallback(
    (wall: Date) => wallToUtc(wall, timezone),
    [timezone]
  )

  const fmt = useCallback(
    (date: Date, pattern: string) =>
      format(wallToFormatable(utcToWall(date, timezone)), pattern, { locale: fr }),
    [timezone]
  )

  const dayKey = useCallback((date: Date) => dayKeyInTz(date, timezone), [timezone])

  return { timezone, setTimezone, toWall, wallToUtcDate, fmt, dayKey }
}
