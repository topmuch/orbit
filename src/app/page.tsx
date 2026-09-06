"use client";

// Orbit — Page unique (SPA) : auth → onboarding → shell applicatif multi-vues
// ─────────────────────────────────────────────────────────────────────────────
// Features avancées :
//  · Onboarding guidé à la première connexion (preferences.onboardingCompleted)
//  · Lazy loading des vues lourdes (calendar/emails/tasks/assistant) via
//    next/dynamic — Core Web Vitals : le bundle initial ne paie que le shell
//    + le dashboard, chaque vue se charge à la demande avec son skeleton.

import { useState } from "react"
import dynamic from "next/dynamic"
import { useQueryClient } from "@tanstack/react-query"
import { useSession, useAuthMutations } from "@/lib/api-client"
import { AuthView } from "@/components/orbit/auth-view"
import { AppShell } from "@/components/orbit/app-shell"
import { DashboardView } from "@/components/orbit/dashboard-view"
import { OnboardingWizard } from "@/components/onboarding/OnboardingWizard"
import { OrbitLogo } from "@/components/orbit/logo"
import { Skeleton } from "@/components/ui/skeleton"
import type { OrbitView } from "@/lib/types"

// ── Vues chargées à la demande (code-splitting par vue) ─────────────────────
// Calendar/Emails embarquent des dépendances lourdes (dnd-kit, imap, markdown…)
// → dynamic() les sort du bundle initial ; skeletons pendant le chargement.

const CalendarView = dynamic(() => import("@/components/orbit/calendar-view").then((m) => m.CalendarView), {
  ssr: false,
  loading: () => <ViewSkeleton rows={8} />,
})
const TasksView = dynamic(() => import("@/components/orbit/tasks-view").then((m) => m.TasksView), {
  ssr: false,
  loading: () => <ViewSkeleton rows={6} />,
})
const EmailsView = dynamic(() => import("@/components/orbit/emails-view").then((m) => m.EmailsView), {
  ssr: false,
  loading: () => <ViewSkeleton rows={10} />,
})
const AssistantView = dynamic(() => import("@/components/orbit/assistant-view").then((m) => m.AssistantView), {
  ssr: false,
  loading: () => <ViewSkeleton rows={6} />,
})
const SettingsView = dynamic(() => import("@/components/orbit/settings-view").then((m) => m.SettingsView), {
  ssr: false,
  loading: () => <ViewSkeleton rows={5} />,
})

/** Skeleton générique de chargement de vue. */
function ViewSkeleton({ rows }: { rows: number }) {
  return (
    <div className="space-y-4" role="status" aria-label="Chargement">
      <Skeleton className="h-9 w-64" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-20 w-full rounded-xl" />
      ))}
    </div>
  )
}

/** Fond cosmique commun (nébuleuses + étoiles en sombre) */
function CosmosBackground() {
  return (
    <div className="orbit-cosmos pointer-events-none fixed inset-0 -z-10" aria-hidden>
      <div className="orbit-stars size-full" />
    </div>
  )
}

export default function Home() {
  const { data, isLoading } = useSession()
  const { logout } = useAuthMutations()
  const queryClient = useQueryClient()

  const [view, setView] = useState<OrbitView>("dashboard")
  const [emailFocusId, setEmailFocusId] = useState<string | null>(null)

  const user = data?.user ?? null

  function navigate(v: OrbitView, emailId?: string) {
    setView(v)
    if (emailId !== undefined) setEmailFocusId(emailId)
    window.scrollTo({ top: 0 })
  }

  async function handleLogout() {
    await logout.mutateAsync()
    setView("dashboard")
    setEmailFocusId(null)
  }

  /** Fin d'onboarding : persiste le flag (fait par le wizard) puis rafraîchit
   *  la session pour que `onboardingCompleted` soit vrai côté client aussi. */
  function handleOnboardingComplete() {
    queryClient.invalidateQueries({ queryKey: ["session"] })
  }

  // ---------- Écran de chargement ----------
  if (isLoading) {
    return (
      <>
        <CosmosBackground />
        <div className="flex min-h-screen flex-col items-center justify-center gap-4">
          <OrbitLogo size={72} animated />
          <p className="text-sm text-muted-foreground">Chargement de votre orbite…</p>
        </div>
      </>
    )
  }

  // ---------- Non connecté ----------
  if (!user) {
    return (
      <>
        <CosmosBackground />
        <AuthView />
      </>
    )
  }

  // ---------- Première connexion : wizard d'onboarding ----------
  if (!user.onboardingCompleted) {
    return (
      <>
        <CosmosBackground />
        <OnboardingWizard user={user} onComplete={handleOnboardingComplete} />
      </>
    )
  }

  // ---------- Application ----------
  return (
    <>
      <CosmosBackground />
      <AppShell user={user} view={view} onNavigate={navigate} onLogout={handleLogout}>
        {view === "dashboard" && <DashboardView user={user} onNavigate={navigate} />}
        {view === "calendar" && <CalendarView />}
        {view === "tasks" && <TasksView />}
        {view === "emails" && (
          <EmailsView
            selectedId={emailFocusId}
            onSelect={setEmailFocusId}
            onNavigate={navigate}
          />
        )}
        {view === "assistant" && <AssistantView />}
        {view === "settings" && <SettingsView user={user} />}
      </AppShell>
    </>
  )
}
