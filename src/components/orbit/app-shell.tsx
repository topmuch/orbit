"use client";

// Orbit — Shell applicatif : sidebar desktop + bottom nav mobile + header
// Features avancées : i18n (nav/titres), palette de commandes, raccourcis
// clavier globaux, bascule de thème système, bouton recherche (Ctrl+K).

import { useEffect, useRef } from "react"
import { format } from "date-fns"
import { fr, enGB, es } from "date-fns/locale"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { OrbitLogo } from "@/components/orbit/logo"
import { NotificationCenter } from "@/components/orbit/notifications-center"
import { SyncStatusBadge } from "@/components/offline/SyncStatusBadge"
import { OfflineBanner } from "@/components/offline/OfflineBanner"
import { ThemeToggle } from "@/components/theme/ThemeToggle"
import { CommandPalette } from "@/components/command/CommandPalette"
import { ShortcutHelpModal } from "@/components/shortcuts/ShortcutHelpModal"
import { useKeyboardShortcuts } from "@/lib/shortcuts/useKeyboardShortcuts"
import { openCommandPalette } from "@/lib/ui-intent"
import { useI18n } from "@/lib/i18n/provider"
import { useEmails } from "@/lib/api-client"
import { usePwaStore } from "@/lib/pwa-store"
import { promptInstall } from "@/components/orbit/pwa-register"
import type { OrbitView, SessionUser } from "@/lib/types"
import {
  LayoutDashboard,
  CalendarDays,
  KanbanSquare,
  Mail,
  Bot,
  Settings,
  LogOut,
  Download,
  Search,
} from "lucide-react"

const NAV: { view: OrbitView; icon: React.ElementType }[] = [
  { view: "dashboard", icon: LayoutDashboard },
  { view: "calendar", icon: CalendarDays },
  { view: "tasks", icon: KanbanSquare },
  { view: "emails", icon: Mail },
  { view: "assistant", icon: Bot },
  { view: "settings", icon: Settings },
]

/** Locale date-fns de la langue UI courante. */
const DATE_LOCALES = { fr, en: enGB, es } as const

export function AppShell({
  user,
  view,
  onNavigate,
  onLogout,
  children,
}: {
  user: SessionUser
  view: OrbitView
  /** Navigation SPA — élargie (emailId) pour la palette de commandes. */
  onNavigate: (view: OrbitView, emailId?: string) => void
  onLogout: () => void
  children: React.ReactNode
}) {
  const { data: emailsData } = useEmails()
  const { canInstall, installed } = usePwaStore()
  const { t, locale } = useI18n()

  // Raccourcis clavier globaux (Ctrl+K palette, Ctrl+N/T/E créations,
  // Ctrl+1..6 vues, ? aide, / recherche). Monté une seule fois dans le shell.
  useKeyboardShortcuts({ onNavigate })

  // Deep link depuis une notification OS : le Service Worker (v3) poste
  // { orbit: "navigate", view, … } quand l'utilisateur clique une notif
  // pendant que l'app est ouverte (navigation SPA, sans rechargement).
  const onNavigateRef = useRef(onNavigate)
  useEffect(() => {
    onNavigateRef.current = onNavigate
  }, [onNavigate])
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return
    const handler = (event: MessageEvent) => {
      const data = event.data as { orbit?: string; view?: OrbitView } | null
      if (data?.orbit === "navigate" && data.view) {
        onNavigateRef.current(data.view)
      }
    }
    navigator.serviceWorker.addEventListener("message", handler)
    return () => navigator.serviceWorker.removeEventListener("message", handler)
  }, [])

  const unread = (emailsData?.emails ?? []).filter((e) => !e.isRead).length
  const initials = (user.name ?? user.email)
    .split(/[\s@.]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase())
    .join("")

  return (
    <div className="flex min-h-screen">
      {/* ---------- Sidebar (desktop) — rose foncé (demande utilisateur 21) ---------- */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-white/10 bg-gradient-to-b from-pink-800 via-rose-900 to-rose-950 lg:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <OrbitLogo size={34} />
          <div className="leading-tight">
            <p className="text-base font-semibold tracking-tight text-white">Orbit</p>
            <p className="text-[11px] text-pink-200/80">{t("nav.personalOs")}</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3" aria-label={t("nav.mainNav")}>
          {NAV.map(({ view: v, icon: Icon }) => {
            const active = view === v
            return (
              <button
                key={v}
                onClick={() => onNavigate(v)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-white/15 text-white"
                    : "text-pink-100/75 hover:bg-white/10 hover:text-white"
                }`}
                aria-current={active ? "page" : undefined}
              >
                <Icon className="size-4.5 shrink-0" aria-hidden />
                <span className="flex-1 text-left">{t(`nav.${v}`)}</span>
                {v === "emails" && unread > 0 && (
                  <Badge className="bg-white/20 px-1.5 text-[10px] text-white">
                    {unread}
                  </Badge>
                )}
              </button>
            )
          })}
        </nav>

        <div className="p-3">
          <div className="flex items-center gap-3 rounded-xl border border-white/15 bg-white/10 p-3">
            <Avatar className="size-9 border border-white/15">
              <AvatarFallback className="bg-white/15 text-xs font-semibold text-white">
                {initials || "OR"}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-white">{user.name ?? "Utilisateur"}</p>
              <p className="truncate text-[11px] text-pink-200/70">{user.email}</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 text-pink-200/70 hover:bg-white/10 hover:text-white"
              onClick={onLogout}
              aria-label={t("nav.logout")}
            >
              <LogOut className="size-4" aria-hidden />
            </Button>
          </div>
        </div>
      </aside>

      {/* ---------- Contenu ---------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border/60 bg-background/80 px-3 backdrop-blur-md sm:px-4">
          {/* Logo mobile — texte masqué sous 420px : la place libérée évite
              l'overflow du header (recherche + sync + notifs + avatar). */}
          <div className="flex items-center gap-2 lg:hidden">
            <OrbitLogo size={26} />
            <span className="hidden text-sm font-semibold tracking-tight min-[420px]:inline">Orbit</span>
          </div>

          <span className="hidden text-sm font-medium text-muted-foreground lg:block">
            {view === "emails" ? t("nav.inbox") : t(`nav.${view}`)}
            <span className="ml-2 text-xs font-normal">
              {format(new Date(), "EEE d MMM", { locale: DATE_LOCALES[locale] })}
            </span>
          </span>

          <div className="ml-auto flex items-center gap-1">
            {/* Recherche globale / palette de commandes (Ctrl+K) */}
            <Button
              variant="ghost"
              size="icon"
              className="size-10"
              onClick={() => openCommandPalette()}
              aria-label={t("command.searchButton")}
              title="Ctrl+K"
            >
              <Search className="size-5" aria-hidden />
            </Button>

            {/* Statut de synchronisation offline-first v2 : hors ligne / sync /
                N en attente (clic = sync) / conflits (clic = réglages) / âge */}
            <SyncStatusBadge onOpenSettings={() => onNavigate("settings")} />

            {canInstall && !installed && (
              <Button
                variant="ghost"
                size="icon"
                className="size-10"
                onClick={() => promptInstall()}
                aria-label={t("nav.installApp")}
              >
                <Download className="size-5" aria-hidden />
              </Button>
            )}

            <ThemeToggle />

            <NotificationCenter onNavigate={onNavigate} />

            {/* Menu utilisateur (mobile) */}
            <div className="lg:hidden">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-10" aria-label={t("nav.userMenu")}>
                    <Avatar className="size-8 border border-border/60">
                      <AvatarFallback className="bg-primary/15 text-[10px] font-semibold text-primary">
                        {initials || "OR"}
                      </AvatarFallback>
                    </Avatar>
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-52">
                  <DropdownMenuLabel className="truncate">
                    {user.name ?? user.email}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => onNavigate("settings")}>
                    <Settings className="size-4" aria-hidden />
                    {t("nav.settings")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onLogout} className="text-destructive focus:text-destructive">
                    <LogOut className="size-4" aria-hidden />
                    {t("nav.logout")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>

        {/* Bannière hors ligne (offline-first v2) : cache local + file d'attente */}
        <OfflineBanner />

        {/* Main */}
        <main className="mx-auto w-full max-w-6xl flex-1 px-3 py-5 pb-28 sm:px-5 sm:py-6 lg:pb-10">
          {children}
        </main>

        {/* Footer desktop */}
        <footer className="mt-auto hidden border-t border-border/40 px-5 py-3 text-[11px] text-muted-foreground lg:block">
          Orbit · Vos données restent chez vous · {new Date().getFullYear()}
        </footer>

        {/* Bottom nav (mobile) — assortie au sidebar rose foncé (même dégradé) */}
        <nav
          className="fixed inset-x-0 bottom-0 z-40 flex border-t border-white/10 bg-rose-900/95 backdrop-blur-md lg:hidden"
          style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.375rem)" }}
          aria-label={t("nav.mobileNav")}
        >
          {NAV.map(({ view: v, icon: Icon }) => {
            const active = view === v
            return (
              <button
                key={v}
                onClick={() => onNavigate(v)}
                className={`relative flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] font-medium transition-colors ${
                  active ? "text-white" : "text-pink-200/65"
                }`}
                aria-current={active ? "page" : undefined}
              >
                <span className="relative">
                  <Icon className="size-5" aria-hidden />
                  {v === "emails" && unread > 0 && (
                    <span
                      className="absolute -right-1.5 -top-1 size-2 rounded-full bg-pink-400"
                      aria-hidden
                    />
                  )}
                </span>
                <span className="truncate">{t(`nav.${v}`).split(" ")[0]}</span>
                {active && (
                  <span
                    className="absolute top-0 h-0.5 w-8 rounded-full bg-pink-400"
                    aria-hidden
                  />
                )}
              </button>
            )
          })}
        </nav>
      </div>

      {/* ---------- Palette de commandes (Ctrl+K) + aide raccourcis (?) ---------- */}
      <CommandPalette onNavigate={onNavigate} />
      <ShortcutHelpModal />
    </div>
  )
}
