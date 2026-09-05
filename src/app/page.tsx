"use client";

// Orbit — Page unique (SPA) : auth → shell applicatif multi-vues

import { useState } from "react"
import { useSession, useAuthMutations } from "@/lib/api-client"
import { AuthView } from "@/components/orbit/auth-view"
import { AppShell } from "@/components/orbit/app-shell"
import { DashboardView } from "@/components/orbit/dashboard-view"
import { CalendarView } from "@/components/orbit/calendar-view"
import { TasksView } from "@/components/orbit/tasks-view"
import { EmailsView } from "@/components/orbit/emails-view"
import { AssistantView } from "@/components/orbit/assistant-view"
import { SettingsView } from "@/components/orbit/settings-view"
import { OrbitLogo } from "@/components/orbit/logo"
import type { OrbitView } from "@/lib/types"

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
