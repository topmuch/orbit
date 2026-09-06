"use client";

// Orbit — Dialog de composition d'email (envoi SMTP)
// ─────────────────────────────────────────────────────────────────────────────
// Modes : nouveau (« Écrire »), réponse, réponse à tous, transfert.
// • Compte expéditeur : Select des comptes avec SMTP configuré (canSend) ;
//   aucun → invitation à configurer (Réglages) au lieu d'un champ mort ;
// • Destinaires en champ texte séparé par virgules — validation locale avant
//   l'envoi (regex e-mail) + validation serveur (Zod) ;
// • Réponse : pré-remplissage De/Objet/citation + In-Reply-To (fil) via
//   replyToEmailId ;
// • Le mot de passe SMTP n'existe PAS ici : il est chiffré côté serveur.

import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"
import { Loader2, Send, Settings2, ChevronDown } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useEmailMutations } from "@/lib/api-client"
import type { OrbitView } from "@/lib/types"

/** Compte expéditeur minimal (issu de la liste emails ou des comptes complets). */
export type ComposeAccount = {
  id: string
  address: string
  label: string | null
  /** Envoi SMTP configuré */
  canSend: boolean
}

/** Brouillon d'ouverture du dialog (mode + pré-remplissages). */
export type ComposeDraft = {
  mode: "new" | "reply" | "replyAll" | "forward"
  accountId?: string
  to?: string[]
  cc?: string[]
  subject?: string
  /** Corps de l'email cité (réponse/transfert), déjà formaté. */
  quotedBody?: string
  /** Email auquel on répond → In-Reply-To/References (fil de discussion). */
  replyToEmailId?: string
}

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

function parseAddresses(raw: string): { emails: string[]; invalid: string[] } {
  const parts = raw
    .split(/[,;]+/)
    .map((s) => s.trim())
    .filter(Boolean)
  const emails: string[] = []
  const invalid: string[] = []
  for (const part of parts) (EMAIL_RE.test(part) ? emails : invalid).push(part)
  return { emails, invalid }
}

function modeLabel(mode: ComposeDraft["mode"]): string {
  return mode === "reply" || mode === "replyAll" ? "Répondre" : mode === "forward" ? "Transférer" : "Écrire"
}

export function ComposeDialog({
  open,
  onOpenChange,
  draft,
  accounts,
  onNavigate,
  onSent,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  draft: ComposeDraft | null
  accounts: ComposeAccount[]
  onNavigate?: (view: OrbitView) => void
  onSent?: () => void
}) {
  const { send } = useEmailMutations()

  const sendable = useMemo(() => accounts.filter((a) => a.canSend), [accounts])

  const [accountId, setAccountId] = useState("")
  const [to, setTo] = useState("")
  const [cc, setCc] = useState("")
  const [bcc, setBcc] = useState("")
  const [showCc, setShowCc] = useState(false)
  const [subject, setSubject] = useState("")
  const [body, setBody] = useState("")
  const [sending, setSending] = useState(false)

  // Pré-remplissage à chaque ouverture
  useEffect(() => {
    if (!open || !draft) return
    setAccountId(draft.accountId ?? sendable[0]?.id ?? "")
    setTo((draft.to ?? []).join(", "))
    setCc((draft.cc ?? []).join(", "))
    setShowCc((draft.cc?.length ?? 0) > 0)
    setBcc("")
    setSubject(draft.subject ?? "")
    setBody(draft.quotedBody ? `\n\n${draft.quotedBody}` : "")
  }, [open, draft, sendable])

  async function handleSend() {
    const toParsed = parseAddresses(to)
    const ccParsed = parseAddresses(cc)
    const bccParsed = parseAddresses(bcc)

    if (!accountId) {
      toast.error("Choisissez un compte expéditeur.")
      return
    }
    if (ccParsed.invalid.length || bccParsed.invalid.length) {
      toast.error("Certaines adresses (Cc/Cci) sont invalides.", {
        description: [...ccParsed.invalid, ...bccParsed.invalid].join(", "),
      })
      return
    }
    if (toParsed.invalid.length) {
      toast.error("Destinataire invalide.", { description: toParsed.invalid.join(", ") })
      return
    }
    if (!toParsed.emails.length) {
      toast.error("Au moins un destinataire est requis.")
      return
    }
    if (!subject.trim()) {
      toast.error("L'objet est requis.")
      return
    }
    if (!body.trim()) {
      toast.error("Le corps du message est requis.")
      return
    }

    setSending(true)
    try {
      const res = await send.mutateAsync({
        accountId,
        to: toParsed.emails,
        cc: ccParsed.emails.length ? ccParsed.emails : undefined,
        bcc: bccParsed.emails.length ? bccParsed.emails : undefined,
        subject: subject.trim(),
        bodyText: body,
        replyToEmailId: draft?.replyToEmailId,
      })
      if (res.rejected?.length) {
        toast.warning("Envoyé, mais certains destinataires ont été refusés", {
          description: res.rejected.join(", "),
        })
      } else {
        toast.success("Email envoyé ✉️", {
          description: `À : ${toParsed.emails.join(", ")}`,
        })
      }
      onSent?.()
      onOpenChange(false)
    } catch (err) {
      toast.error((err as Error).message || "Échec de l'envoi")
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !sending && onOpenChange(o)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{draft ? modeLabel(draft.mode) : "Écrire"}</DialogTitle>
          <DialogDescription>
            Envoi via le SMTP du compte choisi — copie conservée dans « Envoyés ».
          </DialogDescription>
        </DialogHeader>

        {sendable.length === 0 ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm">
            <p className="font-medium text-amber-700 dark:text-amber-400">Aucun compte avec envoi SMTP</p>
            <p className="mt-1 text-muted-foreground">
              Ajoutez le serveur SMTP d&apos;un compte existant (Gmail, Outlook…) pour pouvoir répondre.
            </p>
            {onNavigate && (
              <Button
                variant="outline"
                size="sm"
                className="mt-3 gap-1.5"
                onClick={() => onNavigate("settings")}
              >
                <Settings2 className="size-4" aria-hidden />
                Configurer dans les Réglages
              </Button>
            )}
          </div>
        ) : (
          <div className="grid gap-4 py-1">
            {/* Expéditeur */}
            <div className="grid gap-1.5">
              <Label htmlFor="compose-from">De</Label>
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger id="compose-from" className="w-full">
                  <SelectValue placeholder="Compte expéditeur" />
                </SelectTrigger>
                <SelectContent>
                  {sendable.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.label ? `${a.label} — ${a.address}` : a.address}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Destinataires */}
            <div className="grid gap-1.5">
              <Label htmlFor="compose-to">Pour</Label>
              <Input
                id="compose-to"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                placeholder="marie@exemple.fr, paul@exemple.fr"
                autoComplete="off"
                inputMode="email"
              />
              <button
                type="button"
                className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setShowCc((v) => !v)}
              >
                <ChevronDown className={`size-3 transition-transform ${showCc ? "" : "-rotate-90"}`} aria-hidden />
                Cc / Cci
              </button>
              {showCc && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <div className="grid gap-1.5">
                    <Label htmlFor="compose-cc">Cc</Label>
                    <Input
                      id="compose-cc"
                      value={cc}
                      onChange={(e) => setCc(e.target.value)}
                      placeholder="copie@exemple.fr"
                      autoComplete="off"
                      inputMode="email"
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="compose-bcc">Cci</Label>
                    <Input
                      id="compose-bcc"
                      value={bcc}
                      onChange={(e) => setBcc(e.target.value)}
                      placeholder="copie cachée@exemple.fr"
                      autoComplete="off"
                      inputMode="email"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Objet */}
            <div className="grid gap-1.5">
              <Label htmlFor="compose-subject">Objet</Label>
              <Input
                id="compose-subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Objet du message"
                maxLength={255}
              />
            </div>

            {/* Corps */}
            <div className="grid gap-1.5">
              <Label htmlFor="compose-body">Message</Label>
              <Textarea
                id="compose-body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={12}
                placeholder="Bonjour…"
                className="min-h-[220px] resize-y font-normal"
              />
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={sending}>
            Annuler
          </Button>
          <Button onClick={handleSend} disabled={sending || sendable.length === 0}>
            {sending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
            {sending ? "Envoi en cours…" : "Envoyer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
