"use client";

// Orbit — Liste des opérations en attente + conflits + stockage (réglages)
// ───────────────────────────────────────────────────────────────────────────
// Console offline-first : outbox (opérations en file avec retry/erreur),
// conflits (garder local / garder serveur), usage du stockage + persistance.
// Données réactives : live queries Dexie (aucun polling).

import { useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { formatDistanceToNow } from "date-fns";
import { fr } from "date-fns/locale";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  CloudUpload,
  RefreshCw,
  AlertTriangle,
  HardDrive,
  Check,
  X,
  Database,
} from "lucide-react";
import { db, type PendingOperation, type SyncedEntity } from "@/lib/offline/indexeddb";
import { syncEngine } from "@/lib/offline/sync-engine";
import {
  getStorageEstimate,
  requestPersistentStorage,
  evictStaleEmails,
  purgeOfflineCaches,
  type StorageEstimateInfo,
} from "@/lib/cache/storage-manager";
import { useSyncStatus } from "@/hooks/useSyncStatus";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";

interface ConflictRow {
  entity: SyncedEntity;
  id: string;
  label: string;
  localAt: string;
  serverAt?: string;
}

const ENTITY_LABELS: Record<string, string> = {
  event: "Événement",
  task: "Tâche",
  email: "Email",
  tag: "Étiquette",
  other: "Action",
};

function entityBadgeClass(entity: string): string {
  switch (entity) {
    case "event":
      return "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400";
    case "task":
      return "border-cyan-500/40 bg-cyan-500/10 text-cyan-600 dark:text-cyan-400";
    case "email":
      return "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
    default:
      return "border-border bg-muted text-muted-foreground";
  }
}

export function PendingOperationsList() {
  const online = useOnlineStatus();
  const { sync } = useSyncStatus();
  const [storage, setStorage] = useState<StorageEstimateInfo | null>(null);
  const [resolving, setResolving] = useState(false);

  const ops: PendingOperation[] =
    useLiveQuery(() => db.pendingOperations.orderBy("seq").toArray(), []) ?? [];

  const conflicts: ConflictRow[] =
    useLiveQuery(async () => {
      const [events, tasks, emails] = await Promise.all([
        db.events.where("_syncStatus").equals("conflict").toArray(),
        db.tasks.where("_syncStatus").equals("conflict").toArray(),
        db.emails.where("_syncStatus").equals("conflict").toArray(),
      ]);
      return [
        ...events.map((e) => ({ entity: "event" as const, id: e.id, label: e.title, localAt: e._localUpdatedAt, serverAt: e._serverUpdatedAt })),
        ...tasks.map((t) => ({ entity: "task" as const, id: t.id, label: t.title, localAt: t._localUpdatedAt, serverAt: t._serverUpdatedAt })),
        ...emails.map((m) => ({ entity: "email" as const, id: m.id, label: m.subject, localAt: m._localUpdatedAt, serverAt: m._serverUpdatedAt })),
      ];
    }, []) ?? [];

  async function resolve(row: ConflictRow, choice: "local" | "server") {
    setResolving(true);
    try {
      await syncEngine.resolveConflictManually(row.entity, row.id, choice);
      toast.success(
        choice === "local"
          ? "Version locale conservée — elle sera renvoyée au serveur"
          : "Version serveur appliquée — modifications locales abandonnées"
      );
    } catch {
      toast.error("Résolution impossible");
    } finally {
      setResolving(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* ── Conflits ─────────────────────────────────────────────────────── */}
      <section aria-labelledby="offline-conflicts">
        <h4 id="offline-conflicts" className="mb-2 flex items-center gap-2 text-sm font-medium">
          <AlertTriangle className="size-4 text-amber-500" aria-hidden />
          Conflits de synchronisation
          {conflicts.length > 0 && (
            <Badge variant="destructive" className="tabular-nums">{conflicts.length}</Badge>
          )}
        </h4>

        {conflicts.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Aucun conflit en attente — les modifications concurrentes sont
            fusionnées automatiquement (champs disjoints) ou tranchées par
            horodatage.
          </p>
        ) : (
          <ul className="max-h-96 space-y-2 overflow-y-auto pr-1" role="list">
            {conflicts.map((row) => (
              <li
                key={`${row.entity}-${row.id}`}
                className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className={entityBadgeClass(row.entity)}>
                    {ENTITY_LABELS[row.entity]}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {row.label}
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Modifié localement{" "}
                  {formatDistanceToNow(new Date(row.localAt), { addSuffix: true, locale: fr })}
                  {row.serverAt &&
                    ` · modifié sur un autre appareil ${formatDistanceToNow(new Date(row.serverAt), {
                      addSuffix: true,
                      locale: fr,
                    })}`}{" "}
                  — impossible de trancher automatiquement.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1.5"
                    disabled={resolving}
                    onClick={() => void resolve(row, "local")}
                  >
                    <Check className="size-3.5" aria-hidden />
                    Garder ma version
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 gap-1.5"
                    disabled={resolving}
                    onClick={() => void resolve(row, "server")}
                  >
                    <X className="size-3.5" aria-hidden />
                    Garder la version serveur
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── Opérations en attente ───────────────────────────────────────── */}
      <section aria-labelledby="offline-pending">
        <h4 id="offline-pending" className="mb-2 flex items-center gap-2 text-sm font-medium">
          <CloudUpload className="size-4 text-primary" aria-hidden />
          Opérations en attente
          {ops.length > 0 && (
            <Badge variant="secondary" className="tabular-nums">{ops.length}</Badge>
          )}
        </h4>

        {ops.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            La file est vide — toutes vos actions sont synchronisées.
          </p>
        ) : (
          <>
            <ul className="max-h-96 space-y-2 overflow-y-auto pr-1" role="list">
              {ops.map((op) => (
                <li
                  key={op.id}
                  className="flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/30 p-2.5"
                >
                  <Badge variant="outline" className={entityBadgeClass(op.entity)}>
                    {ENTITY_LABELS[op.entity] ?? "Action"}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-sm">{op.data.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(op.timestamp), {
                      addSuffix: true,
                      locale: fr,
                    })}
                  </span>
                  {op.retryCount > 0 && (
                    <Badge
                      variant="outline"
                      className="border-amber-500/40 text-amber-600 dark:text-amber-400"
                      title={op.error ?? undefined}
                    >
                      retry {op.retryCount}/{op.maxRetries}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
            {online && (
              <Button
                size="sm"
                variant="outline"
                className="mt-2 h-7 gap-1.5"
                onClick={() => void sync()}
              >
                <RefreshCw className="size-3.5" aria-hidden />
                Envoyer maintenant
              </Button>
            )}
          </>
        )}
      </section>

      {/* ── Stockage ────────────────────────────────────────────────────── */}
      <section aria-labelledby="offline-storage">
        <h4 id="offline-storage" className="mb-2 flex items-center gap-2 text-sm font-medium">
          <HardDrive className="size-4 text-primary" aria-hidden />
          Stockage local
        </h4>
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {storage
                ? `${(storage.usage / 1_048_576).toFixed(1)} Mo utilisés${
                    storage.quota > 0 ? ` sur ~${(storage.quota / 1_048_576).toFixed(0)} Mo` : ""
                  }`
                : "Estimation indisponible"}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1.5"
              onClick={async () => setStorage(await getStorageEstimate())}
            >
              <Database className="size-3.5" aria-hidden />
              Mesurer
            </Button>
          </div>
          {storage && storage.quota > 0 && (
            <Progress value={Math.min(100, storage.ratio * 100)} aria-label="Usage du stockage" />
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={async () => {
                const granted = await requestPersistentStorage();
                toast[granted ? "success" : "info"](
                  granted ? "Stockage persistant accordé" : "Stockage persistant refusé par le navigateur"
                );
                setStorage(await getStorageEstimate());
              }}
            >
              Rendre persistant
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={async () => {
                const removed = await evictStaleEmails();
                toast.success(
                  removed > 0
                    ? `${removed} email(s) ancien(s) retirés du cache`
                    : "Aucun email ancien à évictionner"
                );
              }}
            >
              Évincir les vieux emails
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-destructive"
              onClick={async () => {
                await purgeOfflineCaches();
                toast.success("Caches offline vidés (réhydratation au prochain sync)");
              }}
            >
              Vider les caches
            </Button>
          </div>
        </div>
      </section>
    </div>
  );
}
