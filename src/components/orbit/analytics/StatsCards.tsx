"use client";

// Orbit — Analytique : 6 cartes de statistiques compactes (Task 20-c)
// ─────────────────────────────────────────────────────────────────────────────
// Réplique exacte du style des cartes du dashboard (Card border-border/60
// bg-card/70 backdrop-blur-sm · CardContent p-4 · valeur 2xl tabular-nums) en
// version compacte 6 colonnes. Toutes les chaînes passent par t() (domaine
// analytics.* + nav.calendar) ; l'intervalle de la semaine est une donnée
// formatée (date-fns + locale i18n), pas une chaîne littérale.

import { endOfWeek, format, startOfWeek } from "date-fns";
import { enGB, es, fr } from "date-fns/locale";
import type { Locale as DateFnsLocale } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n/provider";
import type { AnalyticsDto } from "@/lib/analytics/types";
import {
  AlarmClock,
  CalendarDays,
  CheckCircle2,
  ListTodo,
  Mail,
  Target,
} from "lucide-react";

/** Locales date-fns statiques (synchrones, aucune dépendance réseau). */
const DATE_FNS_LOCALES: Record<string, DateFnsLocale> = { fr, en: enGB, es };

export function StatsCards({
  stats,
  isLoading,
}: {
  stats?: AnalyticsDto;
  isLoading: boolean;
}) {
  const { t, locale } = useI18n();
  const dateLocale = DATE_FNS_LOCALES[locale] ?? fr;

  if (isLoading || !stats) {
    return (
      <div
        className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-6"
        role="status"
        aria-busy="true"
        aria-label={t("analytics.sectionTitle")}
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
    );
  }

  const totals = stats.totals;
  const doingCount = stats.byStatus.find((s) => s.status === "doing")?.count ?? 0;
  const completionPct = Math.round(totals.completionRate * 100);

  // Intervalle de la semaine courante (donnée formatée — lundi → dimanche)
  const now = new Date();
  const weekRange = `${format(startOfWeek(now, { weekStartsOn: 1 }), "d MMM", {
    locale: dateLocale,
  })} – ${format(endOfWeek(now, { weekStartsOn: 1 }), "d MMM", {
    locale: dateLocale,
  })}`;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-6">
      {/* Tâches terminées cette semaine */}
      <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-2">
            <CheckCircle2 className="size-5 shrink-0 text-teal-500" aria-hidden />
            <span className="text-2xl font-semibold tabular-nums">
              {totals.completedThisWeek}
            </span>
          </div>
          <p className="mt-2 truncate text-sm font-medium">
            {t("analytics.completedWeek")}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {t("analytics.thisWeek")}
          </p>
        </CardContent>
      </Card>

      {/* Tâches actives */}
      <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-2">
            <ListTodo className="size-5 shrink-0 text-emerald-500" aria-hidden />
            <span className="text-2xl font-semibold tabular-nums">
              {totals.activeTasks}
            </span>
          </div>
          <p className="mt-2 truncate text-sm font-medium">
            {t("analytics.activeTasks")}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {doingCount} {t("analytics.inProgress")}
          </p>
        </CardContent>
      </Card>

      {/* En retard */}
      <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-2">
            <AlarmClock className="size-5 shrink-0 text-red-500" aria-hidden />
            <span className="text-2xl font-semibold tabular-nums text-red-500">
              {totals.overdue}
            </span>
          </div>
          <p className="mt-2 truncate text-sm font-medium">{t("analytics.overdue")}</p>
          <p className="truncate text-xs text-muted-foreground">
            {t("analytics.overdueTasks")}
          </p>
        </CardContent>
      </Card>

      {/* Emails non lus */}
      <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-2">
            <Mail className="size-5 shrink-0 text-violet-500" aria-hidden />
            <span className="text-2xl font-semibold tabular-nums">
              {totals.unreadEmails}
            </span>
          </div>
          <p className="mt-2 truncate text-sm font-medium">{t("analytics.unread")}</p>
          <p className="truncate text-xs text-muted-foreground">
            {t("analytics.unreadDesc")}
          </p>
        </CardContent>
      </Card>

      {/* Taux de complétion */}
      <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-2">
            <Target className="size-5 shrink-0 text-primary" aria-hidden />
            <span className="text-2xl font-semibold tabular-nums">
              {completionPct}%
            </span>
          </div>
          <p className="mt-2 truncate text-sm font-medium">
            {t("analytics.completionRate")}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {t("analytics.completionRateDesc")}
          </p>
        </CardContent>
      </Card>

      {/* Événements de la semaine (calendrier) */}
      <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
        <CardContent className="p-4">
          <div className="flex items-center justify-between gap-2">
            <CalendarDays className="size-5 shrink-0 text-primary" aria-hidden />
            <span className="text-2xl font-semibold tabular-nums">
              {totals.eventsThisWeek}
            </span>
          </div>
          <p className="mt-2 truncate text-sm font-medium">{t("nav.calendar")}</p>
          <p className="truncate text-xs text-muted-foreground">{weekRange}</p>
        </CardContent>
      </Card>
    </div>
  );
}
