"use client";

// Orbit — Carte KPI multicolore (demande utilisateur : dashboard avec
// sidebar rose foncé + KPI en rose / orange / bleu / jaune).
// ─────────────────────────────────────────────────────────────────────────────
// Structure unique pour les 4 tons : dégradé diagonal (coin clair → extrémité
// sombre), pastille d'icône translucide, grande valeur tabulaire, libellé et
// sous-libellé. Contraste garanti dans les DEUX thèmes : texte blanc sur les
// dégradés saturés (les libellés reposent sur la zone sombre du dégradé,
// ≥ 4.5:1 sur rose-700 / orange-700 / blue-700), texte ambre très foncé sur
// le jaune. Le bleu est explicitement demandé par l'utilisateur ici.
// Le composant est volontairement sans aucune chaîne visible (label/sub sont
// des ReactNode fournis par l'appelant, déjà i18n-és en amont).

import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

export type KpiTone = "rose" | "orange" | "bleu" | "jaune";

const TONES: Record<
  KpiTone,
  { card: string; chip: string; icon: string; value: string; sub: string }
> = {
  rose: {
    card: "border-white/20 bg-gradient-to-br from-pink-500 via-rose-600 to-rose-700 text-white shadow-lg shadow-rose-600/30",
    chip: "bg-white/25",
    icon: "text-white",
    value: "text-white",
    sub: "text-rose-100",
  },
  orange: {
    card: "border-white/20 bg-gradient-to-br from-orange-400 via-orange-600 to-orange-700 text-white shadow-lg shadow-orange-600/30",
    chip: "bg-white/25",
    icon: "text-white",
    value: "text-white",
    sub: "text-orange-50",
  },
  bleu: {
    card: "border-white/20 bg-gradient-to-br from-sky-400 via-blue-600 to-blue-700 text-white shadow-lg shadow-blue-600/30",
    chip: "bg-white/25",
    icon: "text-white",
    value: "text-white",
    sub: "text-sky-50",
  },
  jaune: {
    card: "border-black/10 bg-gradient-to-br from-yellow-300 via-amber-300 to-amber-400 text-amber-950 shadow-lg shadow-amber-400/40",
    chip: "bg-black/10",
    icon: "text-amber-900",
    value: "text-amber-950",
    sub: "text-amber-900/80",
  },
};

export function KpiCard({
  tone,
  icon: Icon,
  value,
  label,
  sub,
  className,
}: {
  /** Ton de fond (multicolore rose / orange / bleu / jaune). */
  tone: KpiTone;
  icon: LucideIcon;
  /** Grande valeur chiffrée (nombre ou % déjà formaté). */
  value: React.ReactNode;
  /** Libellé principal (déjà traduit par l'appelant). */
  label: React.ReactNode;
  /** Sous-libellé optionnel — fragments React acceptés. */
  sub?: React.ReactNode;
  className?: string;
}) {
  const t = TONES[tone];
  return (
    <Card className={cn(t.card, className)}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-lg",
              t.chip
            )}
          >
            <Icon className={cn("size-5", t.icon)} aria-hidden />
          </span>
          <span
            className={cn(
              "text-2xl font-semibold tabular-nums sm:text-3xl",
              t.value
            )}
          >
            {value}
          </span>
        </div>
        <p className="mt-2.5 truncate text-sm font-medium">{label}</p>
        {sub != null ? (
          <p className={cn("truncate text-xs", t.sub)}>{sub}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
