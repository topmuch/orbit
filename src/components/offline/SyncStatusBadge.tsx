"use client";

// Orbit — Badge de statut de synchronisation (header, offline-first v2)
// États : hors ligne (réel/simulé) · synchronisation en cours · N en attente
// (clic = sync immédiate) · conflits (clic = réglages) · synchronisé + âge.
// Registre les clicks pour l'accessibilité (role button implicite via <button>).

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Cloud, CloudOff, Clock, RefreshCw, AlertTriangle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import { useConnectionInfo } from "@/hooks/useOnlineStatus";
import { useSyncStatus } from "@/hooks/useSyncStatus";

interface SyncStatusBadgeProps {
  /** Navigation vers les réglages (résolution des conflits). */
  onOpenSettings?: () => void;
}

export function SyncStatusBadge({ onOpenSettings }: SyncStatusBadgeProps) {
  const { online, simulated } = useConnectionInfo();
  const { pendingCount, isSyncing, lastSyncAt, conflicts, sync } = useSyncStatus();

  // ── Hors ligne (réel ou simulé) ───────────────────────────────────────────
  if (!online) {
    return (
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="destructive" className="mr-1 gap-1.5">
              <CloudOff className="size-3" aria-hidden />
              <span className="hidden sm:inline">
                {simulated ? "Hors ligne (simulation)" : "Hors ligne"}
              </span>
              {pendingCount > 0 && (
                <span className="tabular-nums">· {pendingCount}</span>
              )}
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {pendingCount > 0
              ? `${pendingCount} action(s) enregistrée(s) — envoyées à la reconnexion.`
              : "Consultation du cache local — les modifications seront mises en file."}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  // ── Synchronisation en cours ──────────────────────────────────────────────
  if (isSyncing) {
    return (
      <Badge className="mr-1 gap-1.5 bg-primary/15 text-primary border-primary/30">
        <RefreshCw className="size-3 animate-spin" aria-hidden />
        <span className="hidden sm:inline">Synchronisation…</span>
      </Badge>
    );
  }

  // ── Conflits à résoudre ───────────────────────────────────────────────────
  if (conflicts > 0) {
    return (
      <button
        type="button"
        onClick={() => onOpenSettings?.()}
        className="mr-1 inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-600 transition-colors hover:bg-amber-500/20 dark:text-amber-400"
        aria-label={`${conflicts} conflit(s) de synchronisation à résoudre — ouvrir les réglages`}
        title="Conflits de synchronisation — cliquer pour résoudre"
      >
        <AlertTriangle className="size-3" aria-hidden />
        <span className="tabular-nums">{conflicts}</span>
        <span className="hidden sm:inline">conflit{conflicts > 1 ? "s" : ""}</span>
      </button>
    );
  }

  // ── Opérations en attente (réseau revenu mais replay non encore fait) ────
  if (pendingCount > 0) {
    return (
      <button
        type="button"
        onClick={() => void sync()}
        className="mr-1 inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-xs font-medium text-amber-600 transition-colors hover:bg-amber-500/20 dark:text-amber-400"
        aria-label={`${pendingCount} action(s) hors ligne en attente de synchronisation — cliquer pour réessayer maintenant`}
        title="Actions enregistrées hors ligne — envoyées dès la reconnexion"
      >
        <Clock className="size-3" aria-hidden />
        <span className="tabular-nums">{pendingCount}</span>
        <span className="hidden sm:inline">en attente</span>
      </button>
    );
  }

  // ── Synchronisé ───────────────────────────────────────────────────────────
  return (
    <div className="mr-1 flex items-center gap-1">
      <TooltipProvider delayDuration={200}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="outline" className="gap-1.5 text-muted-foreground">
              <Cloud className="size-3" aria-hidden />
              <span className="hidden sm:inline">
                {lastSyncAt
                  ? `Sync ${formatDistanceToNow(new Date(lastSyncAt), {
                      addSuffix: true,
                      locale: fr,
                    })}`
                  : "Synchronisé"}
              </span>
            </Badge>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {lastSyncAt
              ? `Dernière synchronisation : ${new Date(lastSyncAt).toLocaleString("fr-FR")}`
              : "Jamais synchronisé"}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        onClick={() => void sync()}
        aria-label="Synchroniser maintenant"
        title="Synchroniser maintenant"
      >
        <RefreshCw className="size-3.5" aria-hidden />
      </Button>
    </div>
  );
}
