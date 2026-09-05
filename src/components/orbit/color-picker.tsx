"use client"

// Orbit — Sélecteur de couleur (pastilles, contrôle sans état interne)
// ─────────────────────────────────────────────────────────────────────────────
// ~8 pastilles rondes + pastille « Auto » (value null → couleur automatique par
// source). Palette Orbit : cyan, orange, bleu nuit… + neutres fonctionnels.
// Cibles tactiles ≥ 44px, tooltips FR, aria-pressed sur la pastille active.

import { Sparkles } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const PALETTE: { hex: string; name: string }[] = [
  { hex: "#00D4FF", name: "Cyan" },
  { hex: "#FF6B35", name: "Orange" },
  { hex: "#0A2540", name: "Bleu nuit" },
  { hex: "#10B981", name: "Émeraude" },
  { hex: "#8B5CF6", name: "Violet" },
  { hex: "#F59E0B", name: "Ambre" },
  { hex: "#EF4444", name: "Rose" },
  { hex: "#14B8A6", name: "Sarcelle" },
]

export function ColorPicker({
  value,
  onChange,
  disabled,
  className,
}: {
  /** Couleur hex sélectionnée, ou null = « Auto » (couleur par source). */
  value: string | null
  onChange: (hex: string | null) => void
  disabled?: boolean
  className?: string
}) {
  return (
    <div
      role="group"
      aria-label="Couleur de l'événement"
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      {PALETTE.map((c) => {
        const selected = value === c.hex
        return (
          <Tooltip key={c.hex}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onChange(selected ? null : c.hex)}
                disabled={disabled}
                aria-pressed={selected}
                aria-label={`Couleur ${c.name}${selected ? " (sélectionnée)" : ""}`}
                title={c.name}
                className={cn(
                  "size-11 shrink-0 cursor-pointer rounded-full border-2 outline-none transition-shadow",
                  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  selected ? "border-primary" : "border-transparent"
                )}
                style={{ backgroundColor: c.hex }}
              >
                <span className="sr-only">{c.name}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>{c.name}</TooltipContent>
          </Tooltip>
        )
      })}

      {/* Pastille « Auto » : null = couleur automatique par source */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => onChange(null)}
            disabled={disabled}
            aria-pressed={value === null}
            aria-label="Couleur automatique (selon la source de l'événement)"
            title="Auto"
            className={cn(
              "flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border-2 outline-none transition-shadow",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              "disabled:cursor-not-allowed disabled:opacity-50",
              value === null
                ? "border-primary bg-primary/10 text-primary"
                : "border-dashed border-border bg-muted/50 text-muted-foreground"
            )}
          >
            <Sparkles className="size-4" aria-hidden />
            <span className="sr-only">Auto</span>
          </button>
        </TooltipTrigger>
        <TooltipContent>Auto</TooltipContent>
      </Tooltip>
    </div>
  )
}
