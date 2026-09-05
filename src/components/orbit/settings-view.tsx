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
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  useProfileMutation,
  useAuthMutations,
  useAIStatus,
  usePushStatus,
  usePushMutations,
  useNotificationPreferences,
  useNotificationPreferencesMutation,
} from "@/lib/api-client"
import { useTimezone } from "@/hooks/useTimezone"
import { TimezoneSelector } from "@/components/orbit/timezone-selector"
import { timezoneLabel } from "@/lib/timezone"
import { usePwaStore } from "@/lib/pwa-store"
import { promptInstall } from "@/components/orbit/pwa-register"
import { DesignSystemShowcase } from "@/components/orbit/design-system-showcase"
import type { SessionUser } from "@/lib/types"
import type { NotificationPreferenceDto } from "@/lib/types"
import {
  User,
  Globe,
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
  MoonStar,
  CalendarClock,
  ListTodo,
  Mail,
  Bot,
} from "lucide-react"

export function SettingsView({ user }: { user: SessionUser }) {
  const { theme, setTheme } = useTheme()
  const { online, canInstall, installed, swReady } = usePwaStore()
  const profile = useProfileMutation()
  // 12-c : fuseau d'affichage du calendrier (instance useTimezone + persistance
  // profil via PATCH /api/profile — cf. useTimezone ; l'affichage de chaque vue
  // reste piloté par sa propre instance, la préférence sert au serveur/stats).
  const { timezone, setTimezone } = useTimezone()
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

        {/* ---------- Préférences d'affichage (fuseau) ---------- */}
        <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base font-medium">
              <Globe className="size-4 text-primary" aria-hidden />
              Préférences d&apos;affichage
            </CardTitle>
            <CardDescription>Fuseau horaire du calendrier et des heures.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-2">
              <Label htmlFor="settings-timezone">Fuseau horaire</Label>
              <TimezoneSelector id="settings-timezone" value={timezone} onChange={setTimezone} />
              <p className="text-xs text-muted-foreground">{timezoneLabel(timezone)}</p>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Les événements sont stockés en UTC et affichés dans ce fuseau. Chaque
              événement peut avoir son propre fuseau (défini lors de sa création).
            </p>
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

        {/* ---------- Préférences de notifications (types, timing, heures calmes) ---------- */}
        <NotificationPreferencesCard />

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

// ─────────────────────────────────────────────────────────────────────────────
// Préférences de notifications : types activés, avance par défaut des rappels
// d'événements, heures calmes. Sauvegarde immédiate à chaque changement (PUT
// partiel) — pas de bouton « Enregistrer », retour toast seulement en erreur.
// ─────────────────────────────────────────────────────────────────────────────

const REMINDER_OPTIONS = [
  { value: "0", label: "À l'heure exacte" },
  { value: "5", label: "5 minutes avant" },
  { value: "15", label: "15 minutes avant" },
  { value: "30", label: "30 minutes avant" },
  { value: "60", label: "1 heure avant" },
  { value: "1440", label: "1 jour avant" },
]

function NotificationPreferencesCard() {
  const { data, isLoading } = useNotificationPreferences()
  const save = useNotificationPreferencesMutation()
  const prefs = data?.preferences

  /** PUT partiel + toast en cas d'erreur (succès silencieux : UI déjà à jour). */
  async function patch(input: Partial<NotificationPreferenceDto>) {
    try {
      await save.mutateAsync(input)
    } catch (err) {
      toast.error("Préférences non enregistrées", { description: (err as Error).message })
    }
  }

  return (
    <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <MoonStar className="size-4 text-primary" aria-hidden />
          Préférences de notifications
        </CardTitle>
        <CardDescription>
          Types de rappels, avance par défaut et heures calmes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {isLoading || !prefs ? (
          <div className="space-y-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <>
            {/* Types de notifications */}
            <div className="space-y-3">
              <PrefRow
                icon={CalendarClock}
                label="Rappels d'événements"
                description="Avant chaque rendez-vous du calendrier"
                checked={prefs.eventReminder}
                disabled={save.isPending}
                onCheckedChange={(v) => patch({ eventReminder: v })}
              />
              <PrefRow
                icon={ListTodo}
                label="Échéances de tâches"
                description="Le jour de l'échéance et 1 h avant"
                checked={prefs.taskDeadline}
                disabled={save.isPending}
                onCheckedChange={(v) => patch({ taskDeadline: v })}
              />
              <PrefRow
                icon={Mail}
                label="Emails importants"
                description="Quand l'IA détecte un rendez-vous dans un email"
                checked={prefs.importantEmail}
                disabled={save.isPending}
                onCheckedChange={(v) => patch({ importantEmail: v })}
              />
              <PrefRow
                icon={Bot}
                label="Suggestions IA"
                description="Priorités suggérées pour vos tâches"
                checked={prefs.aiSuggestion}
                disabled={save.isPending}
                onCheckedChange={(v) => patch({ aiSuggestion: v })}
              />
            </div>

            <Separator />

            {/* Timing par défaut des rappels d'événement */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <Label className="text-sm">Avance par défaut des rappels</Label>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Pour les événements sans rappel personnalisé
                </p>
              </div>
              <Select
                value={String(prefs.eventReminderTime)}
                onValueChange={(v) => patch({ eventReminderTime: Number(v) })}
                disabled={save.isPending}
              >
                <SelectTrigger className="w-44" aria-label="Avance par défaut des rappels">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {REMINDER_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <Separator />

            {/* Heures calmes */}
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <Label className="text-sm">Heures calmes</Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Aucune notification la nuit — sauf rendez-vous imminent
                    (&lt; 15 min) que vous ne manquerez jamais.
                  </p>
                </div>
                <Switch
                  checked={prefs.quietHoursEnabled}
                  onCheckedChange={(v) =>
                    patch({
                      quietHoursEnabled: v,
                      ...(v && !prefs.quietHoursStart && !prefs.quietHoursEnd
                        ? { quietHoursStart: "22:00", quietHoursEnd: "08:00" }
                        : {}),
                    })
                  }
                  disabled={save.isPending}
                  aria-label="Activer les heures calmes"
                />
              </div>
              {prefs.quietHoursEnabled && (
                <div className="grid grid-cols-2 gap-3 pl-1">
                  <div className="space-y-1.5">
                    <Label htmlFor="quiet-start" className="text-xs">Début</Label>
                    <Input
                      id="quiet-start"
                      type="time"
                      value={prefs.quietHoursStart ?? ""}
                      onChange={(e) =>
                        patch({ quietHoursStart: e.target.value })
                      }
                      disabled={save.isPending}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="quiet-end" className="text-xs">Fin</Label>
                    <Input
                      id="quiet-end"
                      type="time"
                      value={prefs.quietHoursEnd ?? ""}
                      onChange={(e) => patch({ quietHoursEnd: e.target.value })}
                      disabled={save.isPending}
                    />
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function PrefRow({
  icon: Icon,
  label,
  description,
  checked,
  disabled,
  onCheckedChange,
}: {
  icon: React.ElementType
  label: string
  description: string
  checked: boolean
  disabled?: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
          <Icon className="size-4 text-muted-foreground" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium">{label}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onCheckedChange}
        disabled={disabled}
        aria-label={label}
      />
    </div>
  )
}
