"use client";

// Orbit — Analytique : graphiques Recharts du dashboard (Task 20-c)
// ─────────────────────────────────────────────────────────────────────────────
// 4 cartes sur une grille lg:grid-cols-3 :
//   • Productivité 14 j (AreaChart, gradient cyan, lg:col-span-2)
//   • Répartition par statut (PieChart donut + légende custom)
//   • Tâches par priorité (BarChart, 4 Cell colorées)
//   • Emails reçus 14 j (AreaChart violet #8b5cf6 — cohérent avec les badges
//     violets de la vue emails ; bleu/indigo interdits, violet autorisé)
//
// COULEURS : les tokens du projet sont des HEX dans globals.css (--chart-N)
// → fill/stroke="var(--chart-N)" (JAMAIS hsl(var(--chart-N))). Les axes et
// grilles passent par des classes CSS wrapper (copiées de ui/chart.tsx) pour
// rester lisibles en clair ET en sombre.
//
// JOURS : le serveur renvoie des clés "yyyy-MM-dd" + label "MM-dd" ; le client
// reconstruit le jour de semaine localisé via date-fns + locale i18n
// (imports STATIQUES, synchrones — pas d'await dans le rendu). parseISO
// interprète "yyyy-MM-dd" comme minuit LOCAL → aucun décalage de fuseau sur
// les champs calendaires.

import { useMemo, type ReactNode } from "react";
import { format, parseISO } from "date-fns";
import { enGB, es, fr } from "date-fns/locale";
import type { Locale as DateFnsLocale } from "date-fns";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n/provider";
import type {
  AnalyticsDto,
  AnalyticsPriority,
  AnalyticsStatus,
} from "@/lib/analytics/types";

// ─── Locales & couleurs ───────────────────────────────────────────────────────

const DATE_FNS_LOCALES: Record<string, DateFnsLocale> = { fr, en: enGB, es };

/** Violet (pas un token chart) — assumé, cf. commentaires d'en-tête. */
const EMAILS_COLOR = "#8b5cf6";

const STATUS_COLORS: Record<AnalyticsStatus, string> = {
  todo: "var(--chart-1)",
  doing: "var(--chart-2)",
  done: "var(--chart-4)",
};
const STATUS_LABEL_KEYS: Record<AnalyticsStatus, string> = {
  todo: "analytics.statusTodo",
  doing: "analytics.statusDoing",
  done: "analytics.statusDone",
};

/** Intensité croissante avec la priorité (gris → cyan pâle → cyan → orange). */
const PRIORITY_COLORS: Record<AnalyticsPriority, string> = {
  LOW: "var(--chart-5)",
  MEDIUM: "var(--chart-4)",
  HIGH: "var(--chart-1)",
  URGENT: "var(--chart-2)",
};
const PRIORITY_LABEL_KEYS: Record<AnalyticsPriority, string> = {
  LOW: "analytics.priorityLow",
  MEDIUM: "analytics.priorityMedium",
  HIGH: "analytics.priorityHigh",
  URGENT: "analytics.priorityUrgent",
};

/**
 * Classes wrapper recharts (reprises de ui/chart.tsx) : ticks en
 * muted-foreground, grille pointillée colorée comme border, curseurs de
 * tooltip discrets, focus/outline supprimés — valables clair + sombre.
 */
const CHART_CLASSES =
  "[&_.recharts-cartesian-axis-tick_text]:fill-muted-foreground [&_.recharts-cartesian-grid_line[stroke='#ccc']]:stroke-border/50 [&_.recharts-curve.recharts-tooltip-cursor]:stroke-border [&_.recharts-rectangle.recharts-tooltip-cursor]:fill-muted [&_.recharts-sector[stroke='#fff']]:stroke-transparent [&_.recharts-layer]:outline-hidden [&_.recharts-sector]:outline-hidden [&_.recharts-surface]:outline-hidden";

// ─── Types locaux des séries ──────────────────────────────────────────────────

/** Point des séries 14 jours (libellé de jour reconstruit côté client). */
type DayPoint = { date: string; label: string; day: string; value: number };
type StatusPoint = { status: AnalyticsStatus; count: number };
type PriorityPoint = { priority: AnalyticsPriority; count: number; label: string };

/** Singulier/pluriel simple (fr/en/es pluriels réguliers en -s). */
function withUnit(n: number, pluralWord: string): string {
  return `${n} ${n === 1 ? pluralWord.replace(/s$/, "") : pluralWord}`;
}

function tooltipShell(color: string, label: string, value: ReactNode) {
  return (
    <div className="grid min-w-[10rem] gap-1.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <p className="font-medium">{label}</p>
      <p className="flex items-center gap-1.5">
        <span
          className="size-2 shrink-0 rounded-[2px]"
          style={{ backgroundColor: color }}
          aria-hidden
        />
        <span className="text-muted-foreground">{value}</span>
      </p>
    </div>
  );
}

// ─── Tooltips (composants clients : hooks i18n autorisés) ────────────────────

type DayTooltipProps = TooltipProps<number, string> & {
  /** Clé i18n de l'unité comptée (« tâches » / « emails »). */
  unitKey: string;
  /** Couleur de la série (dot du tooltip). */
  color: string;
};

function DayTooltip({ active, payload, unitKey, color }: DayTooltipProps) {
  const { t, locale } = useI18n();
  if (!active || !payload?.length) return null;
  const datum = payload[0]?.payload as DayPoint | undefined;
  if (!datum) return null;
  const dateLocale = DATE_FNS_LOCALES[locale] ?? fr;
  const fullDate = format(parseISO(datum.date), "EEEE d MMMM", {
    locale: dateLocale,
  });
  return tooltipShell(color, fullDate, withUnit(datum.value, t(unitKey)));
}

function StatusTooltip({ active, payload }: TooltipProps<number, string>) {
  const { t } = useI18n();
  if (!active || !payload?.length) return null;
  const datum = payload[0]?.payload as StatusPoint | undefined;
  if (!datum) return null;
  return tooltipShell(
    STATUS_COLORS[datum.status],
    t(STATUS_LABEL_KEYS[datum.status]),
    withUnit(datum.count, t("analytics.tasks"))
  );
}

function PriorityTooltip({ active, payload }: TooltipProps<number, string>) {
  const { t } = useI18n();
  if (!active || !payload?.length) return null;
  const datum = payload[0]?.payload as PriorityPoint | undefined;
  if (!datum) return null;
  return tooltipShell(
    PRIORITY_COLORS[datum.priority],
    t(PRIORITY_LABEL_KEYS[datum.priority]),
    withUnit(datum.count, t("analytics.tasks"))
  );
}

// ─── Composant principal ─────────────────────────────────────────────────────

export function DashboardCharts({
  stats,
  isLoading,
}: {
  stats?: AnalyticsDto;
  isLoading: boolean;
}) {
  const { t, locale } = useI18n();
  const dateLocale = DATE_FNS_LOCALES[locale] ?? fr;

  // Séries clients : libellés de jours localisés (« sam 14 ») reconstruits
  // depuis les clés yyyy-MM-dd du serveur.
  const productivityData = useMemo<DayPoint[]>(
    () =>
      (stats?.productivity ?? []).map((p) => ({
        date: p.date,
        label: p.label,
        day: format(parseISO(p.date), "EEE d", { locale: dateLocale }),
        value: p.completed,
      })),
    [stats, dateLocale]
  );

  const emailsData = useMemo<DayPoint[]>(
    () =>
      (stats?.emailsPerDay ?? []).map((e) => ({
        date: e.date,
        label: e.label,
        day: format(parseISO(e.date), "EEE d", { locale: dateLocale }),
        value: e.count,
      })),
    [stats, dateLocale]
  );

  const statusData = useMemo<StatusPoint[]>(
    () => stats?.byStatus ?? [],
    [stats]
  );

  const priorityData = useMemo<PriorityPoint[]>(
    () =>
      (stats?.byPriority ?? []).map((p) => ({
        priority: p.priority,
        count: p.count,
        label: t(PRIORITY_LABEL_KEYS[p.priority]),
      })),
    [stats, t]
  );

  const hasProductivity = productivityData.some((d) => d.value > 0);
  const hasEmails = emailsData.some((d) => d.value > 0);
  const statusTotal = statusData.reduce((sum, s) => sum + s.count, 0);
  const priorityTotal = priorityData.reduce((sum, p) => sum + p.count, 0);

  const statusAria = statusData
    .map((s) => `${s.count} ${t(STATUS_LABEL_KEYS[s.status])}`)
    .join(", ");
  const priorityAria = priorityData
    .map((p) => `${p.count} ${t(PRIORITY_LABEL_KEYS[p.priority])}`)
    .join(", ");

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {/* ── Productivité (14 jours) — grande carte ── */}
      <Card className="border-border/60 bg-card/70 backdrop-blur-sm lg:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-medium">
            {t("analytics.productivity")}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {t("analytics.productivityDesc")}
          </p>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-[260px] w-full" />
          ) : !hasProductivity ? (
            <div className="flex h-[260px] items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {t("analytics.productivityEmpty")}
            </div>
          ) : (
            <div
              role="img"
              aria-label={`${t("analytics.productivity")} — ${t("analytics.productivityDesc")}`}
              className={cn("h-[260px] w-full", CHART_CLASSES)}
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={productivityData}
                  margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
                >
                  <defs>
                    <linearGradient id="orbitProdGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="day"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tick={{ fontSize: 11 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    allowDecimals={false}
                    width={28}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                  />
                  <Tooltip
                    content={
                      <DayTooltip
                        unitKey="analytics.tasks"
                        color="var(--chart-1)"
                      />
                    }
                  />
                  <Area
                    dataKey="value"
                    stroke="var(--chart-1)"
                    strokeWidth={2}
                    fill="url(#orbitProdGradient)"
                    type="monotone"
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 0 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Répartition par statut — donut ── */}
      <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-medium">
            {t("analytics.statusDistribution")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-[220px] w-full" />
          ) : statusTotal === 0 ? (
            <div className="flex h-[220px] items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {t("analytics.noData")}
            </div>
          ) : (
            <>
              <div
                role="img"
                aria-label={`${t("analytics.statusDistribution")} : ${statusAria}`}
                className={cn("h-[220px] w-full", CHART_CLASSES)}
              >
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Tooltip content={<StatusTooltip />} />
                    <Pie
                      data={statusData}
                      dataKey="count"
                      nameKey="status"
                      innerRadius={55}
                      outerRadius={85}
                      paddingAngle={4}
                      strokeWidth={0}
                    >
                      {statusData.map((s) => (
                        <Cell key={s.status} fill={STATUS_COLORS[s.status]} />
                      ))}
                    </Pie>
                  </PieChart>
                </ResponsiveContainer>
              </div>
              {/* Légende custom : points colorés + libellé + compteur */}
              <div className="mt-1 flex flex-wrap items-center justify-center gap-x-4 gap-y-1.5">
                {statusData.map((s) => (
                  <span
                    key={s.status}
                    className="flex items-center gap-1.5 text-xs text-muted-foreground"
                  >
                    <span
                      className="size-2 shrink-0 rounded-[2px]"
                      style={{ backgroundColor: STATUS_COLORS[s.status] }}
                      aria-hidden
                    />
                    {t(STATUS_LABEL_KEYS[s.status])}
                    <span className="font-medium tabular-nums text-foreground">
                      {s.count}
                    </span>
                  </span>
                ))}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* ── Tâches par priorité — barres ── */}
      <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-medium">
            {t("analytics.priorityDistribution")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-[220px] w-full" />
          ) : priorityTotal === 0 ? (
            <div className="flex h-[220px] items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {t("analytics.noData")}
            </div>
          ) : (
            <div
              role="img"
              aria-label={`${t("analytics.priorityDistribution")} : ${priorityAria}`}
              className={cn("h-[220px] w-full", CHART_CLASSES)}
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={priorityData}
                  margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                >
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tick={{ fontSize: 11 }}
                  />
                  <YAxis
                    allowDecimals={false}
                    width={28}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                  />
                  <Tooltip content={<PriorityTooltip />} />
                  <Bar dataKey="count" radius={[4, 4, 0, 0]} maxBarSize={44}>
                    {priorityData.map((p) => (
                      <Cell key={p.priority} fill={PRIORITY_COLORS[p.priority]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Emails reçus (14 jours) — pleine largeur relative (2/3) ── */}
      {/* lg:col-span-2 (et non 3) : 4 cartes sur 3 colonnes → col-span-3
          laisserait la carte « priorités » seule avec 2 colonnes vides ;
          [2|1] + [1|2] forme une grille dense sans trou. */}
      <Card className="border-border/60 bg-card/70 backdrop-blur-sm lg:col-span-2">
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-medium">
            {t("analytics.emailsTrend")}
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            {t("analytics.emailsTrendDesc")}
          </p>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-[220px] w-full" />
          ) : !hasEmails ? (
            <div className="flex h-[220px] items-center justify-center px-6 text-center text-sm text-muted-foreground">
              {t("analytics.noData")}
            </div>
          ) : (
            <div
              role="img"
              aria-label={`${t("analytics.emailsTrend")} — ${t("analytics.emailsTrendDesc")}`}
              className={cn("h-[220px] w-full", CHART_CLASSES)}
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart
                  data={emailsData}
                  margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
                >
                  <defs>
                    <linearGradient id="orbitEmailsGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={EMAILS_COLOR} stopOpacity={0.25} />
                      <stop offset="100%" stopColor={EMAILS_COLOR} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis
                    dataKey="day"
                    tickLine={false}
                    axisLine={false}
                    tickMargin={8}
                    tick={{ fontSize: 11 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    allowDecimals={false}
                    width={28}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11 }}
                  />
                  <Tooltip
                    content={
                      <DayTooltip unitKey="analytics.emailsCount" color={EMAILS_COLOR} />
                    }
                  />
                  <Area
                    dataKey="value"
                    stroke={EMAILS_COLOR}
                    strokeWidth={2}
                    fill="url(#orbitEmailsGradient)"
                    type="monotone"
                    dot={false}
                    activeDot={{ r: 4, strokeWidth: 0 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
