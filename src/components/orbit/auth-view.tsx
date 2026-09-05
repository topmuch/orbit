"use client";

// Orbit — Écran d'authentification (connexion / inscription / démo)

import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { OrbitLogo } from "@/components/orbit/logo"
import { useAuthMutations } from "@/lib/api-client"
import { Loader2, Mail, Lock, User, Rocket, ShieldCheck, CalendarDays, Bot, AlertCircle } from "lucide-react"

export function AuthView() {
  const { login, register, demoLogin } = useAuthMutations()

  const [loginEmail, setLoginEmail] = useState("")
  const [loginPassword, setLoginPassword] = useState("")
  const [regName, setRegName] = useState("")
  const [regEmail, setRegEmail] = useState("")
  const [regPassword, setRegPassword] = useState("")
  const [error, setError] = useState<string | null>(null)

  const busy = login.isPending || register.isPending || demoLogin.isPending

  function clearError() {
    setError(null)
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    clearError()
    try {
      await login.mutateAsync({ email: loginEmail, password: loginPassword })
      toast.success("Bon retour dans Orbit !")
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault()
    clearError()
    try {
      await register.mutateAsync({ name: regName || undefined, email: regEmail, password: regPassword })
      toast.success("Bienvenue dans Orbit 🪐", { description: "Votre espace est prêt." })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function handleDemo() {
    clearError()
    try {
      await demoLogin.mutateAsync()
      toast.success("Mode démo activé", { description: "Explorez Orbit avec des données d'exemple." })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <div className="relative flex min-h-screen flex-col lg:flex-row">
      {/* ---------- Panneau visuel (desktop) ---------- */}
      <div className="relative hidden flex-1 items-center justify-center overflow-hidden lg:flex">
        {/* Anneaux orbitaux */}
        <div className="absolute size-[280px] rounded-full border border-primary/15" />
        <div className="absolute size-[280px] animate-orbit">
          <span className="absolute -top-1.5 left-1/2 size-3 rounded-full bg-primary shadow-[0_0_18px_4px] shadow-primary/50" />
        </div>
        <div className="absolute size-[440px] rounded-full border border-primary/10" />
        <div className="absolute size-[440px] animate-orbit-slow">
          <span className="absolute top-[52px] left-1/2 size-2 rounded-full bg-emerald-400/90" />
        </div>
        <div className="absolute size-[600px] rounded-full border border-primary/5" />
        <div className="absolute size-[600px] animate-orbit" style={{ animationDuration: "46s" }}>
          <span className="absolute top-[168px] left-1/2 size-2.5 rounded-full bg-violet-400/70" />
        </div>

        <div className="relative z-10 max-w-md px-8 text-center">
          <div className="mb-6 flex justify-center">
            <OrbitLogo size={96} />
          </div>
          <h1 className="text-4xl font-semibold tracking-tight text-foreground">
            Votre vie, en orbite
          </h1>
          <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
            Calendrier intelligent, tâches, emails et assistant IA —
            réunis dans un espace unique, pensé pour votre confidentialité.
          </p>

          <div className="mt-10 grid grid-cols-3 gap-3 text-left">
            {[
              { icon: CalendarDays, label: "Calendrier" },
              { icon: Bot, label: "Assistant IA" },
              { icon: ShieldCheck, label: "Données protégées" },
            ].map(({ icon: Icon, label }) => (
              <div
                key={label}
                className="rounded-xl border border-border/60 bg-card/50 p-3 backdrop-blur-sm"
              >
                <Icon className="mb-2 size-5 text-primary" aria-hidden />
                <p className="text-xs font-medium text-muted-foreground">{label}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ---------- Formulaire ---------- */}
      <div className="flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          {/* Logo mobile */}
          <div className="mb-8 flex flex-col items-center gap-3 lg:hidden">
            <OrbitLogo size={64} />
            <span className="text-xl font-semibold tracking-tight">Orbit</span>
          </div>

          <Card className="border-border/70 bg-card/80 shadow-xl backdrop-blur-md">
            <CardHeader className="space-y-1">
              <CardTitle className="text-2xl font-semibold">
                Bienvenue sur Orbit
              </CardTitle>
              <CardDescription>
                Connectez-vous ou créez votre espace personnel.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {error && (
                <Alert variant="destructive" className="mb-4">
                  <AlertCircle className="size-4" aria-hidden />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              <Tabs defaultValue="login" onValueChange={clearError}>
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="login">Connexion</TabsTrigger>
                  <TabsTrigger value="register">Inscription</TabsTrigger>
                </TabsList>

                <TabsContent value="login">
                  <form onSubmit={handleLogin} className="mt-4 space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="login-email">Email</Label>
                      <div className="relative">
                        <Mail
                          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                          aria-hidden
                        />
                        <Input
                          id="login-email"
                          type="email"
                          autoComplete="email"
                          required
                          value={loginEmail}
                          onChange={(e) => setLoginEmail(e.target.value)}
                          placeholder="vous@exemple.fr"
                          className="pl-10"
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="login-password">Mot de passe</Label>
                      <div className="relative">
                        <Lock
                          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                          aria-hidden
                        />
                        <Input
                          id="login-password"
                          type="password"
                          autoComplete="current-password"
                          required
                          value={loginPassword}
                          onChange={(e) => setLoginPassword(e.target.value)}
                          placeholder="••••••••"
                          className="pl-10"
                        />
                      </div>
                    </div>
                    <Button type="submit" className="w-full" disabled={busy}>
                      {login.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                      Se connecter
                    </Button>
                  </form>
                </TabsContent>

                <TabsContent value="register">
                  <form onSubmit={handleRegister} className="mt-4 space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="reg-name">Nom (optionnel)</Label>
                      <div className="relative">
                        <User
                          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                          aria-hidden
                        />
                        <Input
                          id="reg-name"
                          autoComplete="name"
                          value={regName}
                          onChange={(e) => setRegName(e.target.value)}
                          placeholder="Alex Martin"
                          className="pl-10"
                          maxLength={60}
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="reg-email">Email</Label>
                      <div className="relative">
                        <Mail
                          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                          aria-hidden
                        />
                        <Input
                          id="reg-email"
                          type="email"
                          autoComplete="email"
                          required
                          value={regEmail}
                          onChange={(e) => setRegEmail(e.target.value)}
                          placeholder="vous@exemple.fr"
                          className="pl-10"
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="reg-password">Mot de passe</Label>
                      <div className="relative">
                        <Lock
                          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                          aria-hidden
                        />
                        <Input
                          id="reg-password"
                          type="password"
                          autoComplete="new-password"
                          required
                          minLength={6}
                          value={regPassword}
                          onChange={(e) => setRegPassword(e.target.value)}
                          placeholder="6 caractères minimum"
                          className="pl-10"
                        />
                      </div>
                    </div>
                    <Button type="submit" className="w-full" disabled={busy}>
                      {register.isPending && <Loader2 className="size-4 animate-spin" aria-hidden />}
                      Créer mon compte
                    </Button>
                  </form>
                </TabsContent>
              </Tabs>

              {/* Démo instantanée */}
              <div className="my-5 flex items-center gap-3" aria-hidden>
                <span className="h-px flex-1 bg-border" />
                <span className="text-xs uppercase tracking-wider text-muted-foreground">ou</span>
                <span className="h-px flex-1 bg-border" />
              </div>

              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={handleDemo}
                disabled={busy}
              >
                {demoLogin.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Rocket className="size-4" aria-hidden />
                )}
                Explorer avec le compte démo
              </Button>
              <p className="mt-2 text-center text-xs text-muted-foreground">
                Données d'exemple prêtes à l'emploi — aucune inscription requise.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Footer collé en bas (mobile) */}
      <footer className="mt-auto pb-6 pt-2 text-center text-xs text-muted-foreground lg:hidden">
        Orbit · Vos données restent chez vous · {new Date().getFullYear()}
      </footer>
    </div>
  )
}
