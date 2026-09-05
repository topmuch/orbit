"use client";

// ═══════════════════════════════════════════════════════════════════════════
// Orbit — AiSummaryDialog : synthèse IA d'un contenu long
// ───────────────────────────────────────────────────────────────────────────
// Dialog réutilisable (vue emails « Résumer », descriptions de tâches longues) :
// à l'ouverture il déclenche POST /api/ai/summarize (micro-service IA, cache
// 10 min) et affiche le résumé avec ses métriques.
// Le contenu est fourni par le parent et figé pendant l'ouverture du dialog.
// ═══════════════════════════════════════════════════════════════════════════

import { useEffect } from "react"
import Markdown from "react-markdown"
import { Loader2, Sparkles, FileText, RotateCcw } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useAISummary } from "@/lib/api-client"
import type { AISummary } from "@/lib/types"

const STYLE_LABELS: Record<AISummary["style"], string> = {
  bullet_points: "Points clés",
  paragraph: "Paragraphe",
  key_points: "Faits marquants",
}

export function AiSummaryDialog({
  open,
  onOpenChange,
  content,
  contextLabel = "ce contenu",
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Texte à résumer (≥ 200 caractères, tronqué à 12 000). */
  content: string
  /** Libellé du contexte, ex. « cet email », « cette description ». */
  contextLabel?: string
}) {
  const summarize = useAISummary()

  // Lancement de la synthèse à l'ouverture — le contenu est figé le temps du
  // dialog (aucune re-génération tant que l'utilisateur ne referme pas).
  useEffect(() => {
    if (!open) return
    void summarize.mutate({ content: content.trim().slice(0, 12_000) })
  }, [open])

  const summary = summarize.data?.summary

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 sm:max-w-lg">
        <DialogHeader className="pr-8">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-5 text-violet-500 dark:text-violet-400" aria-hidden="true" />
            Synthèse IA
          </DialogTitle>
          <DialogDescription>
            Résumé de {contextLabel} par le moteur IA local.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto px-6 pb-6 pt-1 orbit-scroll">
          {summarize.isPending ? (
            <div className="flex flex-col items-center gap-3 py-10 text-muted-foreground">
              <Loader2 className="size-7 animate-spin text-violet-500 dark:text-violet-400" aria-hidden="true" />
              <p className="text-sm">Synthèse en cours…</p>
            </div>
          ) : summarize.isError ? (
            <div className="space-y-3 py-8 text-center">
              <FileText className="mx-auto size-7 text-muted-foreground" aria-hidden="true" />
              <p className="text-sm text-destructive">
                {summarize.error instanceof Error ? summarize.error.message : "Synthèse indisponible"}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="gap-1.5"
                onClick={() => void summarize.mutate({ content: content.trim().slice(0, 12_000) })}
              >
                <RotateCcw className="size-3.5" aria-hidden="true" />
                Réessayer
              </Button>
            </div>
          ) : summary ? (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge
                  variant="secondary"
                  className="gap-1 border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300"
                >
                  <Sparkles className="size-3" aria-hidden="true" />
                  {STYLE_LABELS[summary.style] ?? "Points clés"}
                </Badge>
                <Badge variant="outline" className="text-xs font-normal">
                  {summary.originalLength} mots → {summary.summaryLength} mots
                </Badge>
              </div>
              {/* Le résumé peut contenir du markdown léger (gras, listes) :
                  rendu comme la conversation de l'assistant. */}
              <div className="space-y-1 text-[15px] leading-relaxed [&_li]:ml-4 [&_ol]:list-decimal [&_p:last-child]:mb-0 [&_strong]:font-semibold [&_ul]:list-disc">
                <Markdown>{summary.summary}</Markdown>
              </div>
              <p className="text-xs text-muted-foreground">
                Vérifiez les informations clés avant de vous appuyer sur cette synthèse.
              </p>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
