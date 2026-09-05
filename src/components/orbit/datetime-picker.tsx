"use client"

// Orbit — Saisie date + heure (chaînes MURALES, contrôlées)
// ─────────────────────────────────────────────────────────────────────────────
// Les valeurs sont des chaînes « murales » ("yyyy-MM-dd" / "HH:mm") dans le
// fuseau de RÉFÉRENCE de l'événement : le PARENT gère la conversion vers/depuis
// UTC (règle d'or — aucun fuseau n'est interprété ici, jamais de new Date(clé)).
// Deux Inputs (type="date" + type="time") sur une ligne en desktop.

import { useId } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

export function DateTimePicker({
  date,
  time,
  onDateChange,
  onTimeChange,
  label,
  inputId,
  error,
  disabled,
  timeDisabled,
  className,
}: {
  /** Date murale "yyyy-MM-dd". */
  date: string
  /** Heure murale "HH:mm". */
  time: string
  onDateChange: (date: string) => void
  onTimeChange: (time: string) => void
  /** Libellé visible lié à l'input date. */
  label: string
  /** Id de l'input date (pour un Label externe) ; auto-généré si absent. */
  inputId?: string
  /** Message d'erreur inline (aria-invalid + role="alert"). */
  error?: string
  disabled?: boolean
  /** Masque la saisie de l'heure (événements toute la journée). */
  timeDisabled?: boolean
  className?: string
}) {
  const autoId = useId()
  const dateId = inputId ?? `dtp-date-${autoId}`
  const timeId = `dtp-time-${autoId}`
  const invalid = Boolean(error)

  return (
    <div className={cn("space-y-2", className)}>
      <Label htmlFor={dateId}>{label}</Label>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
        <Input
          id={dateId}
          type="date"
          value={date}
          onChange={(e) => onDateChange(e.target.value)}
          disabled={disabled}
          required
          aria-invalid={invalid}
          aria-describedby={error ? `${dateId}-error` : undefined}
          className="h-11"
        />
        <Input
          id={timeId}
          type="time"
          value={time}
          onChange={(e) => onTimeChange(e.target.value)}
          disabled={disabled || timeDisabled}
          required={!timeDisabled}
          aria-label={`${label} — heure`}
          aria-invalid={invalid}
          aria-describedby={error ? `${dateId}-error` : undefined}
          className="h-11 sm:w-32"
        />
      </div>
      {error ? (
        <p id={`${dateId}-error`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  )
}
