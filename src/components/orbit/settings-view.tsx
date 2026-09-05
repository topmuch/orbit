"use client";

// Orbit — Paramètres : profil, apparence, notifications, application (PWA)

import { useState } from "react"
import { useTheme } from "next-themes"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { useProfileMutation, useAuthMutations, useAIStatus, usePushStatus, usePushMutations } from "@/lib/api-client"
import { usePwaStore } from "@/lib/pwa-store"
import { promptInstall } from "@/components/orbit/pwa-register"
import { DesignSystemShowcase } from "@/components/orbit/design-system-showcase"
import type { SessionUser } from "@/lib/types"
import {
  User,
  Palette,
  Bell,
  BellRing,
  BellOff,
  Smartphone,
  Sparkles,
  LogOut,
  Save,
  Check,
  Download,
  Wifi,
  WifiOff,
  ShieldCheck,
  Moon,
  Sun,
  Server,
  Cpu,
  MonitorSmartphone,
} from "lucide-react"

export function SettingsView({ user }: { user: SessionUser }) {
  const { theme, setTheme } = useTheme()
  const { online, canInstall, installed, swReady } = usePwaStore()
  const profile = useProfileMutation()
  const { logout } = useAuthMutations()
  const aiStatus = useAIStatus()
  const pushStatus = usePushStatus()
  const pushCount = pushStatus.data?.subscriptions ?? 0
  const { enable, disable, test } = usePushMutations()
  // Permission navigateur : init paresseuse côté client (pas d'effet),
  // rafraîchie après chaque action push.
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    () => ("Notification" in window ? Notification.permission : "unsupported")
  )

  const [name, setName] = useState(user.name ?? "")

  async function handleEnablePush() {
    try {
      await enable.mutateAsync()
      setPermission("Notification" in window ? Notification.permission : "unsupported")
      toast.success("Rappels push activés", {
        description: "Événements 15 min avant · tâches 1 h avant l’échéance, même app fermée.",
      })
    } catch (err) {
      setPermission("Notification" in window ? Notification.permission : "unsupported")
      toast.error((err as Error).message)
    }
  }

  async function handleDisablePush() {
    try {
      await disable.mutateAsync()
      toast.info("Rappels push désactivés", {
        description: "Vous pouvez les réactiver à tout moment.",
      })
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function handleTestPush() {
    try {
      await test.mutateAsync()
      toast.success("Notification envoyée", {
        description: "Vérifiez votre centre de notifications système.",
      })
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault()
    try {
      await profile.mutateAsync(name)
      toast.success("Profil mis à jour")
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function handleInstall() {
    const outcome = await promptInstall()
    if (outcome === "unavailable") {
      toast.info("Installation non disponible", {
        description:
          "Utilisez le menu de votre navigateur → « Installer l'application » / « Ajouter à l'écran d'accueil ».",
      })
    }
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Paramètres</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Profil, apparence, notifications et application.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ---------- Profil ---------- */}
        <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base font-medium">
              <User className="size-4 text-primary" aria-hidden />
              Profil
            </CardTitle>
            <CardDescription>Vos informations de compte.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSaveProfile} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="settings-name">Nom affiché</Label>
                <Input
                  id="settings-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Votre nom"
                  maxLength={60}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="settings-email">Email</Label>
                <Input id="settings-email" value={user.email} disabled />
              </div>
              <Button type="submit" size="sm" disabled={profile.isPending || name.trim().length < 2}>
                {profile.isPending ? <Save className="size-4" aria-hidden /> : <Check className="size-4" aria-hidden />}
                Enregistrer
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* ---------- Apparence ---------- */}
        <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base font-medium">
              <Palette className="size-4 text-primary" aria-hidden />
              Apparence
            </CardTitle>
            <CardDescription>Mode clair ou cosmos sombre.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setTheme("light")}
                className={`flex flex-col items-center gap-2 rounded-xl border p-4 transition-colors ${
                  theme === "light" ? "border-primary bg-primary/10" : "border-border/60 hover:bg-accent/40"
                }`}
                aria-pressed={theme === "light"}
              >
                <Sun className="size-6" aria-hidden />
                <span className="text-sm font-medium">Clair</span>
              </button>
              <button
                onClick={() => setTheme("dark")}
                className={`flex flex-col items-center gap-2 rounded-xl border p-4 transition-colors ${
                  theme === "dark" ? "border-primary bg-primary/10" : "border-border/60 hover:bg-accent/40"
                }`}
                aria-pressed={theme === "dark"}
              >
                <Moon className="size-6" aria-hidden />
                <span className="text-sm font-medium">Cosmos</span>
              </button>
            </div>
          </CardContent>
        </Card>

        {/* ---------- Notifications push ---------- */}
        <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base font-medium">
              <Bell className="size-4 text-primary" aria-hidden />
              Rappels push
            </CardTitle>
            <CardDescription>
              Événements 15 min avant · tâches 1 h avant l&apos;échéance — même
              application fermée.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={permission === "granted" ? "secondary" : permission === "denied" ? "destructive" : "outline"}
                className="gap-1.5"
              >
                {permission === "granted" ? (
                  <BellRing className="size-3" aria-hidden />
                ) : permission === "denied" ? (
                  <BellOff className="size-3" aria-hidden />
                ) : (
                  <Bell className="size-3" aria-hidden />
                )}
                {permission === "granted"
                  ? "Permission accordée"
                  : permission === "denied"
                    ? "Permission refusée"
                    : permission === "unsupported"
                      ? "Non supportée"
                      : "Permission non demandée"}
              </Badge>
              {pushCount > 0 && (
                <Badge className="gap-1.5 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                  <MonitorSmartphone className="size-3" aria-hidden />
                  {pushCount} appareil{pushCount > 1 ? "s" : ""} abonné{pushCount > 1 ? "s" : ""}
                </Badge>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {pushCount > 0 ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDisablePush}
                    disabled={disable.isPending}
                  >
                    <BellOff className="size-4" aria-hidden />
                    Désactiver les rappels
                  </Button>
                  <Button size="sm" onClick={handleTestPush} disabled={test.isPending}>
                    <BellRing className="size-4" aria-hidden />
                    Envoyer un test
                  </Button>
                </>
              ) : (
                <Button size="sm" onClick={handleEnablePush} disabled={enable.isPending}>
                  <BellRing className="size-4" aria-hidden />
                  {enable.isPending ? "Activation…" : "Activer les rappels push"}
                </Button>
              )}
            </div>

            <p className="text-xs leading-relaxed text-muted-foreground">
              Orbit vous alerte via les notifications du système : 15 minutes avant
              chaque événement du calendrier et 1 heure avant l&apos;échéance de vos
              tâches — même quand l&apos;application est fermée (PWA installée
              recommandée). Installez Orbit sur plusieurs appareils pour recevoir les
              rappels partout.
            </p>
          </CardContent>
        </Card>

        {/* ---------- Application ---------- */}
        <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base font-medium">
              <Smartphone className="size-4 text-primary" aria-hidden />
              Application
            </CardTitle>
            <CardDescription>Installez Orbit comme une vraie application.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={online ? "secondary" : "destructive"} className="gap-1.5">
                {online ? <Wifi className="size-3" aria-hidden /> : <WifiOff className="size-3" aria-hidden />}
                {online ? "En ligne" : "Hors ligne"}
              </Badge>
              <Badge variant={swReady ? "secondary" : "outline"} className="gap-1.5">
                <Check className="size-3" aria-hidden />
                {swReady ? "Cache hors-ligne actif" : "Cache en préparation"}
              </Badge>
              {installed && (
                <Badge className="gap-1.5 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                  <Check className="size-3" aria-hidden />
                  Installée
                </Badge>
              )}
            </div>

            {!installed && (
              <Button variant="outline" size="sm" onClick={handleInstall} disabled={!canInstall}>
                <Download className="size-4" aria-hidden />
                {canInstall ? "Installer l'application" : "Installation via le navigateur"}
              </Button>
            )}
            <p className="text-xs leading-relaxed text-muted-foreground">
              Orbit est une PWA : installée, elle démarre instantanément, fonctionne
              hors-ligne pour la consultation et s&apos;intègre à votre écran d&apos;accueil.
            </p>
          </CardContent>
        </Card>

        {/* ---------- IA & confidentialité ---------- */}
        <Card className="border-border/60 bg-card/70 backdrop-blur-sm lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base font-medium">
              <Sparkles className="size-4 text-primary" aria-hidden />
              Assistant IA &amp; confidentialité
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* État en direct du micro-service IA (Ollama → fallback) */}
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={aiStatus.data?.serviceUp ? "secondary" : "destructive"}
                className="gap-1.5"
              >
                <Server className="size-3" aria-hidden />
                {aiStatus.data?.serviceUp
                  ? "Micro-service IA en ligne"
                  : "Micro-service IA injoignable (repli interne)"}
              </Badge>
              <Badge
                className={
                  aiStatus.data?.provider === "ollama"
                    ? "gap-1.5 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                    : "gap-1.5 bg-amber-500/15 text-amber-600 dark:text-amber-400"
                }
              >
                <Cpu className="size-3" aria-hidden />
                {aiStatus.data?.provider === "ollama"
                  ? `Ollama local — ${aiStatus.data?.model}`
                  : `Moteur de repli — ${aiStatus.data?.model ?? "llama3"}`}
              </Badge>
            </div>
            <div className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/40 p-4">
              <ShieldCheck className="mt-0.5 size-5 shrink-0 text-emerald-500" aria-hidden />
              <div className="text-sm leading-relaxed text-muted-foreground">
                <p className="font-medium text-foreground">Architecture « IA privée » par défaut</p>
                <p className="mt-1">
                  Toute l&apos;IA transite par un micro-service isolé sur le port 3031
                  (<code className="rounded bg-muted px-1 font-mono text-xs">/api/ai/*</code>
                  côté serveur) qui route vers <strong>Ollama</strong> en local — vos
                  données ne quittent alors jamais votre machine. Le repli interne
                  n&apos;est actif qu&apos;en environnement de développement.
                </p>
              </div>
            </div>
            <Separator />
            <div className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-3">
              <div>
                <p className="font-medium text-foreground">Chat contextuel</p>
                <p className="text-xs">agenda + tâches injectés à chaque requête</p>
              </div>
              <div>
                <p className="font-medium text-foreground">Extraction email</p>
                <p className="text-xs">rendez-vous détectés → suggestion → 1 clic pour l&apos;agenda</p>
              </div>
              <div>
                <p className="font-medium text-foreground">Streaming</p>
                <p className="text-xs">réponses affichées au fil de la génération</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ---------- Design system ---------- */}
        <div className="lg:col-span-2">
          <DesignSystemShowcase />
        </div>

        {/* ---------- Déconnexion ---------- */}
        <div className="lg:col-span-2">
          <Button
            variant="outline"
            className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive sm:w-auto"
            onClick={() => logout.mutateAsync()}
            disabled={logout.isPending}
          >
            <LogOut className="size-4" aria-hidden />
            Se déconnecter
          </Button>
        </div>
      </div>
    </div>
  )
}
