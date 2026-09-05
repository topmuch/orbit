"use client";

// Orbit — Shell applicatif : sidebar desktop + bottom nav mobile + header

import { useEffect, useRef } from "react"
import { format } from "date-fns"
import { fr } from "date-fns/locale"
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
  WifiOff,
  Download,
} from "lucide-react"

const NAV: { view: OrbitView; label: string; icon: React.ElementType }[] = [
  { view: "dashboard", label: "Tableau de bord", icon: LayoutDashboard },
  { view: "calendar", label: "Calendrier", icon: CalendarDays },
  { view: "tasks", label: "Tâches", icon: KanbanSquare },
  { view: "emails", label: "Emails", icon: Mail },
  { view: "assistant", label: "Assistant", icon: Bot },
  { view: "settings", label: "Réglages", icon: Settings },
]

const VIEW_TITLES: Record<OrbitView, string> = {
  dashboard: "Tableau de bord",
  calendar: "Calendrier",
  tasks: "Tâches",
  emails: "Boîte de réception",
  assistant: "Assistant IA",
  settings: "Paramètres",
}

export function AppShell({
  user,
  view,
  onNavigate,
  onLogout,
  children,
}: {
  user: SessionUser
  view: OrbitView
  onNavigate: (view: OrbitView) => void
  onLogout: () => void
  children: React.ReactNode
}) {
  const { data: emailsData } = useEmails()
  const { online, canInstall, installed } = usePwaStore()

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
      {/* ---------- Sidebar (desktop) ---------- */}
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-border/60 bg-sidebar/60 backdrop-blur-md lg:flex">
        <div className="flex items-center gap-2.5 px-5 py-5">
          <OrbitLogo size={34} />
          <div className="leading-tight">
            <p className="text-base font-semibold tracking-tight">Orbit</p>
            <p className="text-[11px] text-muted-foreground">OS personnel</p>
          </div>
        </div>

        <nav className="flex-1 space-y-1 px-3" aria-label="Navigation principale">
          {NAV.map(({ view: v, label, icon: Icon }) => {
            const active = view === v
            return (
              <button
                key={v}
                onClick={() => onNavigate(v)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                  active
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                }`}
                aria-current={active ? "page" : undefined}
              >
                <Icon className="size-4.5 shrink-0" aria-hidden />
                <span className="flex-1 text-left">{label}</span>
                {v === "emails" && unread > 0 && (
                  <Badge className="bg-violet-500/20 px-1.5 text-[10px] text-violet-600 dark:text-violet-400">
                    {unread}
                  </Badge>
                )}
              </button>
            )
          })}
        </nav>

        <div className="p-3">
          <div className="flex items-center gap-3 rounded-xl border border-border/60 bg-card/60 p-3">
            <Avatar className="size-9 border border-border/60">
              <AvatarFallback className="bg-primary/15 text-xs font-semibold text-primary">
                {initials || "OR"}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user.name ?? "Utilisateur"}</p>
              <p className="truncate text-[11px] text-muted-foreground">{user.email}</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={onLogout}
              aria-label="Se déconnecter"
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
          {/* Logo mobile */}
          <div className="flex items-center gap-2 lg:hidden">
            <OrbitLogo size={26} />
            <span className="text-sm font-semibold tracking-tight">Orbit</span>
          </div>

          <span className="hidden text-sm font-medium text-muted-foreground lg:block">
            {VIEW_TITLES[view]}
            <span className="ml-2 text-xs font-normal">
              {format(new Date(), "EEE d MMM", { locale: fr })}
            </span>
          </span>

          <div className="ml-auto flex items-center gap-1">
            {!online && (
              <Badge variant="destructive" className="mr-1 gap-1.5">
                <WifiOff className="size-3" aria-hidden />
                <span className="hidden sm:inline">Hors ligne</span>
              </Badge>
            )}

            {canInstall && !installed && (
              <Button
                variant="ghost"
                size="icon"
                className="size-10"
                onClick={() => promptInstall()}
                aria-label="Installer l'application Orbit"
              >
                <Download className="size-5" aria-hidden />
              </Button>
            )}

            <NotificationCenter onNavigate={onNavigate} />

            {/* Menu utilisateur (mobile) */}
            <div className="lg:hidden">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-10" aria-label="Menu utilisateur">
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
                    Paramètres
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={onLogout} className="text-destructive focus:text-destructive">
                    <LogOut className="size-4" aria-hidden />
                    Se déconnecter
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </header>

        {/* Main */}
        <main className="mx-auto w-full max-w-6xl flex-1 px-3 py-5 pb-28 sm:px-5 sm:py-6 lg:pb-10">
          {children}
        </main>

        {/* Footer desktop */}
        <footer className="mt-auto hidden border-t border-border/40 px-5 py-3 text-[11px] text-muted-foreground lg:block">
          Orbit · Vos données restent chez vous · {new Date().getFullYear()}
        </footer>

        {/* Bottom nav (mobile) */}
        <nav
          className="fixed inset-x-0 bottom-0 z-40 flex border-t border-border/60 bg-background/90 backdrop-blur-md lg:hidden"
          style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.375rem)" }}
          aria-label="Navigation mobile"
        >
          {NAV.map(({ view: v, label, icon: Icon }) => {
            const active = view === v
            return (
              <button
                key={v}
                onClick={() => onNavigate(v)}
                className={`relative flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[10px] font-medium transition-colors ${
                  active ? "text-primary" : "text-muted-foreground"
                }`}
                aria-current={active ? "page" : undefined}
              >
                <span className="relative">
                  <Icon className="size-5" aria-hidden />
                  {v === "emails" && unread > 0 && (
                    <span
                      className="absolute -right-1.5 -top-1 size-2 rounded-full bg-violet-500"
                      aria-hidden
                    />
                  )}
                </span>
                <span className="truncate">{label.split(" ")[0]}</span>
                {active && (
                  <span
                    className="absolute top-0 h-0.5 w-8 rounded-full bg-primary"
                    aria-hidden
                  />
                )}
              </button>
            )
          })}
        </nav>
      </div>
    </div>
  )
}
