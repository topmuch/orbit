"use client";

// Orbit — Palette de commandes (Ctrl+K) façon Raycast/Spotlight
// ─────────────────────────────────────────────────────────────────────────────
// Composant auto-contenu : s'ouvre à l'écoute de l'événement window
// OPEN_COMMAND_PALETTE_EVENT (dispatché par le hook global des raccourcis ou
// par le bouton du header) — AUCUN listener clavier propre ici.
// Recherche full-text débouncée sur GET /api/search (≥ 2 caractères, 250 ms,
// anti-course via compteur de requêtes) + actions rapides, navigation,
// apparence et langue. Le groupe « Résultats » est forceMount (cmdk) : le
// filtrage flou local n'occulterait pas des résultats pertinents renvoyés par
// le serveur (FTS insensible aux accents, correspondances hors titre…).

import { useCallback, useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import {
  Bot,
  CalendarDays,
  Check,
  KanbanSquare,
  LayoutDashboard,
  Mail,
  Monitor,
  Moon,
  Plus,
  Settings,
  Sparkles,
  Sun,
  type LucideIcon,
} from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { useI18n } from "@/lib/i18n/provider";
import {
  localeFlags,
  localeSelfNames,
  locales,
  type Locale,
} from "@/lib/i18n/config";
import type { OrbitView } from "@/lib/types";
import { OPEN_COMMAND_PALETTE_EVENT, useUiIntent } from "@/lib/ui-intent";

/** Résultat de recherche full-text (miroir local de GET /api/search). */
interface SearchResultItem {
  id: string;
  type: "event" | "task" | "email";
  title: string;
  /** HTML sûr produit côté serveur : contenu échappé + <mark> de surlignage. */
  snippet: string;
  date: string | null;
  view: "calendar" | "tasks" | "emails";
}

interface SearchResponse {
  results: SearchResultItem[];
  totalHits: number;
  processingTimeMs: number;
  engine: string;
}

/** Métadonnées de la dernière recherche (pied de palette). */
interface SearchMeta {
  processingTimeMs: number;
  engine: string;
}

const NAV_ITEMS: ReadonlyArray<{
  view: OrbitView;
  icon: LucideIcon;
  labelKey: string;
}> = [
  { view: "dashboard", icon: LayoutDashboard, labelKey: "nav.dashboard" },
  { view: "calendar", icon: CalendarDays, labelKey: "nav.calendar" },
  { view: "tasks", icon: KanbanSquare, labelKey: "nav.tasks" },
  { view: "emails", icon: Mail, labelKey: "nav.emails" },
  { view: "assistant", icon: Bot, labelKey: "nav.assistant" },
  { view: "settings", icon: Settings, labelKey: "nav.settings" },
];

const KBD_CLASS = "rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]";

export function CommandPalette({
  onNavigate,
}: {
  onNavigate: (view: OrbitView, emailId?: string) => void;
}) {
  const { locale, setLocale, t } = useI18n();
  const { theme, setTheme } = useTheme();
  const requestNew = useUiIntent((state) => state.requestNew);

  const [open, setOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [meta, setMeta] = useState<SearchMeta | null>(null);
  /** Requête (trimée) ayant produit `results` — pilotée par la réponse réseau. */
  const [searchedQuery, setSearchedQuery] = useState("");

  const trimmedQuery = searchQuery.trim();
  const hasActiveQuery = trimmedQuery.length >= 2;

  /** true pendant le debounce + l'appel réseau (aucune réponse pour ce query). */
  const isSearching = hasActiveQuery && searchedQuery !== trimmedQuery;
  /** Résultats affichables : uniquement s'ils correspondent au query courant. */
  const visibleResults =
    hasActiveQuery && searchedQuery === trimmedQuery ? results : [];

  /** Compteur de requêtes : toute réponse arrivée hors ordre est ignorée. */
  const requestSeq = useRef(0);

  // Ouverture par événement window (raccourci global, bouton header…).
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
    return () => window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, onOpen);
  }, []);

  // Recherche full-text débouncée : 250 ms, déclenchée à partir de 2 caractères.
  // Aucun setState synchrone dans le corps de l'effet (règle set-state-in-effect) :
  // isSearching/visibleResults sont dérivés de searchedQuery, mis à jour
  // uniquement dans les callbacks asynchrones (timer + fetch).
  useEffect(() => {
    const query = searchQuery.trim();
    if (query.length < 2) return;
    const seq = requestSeq.current;
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(query)}&limit=8`)
        .then(async (res) => {
          if (!res.ok) throw new Error(`search failed (${res.status})`);
          return (await res.json()) as SearchResponse;
        })
        .then((data) => {
          if (requestSeq.current !== seq) return; // réponse obsolète
          setResults(data.results);
          setMeta({
            processingTimeMs: data.processingTimeMs,
            engine: data.engine,
          });
          setSearchedQuery(query);
        })
        .catch(() => {
          if (requestSeq.current !== seq) return; // réponse obsolète
          setResults([]);
          setMeta(null);
          setSearchedQuery(query);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      requestSeq.current += 1; // invalide toute réponse encore en vol
    };
  }, [searchQuery]);

  /** Réinitialise le champ et les résultats (fermeture / action exécutée). */
  const resetQuery = useCallback(() => {
    setSearchQuery("");
    setResults([]);
    setMeta(null);
    setSearchedQuery("");
  }, []);

  /** Exécute une action de la palette : ferme, réinitialise, puis exécute. */
  const run = useCallback(
    (action: () => void) => {
      setOpen(false);
      resetQuery();
      action();
    },
    [resetQuery]
  );

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) resetQuery();
    },
    [resetQuery]
  );

  /** Icône + couleur de marque par type de résultat (cyan/orange/émeraude). */
  const resultIcon = (type: SearchResultItem["type"]) => {
    const Icon: LucideIcon =
      type === "event" ? CalendarDays : type === "task" ? KanbanSquare : Mail;
    const className =
      type === "event"
        ? "text-primary"
        : type === "task"
          ? "text-orange-500"
          : "text-emerald-500";
    return <Icon className={className} aria-hidden="true" />;
  };

  const typeLabel = (type: SearchResultItem["type"]): string =>
    type === "event"
      ? t("search.events")
      : type === "task"
        ? t("search.tasks")
        : t("search.emails");

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={t("command.title")}
      description={t("command.searchButton")}
      showCloseButton={false}
      className="sm:max-w-xl"
    >
      <CommandInput
        placeholder={t("command.placeholder")}
        value={searchQuery}
        onValueChange={setSearchQuery}
      />

      <CommandList className="max-h-[min(420px,60vh)]">
        {/* Empty masqué pendant l'affichage de résultats (forceMount ne
            décrémente pas le compteur de cmdk). */}
        {visibleResults.length === 0 && (
          <CommandEmpty>
            {isSearching ? t("command.searching") : t("command.noResults")}
          </CommandEmpty>
        )}

        {visibleResults.length > 0 && (
          <CommandGroup forceMount heading={t("command.results")}>
            {visibleResults.map((result) => (
              <CommandItem
                key={`${result.type}-${result.id}`}
                value={`${result.type}:${result.id}`}
                onSelect={() =>
                  run(() =>
                    onNavigate(
                      result.view,
                      result.type === "email" ? result.id : undefined
                    )
                  )
                }
              >
                {resultIcon(result.type)}
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{result.title}</div>
                  <div
                    className="truncate text-xs text-muted-foreground [&_mark]:bg-transparent [&_mark]:font-medium [&_mark]:text-primary"
                    dangerouslySetInnerHTML={{ __html: result.snippet }}
                  />
                </div>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground capitalize">
                  {typeLabel(result.type)}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        <CommandSeparator />

        <CommandGroup heading={t("command.quickActions")}>
          <CommandItem
            onSelect={() =>
              run(() => {
                requestNew("event");
                onNavigate("calendar");
              })
            }
          >
            <Plus />
            <span>{t("command.newEvent")}</span>
            <CommandShortcut>Ctrl N</CommandShortcut>
          </CommandItem>
          <CommandItem
            onSelect={() =>
              run(() => {
                requestNew("task");
                onNavigate("tasks");
              })
            }
          >
            <Plus />
            <span>{t("command.newTask")}</span>
            <CommandShortcut>Ctrl T</CommandShortcut>
          </CommandItem>
          <CommandItem
            onSelect={() =>
              run(() => {
                requestNew("email");
                onNavigate("emails");
              })
            }
          >
            <Plus />
            <span>{t("command.newEmail")}</span>
            <CommandShortcut>Ctrl E</CommandShortcut>
          </CommandItem>
          <CommandItem onSelect={() => run(() => onNavigate("assistant"))}>
            <Sparkles />
            <span>{t("command.aiAssistant")}</span>
          </CommandItem>
        </CommandGroup>

        <CommandGroup heading={t("command.navigation")}>
          {NAV_ITEMS.map((item) => (
            <CommandItem
              key={item.view}
              onSelect={() => run(() => onNavigate(item.view))}
            >
              <item.icon aria-hidden="true" />
              <span>{t(item.labelKey)}</span>
            </CommandItem>
          ))}
        </CommandGroup>

        <CommandGroup heading={t("command.appearance")}>
          <CommandItem onSelect={() => run(() => setTheme("light"))}>
            <Sun aria-hidden="true" />
            <span>{t("command.lightMode")}</span>
            {theme === "light" && (
              <Check className="ml-auto size-4 text-primary" aria-hidden="true" />
            )}
          </CommandItem>
          <CommandItem onSelect={() => run(() => setTheme("dark"))}>
            <Moon aria-hidden="true" />
            <span>{t("command.darkMode")}</span>
            {theme === "dark" && (
              <Check className="ml-auto size-4 text-primary" aria-hidden="true" />
            )}
          </CommandItem>
          <CommandItem onSelect={() => run(() => setTheme("system"))}>
            <Monitor aria-hidden="true" />
            <span>{t("command.systemMode")}</span>
            {theme === "system" && (
              <Check className="ml-auto size-4 text-primary" aria-hidden="true" />
            )}
          </CommandItem>
        </CommandGroup>

        <CommandGroup heading={t("command.language")}>
          {locales.map((lang: Locale) => (
            <CommandItem
              key={lang}
              value={`locale:${lang}`}
              onSelect={() => run(() => setLocale(lang))}
            >
              <span
                aria-hidden="true"
                className="text-base leading-none"
              >
                {localeFlags[lang]}
              </span>
              <span>{localeSelfNames[lang]}</span>
              {locale === lang && (
                <Check className="ml-auto size-4 text-primary" aria-hidden="true" />
              )}
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>

      {/* Pied de palette : rappels clavier + métriques de la dernière recherche */}
      <div className="flex items-center gap-2 border-t px-3 py-2 text-xs text-muted-foreground">
        <kbd className={KBD_CLASS}>↑↓</kbd>
        <span>{t("command.navigateHint")}</span>
        <span aria-hidden="true" className="opacity-50">·</span>
        <kbd className={KBD_CLASS}>↵</kbd>
        <span>{t("command.selectHint")}</span>
        <span aria-hidden="true" className="opacity-50">·</span>
        <kbd className={KBD_CLASS}>esc</kbd>
        <span>{t("command.closeHint")}</span>
        {meta && visibleResults.length > 0 ? (
          <span className="ml-auto shrink-0 tabular-nums">
            {meta.processingTimeMs} ms · {meta.engine}
          </span>
        ) : null}
      </div>
    </CommandDialog>
  );
}
