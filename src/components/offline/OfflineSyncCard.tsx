"use client";

// Orbit — Carte « Synchronisation hors ligne » (réglages, offline-first v2)
// Console complète : statut sync, simulation de coupure (démo/QA sans
// DevTools), file d'attente, conflits, stockage local.

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, WifiOff } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import { toast } from "sonner";
import { PendingOperationsList } from "@/components/offline/PendingOperationsList";
import { useConnectionInfo, setSimulatedOffline } from "@/hooks/useOnlineStatus";
import { useSyncStatus } from "@/hooks/useSyncStatus";

export function OfflineSyncCard() {
  const { online, simulated } = useConnectionInfo();
  const { isSyncing, lastSyncAt, pendingCount, conflicts, sync } = useSyncStatus();

  return (
    <Card className="border-border/60 bg-card/70 backdrop-blur-sm lg:col-span-2">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base font-medium">
          <WifiOff className="size-4 text-primary" aria-hidden />
          Synchronisation hors ligne
        </CardTitle>
        <CardDescription>
          Cache local IndexedDB, file d&apos;attente des opérations et fusion
          multi-appareils (dernière modification prioritaire).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Statut + actions rapides */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={online ? "secondary" : "destructive"} className="gap-1.5">
            {online ? "En ligne" : "Hors ligne"}
          </Badge>
          {isSyncing && (
            <Badge className="gap-1.5 bg-primary/15 text-primary">
              <RefreshCw className="size-3 animate-spin" aria-hidden />
              Synchronisation…
            </Badge>
          )}
          {!isSyncing && lastSyncAt && (
            <Badge variant="outline" className="gap-1.5 font-normal text-muted-foreground">
              Dernière sync{" "}
              {formatDistanceToNow(new Date(lastSyncAt), { addSuffix: true, locale: fr })}
            </Badge>
          )}
          {pendingCount > 0 && (
            <Badge
              variant="outline"
              className="gap-1.5 border-amber-500/40 text-amber-600 dark:text-amber-400"
            >
              {pendingCount} en attente
            </Badge>
          )}
          {conflicts > 0 && (
            <Badge variant="destructive" className="gap-1.5">
              {conflicts} conflit{conflicts > 1 ? "s" : ""}
            </Badge>
          )}
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">
          Hors ligne, vos données restent consultables (calendrier, tâches,
          emails) et vos actions sont enregistrées localement puis envoyées
          automatiquement au retour du réseau — dans l&apos;ordre, avec relance
          exponentielle en cas d&apos;échec. Les suppressions et modifications
          d&apos;autres appareils sont propagées à chaque synchronisation.
        </p>

        <Separator />

        {/* Simulation hors ligne (démo/QA) */}
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <Label className="text-sm">Simuler une coupure réseau</Label>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Testez le mode hors ligne sans couper le réseau : les vues passent
              sur le cache local et les mutations partent en file d&apos;attente.
            </p>
          </div>
          <Switch
            checked={simulated}
            onCheckedChange={(checked) => {
              setSimulatedOffline(checked);
              if (!checked) {
                toast.success("Réseau rétabli (simulation désactivée)", {
                  description: "Orbit resynchronise vos données maintenant.",
                });
              }
            }}
            aria-label="Simuler une coupure réseau"
          />
        </div>

        <Separator />

        <PendingOperationsList />
      </CardContent>
    </Card>
  );
}
