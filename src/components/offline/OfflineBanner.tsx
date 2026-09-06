"use client";

// Orbit — Bannière hors ligne (offline-first v2)
// Bandeau fin sous le header quand l'app est hors ligne (réel ou simulé).
// Distinction du wording : coupure réelle vs simulation (réglages/QA).

import { Alert, AlertDescription } from "@/components/ui/alert";
import { WifiOff } from "lucide-react";
import { useConnectionInfo } from "@/hooks/useOnlineStatus";
import { useSyncStatus } from "@/hooks/useSyncStatus";

export function OfflineBanner() {
  const { online, simulated } = useConnectionInfo();
  const { pendingCount } = useSyncStatus();

  if (online) return null;

  return (
    <Alert
      variant="destructive"
      role="status"
      aria-live="polite"
      className="mx-3 mt-3 items-center rounded-xl border-amber-500/40 bg-amber-500/10 text-amber-700 sm:mx-4 dark:text-amber-400 [&>svg]:text-amber-600 dark:[&>svg]:text-amber-400"
    >
      <WifiOff className="size-4 shrink-0" aria-hidden />
      <AlertDescription className="text-xs sm:text-sm text-amber-700 dark:text-amber-400">
        {simulated ? (
          <>
            <strong>Mode hors ligne simulé.</strong> Les données viennent du cache local
            {(pendingCount > 0 && ` — ${pendingCount} action(s) en file d'attente`) || ""}
            {" "}— désactivez la simulation dans les réglages pour resynchroniser.
          </>
        ) : (
          <>
            <strong>Vous êtes hors ligne.</strong> Les données viennent du cache local
            {pendingCount > 0 && ` (${pendingCount} action(s) en attente)`} — vos
            modifications seront synchronisées automatiquement au retour de la connexion.
          </>
        )}
      </AlertDescription>
    </Alert>
  );
}
