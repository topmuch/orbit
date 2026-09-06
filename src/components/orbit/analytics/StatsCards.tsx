"use client";

// Orbit — Analytique : 6 cartes de statistiques compactes (Task 20-c)
// ─────────────────────────────────────────────────────────────────────────────
// Task 21 : cartes passées au composant KpiCard multicolore (demande
// utilisateur — rose / orange / bleu / jaune, cyclé sur les 6 cartes).
// Toutes les chaînes passent par t() (domaine analytics.* + nav.calendar) ;
// l'intervalle de la semaine est une donnée formatée (date-fns + locale
// i18n), pas une chaîne littérale.

import { endOfWeek, format, startOfWeek } from "date-fns";
import { enGB, es, fr } from "date-fns/locale";
import type { Locale as DateFnsLocale } from "date-fns";
import { KpiCard, type KpiTone } from "@/components/orbit/kpi-card";
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

/** Cycle des tons multicolores sur les 6 cartes (4 tons demandés). */
const TONE_CYCLE: KpiTone[] = ["rose", "orange", "bleu", "jaune", "rose", "orange"];

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

  const [t1, t2, t3, t4, t5, t6] = TONE_CYCLE;

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-6">
      {/* Tâches terminées cette semaine */}
      <KpiCard
        tone={t1}
        icon={CheckCircle2}
        value={totals.completedThisWeek}
        label={t("analytics.completedWeek")}
        sub={t("analytics.thisWeek")}
      />

      {/* Tâches actives */}
      <KpiCard
        tone={t2}
        icon={ListTodo}
        value={totals.activeTasks}
        label={t("analytics.activeTasks")}
        sub={`${doingCount} ${t("analytics.inProgress")}`}
      />

      {/* En retard */}
      <KpiCard
        tone={t3}
        icon={AlarmClock}
        value={totals.overdue}
        label={t("analytics.overdue")}
        sub={t("analytics.overdueTasks")}
      />

      {/* Emails non lus */}
      <KpiCard
        tone={t4}
        icon={Mail}
        value={totals.unreadEmails}
        label={t("analytics.unread")}
        sub={t("analytics.unreadDesc")}
      />

      {/* Taux de complétion */}
      <KpiCard
        tone={t5}
        icon={Target}
        value={`${completionPct}%`}
        label={t("analytics.completionRate")}
        sub={t("analytics.completionRateDesc")}
      />

      {/* Événements de la semaine (calendrier) */}
      <KpiCard
        tone={t6}
        icon={CalendarDays}
        value={totals.eventsThisWeek}
        label={t("nav.calendar")}
        sub={weekRange}
      />
    </div>
  );
}
