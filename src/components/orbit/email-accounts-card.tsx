"use client";

// Orbit — Réglages · Comptes email IMAP réels (Task 6)
// ─────────────────────────────────────────────────────────────────────────────
// Gestion des comptes IMAP : liste + statut de sync, ajout (test de connexion
// préalable OBLIGATOIRE), édition, synchronisation immédiate, suspension,
// suppression. Le MOT DE PASSE n'est jamais affiché/renvoyé : vide = inchangé.
// Chiffré AES-256-GCM côté serveur (cf. docs/email-imap-guide.md).

import { useState } from "react"
import { formatDistanceToNow, parseISO } from "date-fns"
import { fr } from "date-fns/locale"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Skeleton } from "@/components/ui/skeleton"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  useEmailAccounts,
  useEmailAccountMutations,
  type EmailAccountInput,
} from "@/lib/api-client"
import type { EmailAccountDto } from "@/lib/types"
import {
  Mail,
  MailPlus,
  RefreshCw,
  Trash2,
  Pencil,
  Check,
  X,
  Loader2,
  ShieldCheck,
  AlertTriangle,
  Clock,
  Server,
} from "lucide-react"

/** Serveurs IMAP courants (pré-remplissage — jamais de mot de passe). */
const IMAP_PRESETS: Array<{ label: string; host: string; note?: string }> = [
  { label: "Gmail", host: "imap.gmail.com", note: "mot de passe d'application requis" },
  { label: "Outlook", host: "outlook.office365.com" },
  { label: "iCloud", host: "imap.mail.me.com", note: "mot de passe d'application requis" },
  { label: "Yahoo", host: "imap.mail.yahoo.com" },
  { label: "Free", host: "imap.free.fr" },
  { label: "Orange", host: "imap.orange.fr" },
]

type FormState = {
  label: string
  address: string
  imapHost: string
  imapPort: string
  imapSecure: boolean
  username: string
  password: string
  allowSelfSigned: boolean
  syncIntervalMin: string
  fetchDays: string
}

const EMPTY_FORM: FormState = {
  label: "",
  address: "",
  imapHost: "",
  imapPort: "993",
  imapSecure: true,
  username: "",
  password: "",
  allowSelfSigned: false,
  syncIntervalMin: "15",
  fetchDays: "30",
}

export function EmailAccountsCard() {
  const { data, isLoading } = useEmailAccounts()
  const { test, create, update, remove, syncOne } = useEmailAccountMutations()
  const accounts = data?.accounts ?? []

  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<EmailAccountDto | null>(null)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [confirmDelete, setConfirmDelete] = useState<EmailAccountDto | null>(null)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)

  function openCreate() {
    setEditing(null)
    setForm(EMPTY_FORM)
    setTestResult(null)
    setDialogOpen(true)
  }

  function openEdit(account: EmailAccountDto) {
    setEditing(account)
    setForm({
      label: account.label ?? "",
      address: account.address,
      imapHost: account.imapHost,
      imapPort: String(account.imapPort),
      imapSecure: account.imapSecure,
      username: account.username,
      password: "", // JAMAIS pré-rempli — vide = inchangé
      allowSelfSigned: account.allowSelfSigned,
      syncIntervalMin: String(account.syncIntervalMin),
      fetchDays: String(account.fetchDays),
    })
    setTestResult(null)
    setDialogOpen(true)
  }

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }))
    setTestResult(null)
  }

  function buildTestPayload() {
    return {
      imapHost: form.imapHost.trim(),
      imapPort: Number(form.imapPort) || 993,
      imapSecure: form.imapSecure,
      username: form.username.trim(),
      password: form.password,
      allowSelfSigned: form.allowSelfSigned,
    }
  }

  async function handleTest() {
    if (!form.imapHost.trim() || !form.username.trim() || !form.password) {
      toast.error("Renseignez le serveur, l'identifiant et le mot de passe avant de tester.")
      return
    }
    try {
      const res = await test.mutateAsync(buildTestPayload())
      setTestResult({
        ok: true,
        message: `Connexion réussie${res.messageCount !== null ? ` — ${res.messageCount} message(s) dans la boîte` : ""}.`,
      })
      toast.success("Connexion IMAP réussie")
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message })
      toast.error("Connexion impossible", { description: (err as Error).message })
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    try {
      if (editing) {
        // Édition : ne rien envoyer de vide — password vide = inchangé
        const input: Record<string, unknown> = {
          label: form.label.trim() || null,
          imapHost: form.imapHost.trim(),
          imapPort: Number(form.imapPort) || 993,
          imapSecure: form.imapSecure,
          username: form.username.trim(),
          allowSelfSigned: form.allowSelfSigned,
          syncIntervalMin: Number(form.syncIntervalMin) || 15,
          fetchDays: Number(form.fetchDays) || 30,
        }
        if (form.password) input.password = form.password
        await update.mutateAsync({ id: editing.id, input })
        toast.success("Compte mis à jour", {
          description: "La prochaine synchronisation utilisera les nouveaux réglages.",
        })
      } else {
        const input: EmailAccountInput = {
          label: form.label.trim() || undefined,
          address: form.address.trim(),
          ...buildTestPayload(),
          syncIntervalMin: Number(form.syncIntervalMin) || 15,
          fetchDays: Number(form.fetchDays) || 30,
          maxMessages: 100,
        }
        const res = await create.mutateAsync(input)
        toast.success("Compte email connecté 📬", {
          description: `${res.account.address} — utilisez « Synchroniser » pour récupérer vos messages.`,
        })
      }
      setDialogOpen(false)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function handleSync(account: EmailAccountDto) {
    try {
      const res = await syncOne.mutateAsync(account.id)
      toast.success(`${res.count} nouveau(x) email(s) synchronisé(s)`)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function handleToggleActive(account: EmailAccountDto, isActive: boolean) {
    try {
      await update.mutateAsync({ id: account.id, input: { isActive } })
      toast[isActive ? "success" : "info"](
        isActive ? "Compte réactivé — synchronisation automatique reprise." : "Compte suspendu — plus de synchronisation."
      )
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  async function handleDelete() {
    if (!confirmDelete) return
    try {
      await remove.mutateAsync(confirmDelete.id)
      toast.success("Compte supprimé", {
        description: "Les emails déjà synchronisés restent consultables.",
      })
      setConfirmDelete(null)
    } catch (err) {
      toast.error((err as Error).message)
    }
  }

  const canSubmit =
    form.imapHost.trim().length > 2 &&
    form.username.trim().length > 0 &&
    (editing !== null || (form.address.trim().length > 3 && form.password.length > 0)) &&
    (editing === null || form.password.length === 0 || form.password.length > 0)

  return (
    <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <Mail className="size-4 text-primary" aria-hidden />
          Comptes email (IMAP)
        </CardTitle>
        <CardDescription>
          Vraies boîtes IMAP en lecture seule — mots de passe chiffrés, jamais stockés en clair.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        ) : accounts.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border/60 p-6 text-center">
            <Mail className="size-8 text-muted-foreground" aria-hidden />
            <div>
              <p className="text-sm font-medium">Aucun compte connecté</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Connectez une boîte IMAP (Gmail, Outlook, serveur perso…) pour recevoir vos vrais
                emails dans Orbit.
              </p>
            </div>
            <Button size="sm" onClick={openCreate}>
              <MailPlus className="size-4" aria-hidden />
              Ajouter un compte
            </Button>
          </div>
        ) : (
          <>
            <ul className="space-y-2">
              {accounts.map((account) => (
                <li
                  key={account.id}
                  className="rounded-lg border border-border/60 bg-background/40 p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-sm font-medium">
                        {account.label ?? account.address}
                      </span>
                      {account.label && (
                        <span className="truncate text-xs text-muted-foreground">
                          {account.address}
                        </span>
                      )}
                    </span>
                    <div className="ml-auto flex flex-wrap items-center gap-1.5">
                      {!account.isActive && (
                        <Badge variant="outline" className="gap-1 text-[10px]">
                          <X className="size-2.5" aria-hidden />
                          Suspendu
                        </Badge>
                      )}
                      {account.lastSyncStatus === "error" ? (
                        <Badge variant="destructive" className="gap-1 text-[10px]">
                          <AlertTriangle className="size-2.5" aria-hidden />
                          Erreur
                        </Badge>
                      ) : account.lastSyncAt ? (
                        <Badge variant="secondary" className="gap-1 text-[10px]">
                          <Check className="size-2.5" aria-hidden />
                          Synchronisé
                        </Badge>
                      ) : null}
                      <Badge variant="outline" className="gap-1 text-[10px]">
                        {account.emailCount} email{account.emailCount > 1 ? "s" : ""}
                      </Badge>
                    </div>
                  </div>

                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Server className="size-3" aria-hidden />
                      {account.imapHost}:{account.imapPort}
                    </span>
                    {account.syncIntervalMin >= 1440 ? (
                      <span>sync toutes les {Math.round(account.syncIntervalMin / 1440)} j</span>
                    ) : (
                      <span>sync toutes les {account.syncIntervalMin} min</span>
                    )}
                    {account.lastSyncAt && (
                      <span className="flex items-center gap-1">
                        <Clock className="size-3" aria-hidden />
                        {formatDistanceToNow(parseISO(account.lastSyncAt), {
                          addSuffix: true,
                          locale: fr,
                        })}
                      </span>
                    )}
                  </div>

                  {account.lastSyncError && (
                    <p className="mt-1.5 line-clamp-2 text-xs text-destructive">
                      {account.lastSyncError}
                    </p>
                  )}

                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 px-2 text-xs"
                      onClick={() => handleSync(account)}
                      disabled={syncOne.isPending || !account.isActive}
                    >
                      <RefreshCw
                        className={syncOne.isPending ? "size-3.5 animate-spin" : "size-3.5"}
                        aria-hidden
                      />
                      Synchroniser
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1.5 px-2 text-xs"
                      onClick={() => openEdit(account)}
                    >
                      <Pencil className="size-3.5" aria-hidden />
                      Modifier
                    </Button>
                    <div className="ml-auto flex items-center gap-2">
                      <Switch
                        checked={account.isActive}
                        onCheckedChange={(v) => handleToggleActive(account, v)}
                        aria-label={account.isActive ? "Suspendre le compte" : "Réactiver le compte"}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-destructive hover:text-destructive"
                        onClick={() => setConfirmDelete(account)}
                        aria-label={`Supprimer le compte ${account.address}`}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            <Button variant="outline" size="sm" className="w-full gap-1.5" onClick={openCreate}>
              <MailPlus className="size-4" aria-hidden />
              Ajouter un autre compte
            </Button>
          </>
        )}

        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-500" aria-hidden />
          Les identifiants sont chiffrés (AES-256-GCM) et ne quittent jamais votre serveur.
          Synchronisation en lecture seule : Orbit ne modifie jamais vos messages côté serveur.
        </p>
      </CardContent>

      {/* ---- Dialog ajout / édition ---- */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="size-4 text-primary" aria-hidden />
              {editing ? "Modifier le compte" : "Ajouter un compte email IMAP"}
            </DialogTitle>
            <DialogDescription>
              {editing
                ? "Le mot de passe n'est demandé que si vous souhaitez le changer."
                : "Orbit lit vos emails en IMAP (lecture seule). Testez la connexion avant d'enregistrer."}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="account-address">Adresse email</Label>
                <Input
                  id="account-address"
                  type="email"
                  value={form.address}
                  onChange={(e) => set("address", e.target.value)}
                  placeholder="prenom@exemple.fr"
                  disabled={editing !== null}
                  required={!editing}
                  autoComplete="off"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="account-label">Libellé (optionnel)</Label>
                <Input
                  id="account-label"
                  value={form.label}
                  onChange={(e) => set("label", e.target.value)}
                  placeholder="Perso, Travail…"
                  maxLength={60}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="account-host">Serveur IMAP</Label>
              {!editing && (
                <div className="flex flex-wrap gap-1.5">
                  {IMAP_PRESETS.map((preset) => (
                    <button
                      key={preset.host}
                      type="button"
                      onClick={() => {
                        set("imapHost", preset.host)
                        set("imapPort", "993")
                        set("imapSecure", true)
                        if (!form.username && form.address.includes("@")) {
                          set("username", form.address.trim())
                        }
                      }}
                      title={
                        preset.note
                          ? `${preset.host} — ${preset.note}`
                          : `${preset.host}:993`
                      }
                      className={`rounded-full border px-2.5 py-0.5 text-xs transition-colors ${
                        form.imapHost === preset.host
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-border/60 hover:bg-accent/40"
                      }`}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              )}
              <Input
                id="account-host"
                value={form.imapHost}
                onChange={(e) => set("imapHost", e.target.value)}
                placeholder="imap.exemple.fr"
                required
                autoComplete="off"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="account-port">Port</Label>
                <Input
                  id="account-port"
                  type="number"
                  value={form.imapPort}
                  onChange={(e) => set("imapPort", e.target.value)}
                  min={1}
                  max={65535}
                />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
                <div>
                  <Label htmlFor="account-secure" className="text-sm">
                    {form.imapSecure ? "TLS (993)" : "STARTTLS (143)"}
                  </Label>
                  <p className="text-xs text-muted-foreground">Chiffrement de la connexion</p>
                </div>
                <Switch
                  id="account-secure"
                  checked={form.imapSecure}
                  onCheckedChange={(v) => set("imapSecure", v)}
                />
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="account-username">Identifiant IMAP</Label>
                <Input
                  id="account-username"
                  value={form.username}
                  onChange={(e) => set("username", e.target.value)}
                  placeholder="généralement l'adresse email"
                  required
                  autoComplete="off"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="account-password">
                  Mot de passe {editing && <span className="text-muted-foreground">(inchangé si vide)</span>}
                </Label>
                <Input
                  id="account-password"
                  type="password"
                  value={form.password}
                  onChange={(e) => set("password", e.target.value)}
                  placeholder={editing ? "••••••••" : "mot de passe (ou d'application)"}
                  required={!editing}
                  autoComplete="new-password"
                />
              </div>
            </div>

            <Separator />

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="account-interval">Synchronisation auto.</Label>
                <Select
                  value={form.syncIntervalMin}
                  onValueChange={(v) => set("syncIntervalMin", v)}
                >
                  <SelectTrigger id="account-interval">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="5">Toutes les 5 min</SelectItem>
                    <SelectItem value="15">Toutes les 15 min</SelectItem>
                    <SelectItem value="30">Toutes les 30 min</SelectItem>
                    <SelectItem value="60">Toutes les heures</SelectItem>
                    <SelectItem value="360">Toutes les 6 h</SelectItem>
                    <SelectItem value="1440">Quotidienne</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="account-fetchdays">Historique initial</Label>
                <Select value={form.fetchDays} onValueChange={(v) => set("fetchDays", v)}>
                  <SelectTrigger id="account-fetchdays">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="7">7 derniers jours</SelectItem>
                    <SelectItem value="30">30 derniers jours</SelectItem>
                    <SelectItem value="90">90 derniers jours</SelectItem>
                    <SelectItem value="365">1 an</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2">
              <div>
                <Label htmlFor="account-selfsigned" className="text-sm">
                  Certificat auto-signé
                </Label>
                <p className="text-xs text-muted-foreground">
                  Serveurs internes/QA uniquement — déconseillé sinon
                </p>
              </div>
              <Switch
                id="account-selfsigned"
                checked={form.allowSelfSigned}
                onCheckedChange={(v) => set("allowSelfSigned", v)}
              />
            </div>

            {testResult && (
              <div
                role="status"
                className={`rounded-lg border p-3 text-xs leading-relaxed ${
                  testResult.ok
                    ? "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400"
                    : "border-destructive/30 bg-destructive/5 text-destructive"
                }`}
              >
                {testResult.message}
              </div>
            )}

            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleTest}
                disabled={test.isPending}
                className="gap-1.5"
              >
                {test.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Server className="size-4" aria-hidden />
                )}
                Tester la connexion
              </Button>
              <Button type="submit" disabled={!canSubmit || create.isPending || update.isPending}>
                {create.isPending || update.isPending ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                ) : (
                  <Check className="size-4" aria-hidden />
                )}
                {editing ? "Enregistrer" : "Connecter le compte"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ---- Confirmation suppression ---- */}
      <AlertDialog open={confirmDelete !== null} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer ce compte ?</AlertDialogTitle>
            <AlertDialogDescription>
              « {confirmDelete?.address} » sera déconnecté et son mot de passe chiffré supprimé.
              Les {confirmDelete?.emailCount ?? 0} emails déjà synchronisés restent consultables
              dans votre boîte Orbit.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              Supprimer
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
