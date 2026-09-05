"use client"

// Orbit — Sélecteur de fuseau horaire (contrôle, sans état interne)
// ─────────────────────────────────────────────────────────────────────────────
// Options : COMMON_TIMEZONES + le fuseau du navigateur (et la valeur courante)
// en tête si absents de la liste. Libellés via timezoneLabel() → « UTC+2 — Europe/Paris ».

import { useMemo } from "react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { COMMON_TIMEZONES, getBrowserTimezone, timezoneLabel } from "@/lib/timezone"
import { cn } from "@/lib/utils"

export function TimezoneSelector({
  value,
  onChange,
  id,
  disabled,
  className,
}: {
  /** Fuseau IANA sélectionné (ex. "Europe/Paris"). */
  value: string
  /** Notifié à chaque choix utilisateur. */
  onChange: (tz: string) => void
  /** Permet de lier un <Label htmlFor> externe au trigger. */
  id?: string
  disabled?: boolean
  className?: string
}) {
  const options = useMemo(() => {
    // Fuseau du navigateur (et valeur courante si exotique) en tête si absents.
    const extras = [getBrowserTimezone(), value].filter(
      (tz) => tz && !COMMON_TIMEZONES.includes(tz)
    )
    return [...new Set(extras), ...COMMON_TIMEZONES]
  }, [value])

  // timezoneLabel() calcule le décalage à un instant donné : on lui passe un
  // instant normalisé (millisecondes à zéro) pour éviter l'arrondi cosmétique
  // « +01:59 » dû à la troncature sous-seconde de formatToParts.
  const at = useMemo(() => {
    const d = new Date()
    d.setMilliseconds(0)
    return d
  }, [])

  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger
        id={id}
        // Cible tactile ≥ 44px, largeur pleine pour les libellés longs.
        className={cn("h-11 w-full", className)}
        aria-label="Fuseau horaire"
      >
        <SelectValue placeholder="Choisir un fuseau" />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {options.map((tz) => (
          <SelectItem key={tz} value={tz} className="py-2.5">
            <span className="text-sm">{timezoneLabel(tz, at)}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
