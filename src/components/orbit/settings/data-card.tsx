"use client";

// Orbit — Réglages › Données : import/export (JSON, CSV, iCal) — features avancées
// ─────────────────────────────────────────────────────────────────────────────
// Export JSON = sauvegarde complète (événements + tâches + étiquettes) ;
// Export CSV = tableur des tâches ; Export iCal = lien vers /api/events/export.
// Import JSON = ré-injection idempotente (événements dédoublonnés par externalId).
// Après import : événement global « orbit:data-synced » → les caches React
// Query se rafraîchissent (même mécanisme que la file offline).

import { useRef, useState } from "react"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { api } from "@/lib/api-client"
import { useI18n } from "@/lib/i18n/provider"
import {
  Database,
  Download,
  FileJson,
  FileSpreadsheet,
  CalendarClock,
  Upload,
  Loader2,
} from "lucide-react"

/** Télécharge un blob en fichier (revocation de l'URL incluse). */
function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export function DataCard() {
  const { t } = useI18n()
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<"json" | "csv" | "import" | null>(null)

  async function handleExport(format: "json" | "csv") {
    setBusy(format)
    try {
      const res = await fetch(`/api/export?format=${format}`)
      if (!res.ok) throw new Error(`Export ${res.status}`)
      const blob = await res.blob()
      const ext = format === "json" ? "json" : "csv"
      downloadBlob(blob, `orbit-${format === "json" ? "backup" : "tasks"}-${new Date().toISOString().slice(0, 10)}.${ext}`)
      toast.success(t("settings.exported"))
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  async function handleImportFile(file: File) {
    setBusy("import")
    try {
      const text = await file.text()
      const json = JSON.parse(text) as unknown
      const result = await api<{
        imported: { events: number; tasks: number }
        skipped: { events: number }
        warnings: string[]
      }>("/api/export", { method: "POST", body: JSON.stringify(json) })
      toast.success(t("settings.importSuccess"), {
        description: `${result.imported.events} événement(s) · ${result.imported.tasks} tâche(s)${result.skipped.events ? ` · ${result.skipped.events} doublon(s)` : ""}`,
      })
      // Rafraîchit tous les caches (même événement que la sync offline).
      window.dispatchEvent(new CustomEvent("orbit:data-synced"))
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setBusy(null)
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  return (
    <Card className="border-border/60 bg-card/70 backdrop-blur-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <Database className="size-4 text-primary" aria-hidden />
          {t("settings.data")}
        </CardTitle>
        <CardDescription>{t("settings.dataDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Button
            variant="outline"
            size="sm"
            className="justify-start"
            onClick={() => handleExport("json")}
            disabled={busy !== null}
          >
            {busy === "json" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <FileJson className="size-4" aria-hidden />}
            {t("settings.exportJson")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="justify-start"
            onClick={() => handleExport("csv")}
            disabled={busy !== null}
          >
            {busy === "csv" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <FileSpreadsheet className="size-4" aria-hidden />}
            {t("settings.exportCsv")}
          </Button>
          {/* iCal : route d'export existante (téléchargement direct) */}
          <a
            href="/api/events/export"
            className="inline-flex h-8 items-center justify-start gap-2 whitespace-nowrap rounded-md border border-input bg-background px-3 text-sm font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
            download
          >
            <CalendarClock className="size-4" aria-hidden />
            {t("settings.exportIcal")}
          </a>
          <Button
            variant="outline"
            size="sm"
            className="justify-start"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy !== null}
          >
            {busy === "import" ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Upload className="size-4" aria-hidden />}
            {t("settings.importJson")}
          </Button>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          aria-label={t("settings.importPick")}
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void handleImportFile(file)
          }}
        />

        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-muted-foreground">
          <Download className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          {t("settings.dataNote")}
        </p>
      </CardContent>
    </Card>
  )
}
