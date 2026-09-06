"use client";

// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Moteur de synchronisation bidirectionnelle (local ↔ serveur)
// ───────────────────────────────────────────────────────────────────────────
// Orchestrateur offline-first :
//   PUSH  : replay de l'outbox Dexie (lib/offline-queue — waiters UI inclus) ;
//   PULL  : GET /api/sync/changes?since=<curseur> (delta + tombstones) avec
//           retry exponentiel (lib/network/retry-strategy) ;
//   MERGE : 3-way (base = cliché serveur au moment de la modif locale) :
//           auto-merge champs disjoints → LWW → conflit utilisateur ;
//   CURSEUR: serverTimestamp (horloge SERVEUR) — jamais l'horloge client.
//
// Déclencheurs : retour du réseau (online), Background Sync SW (message
// SYNC_REQUESTED), fin de replay (orbit:data-synced), périodique 30 s,
// manuel (badge de statut / réglages).
// ═══════════════════════════════════════════════════════════════════════════

import { create } from "zustand";
import type { Table, UpdateSpec } from "dexie";
import {
  db,
  syncedMeta,
  getSyncMeta,
  setSyncMeta,
  ENTITY_TABLES,
  type SyncResult,
  type LocalEvent,
  type LocalTask,
  type LocalEmail,
  type SyncedEntity,
} from "./indexeddb";
import { queueManager } from "./queue-manager";
import { conflictResolver } from "./conflict-resolver";
import { connectionMonitor } from "@/lib/network/connection-monitor";
import { networkRetry, isNetworkError } from "@/lib/network/retry-strategy";
import { syncPullCache } from "@/lib/cache/lru-cache";
import { maybeEvictCache } from "@/lib/cache/storage-manager";
import { replayQueue } from "@/lib/offline-queue";
import type { EventDto, TaskDto, EmailDto } from "@/lib/types";

const isBrowser = typeof window !== "undefined";
const SYNC_INTERVAL_MS = 30_000;
/** Après un 401 (session absente/expirée) : reprise progressive. */
const AUTH_RETRY_SCHEDULE_MS = [15_000, 30_000, 60_000, 120_000, 300_000];

// ── État réactif pour l'UI (badge, réglages) ────────────────────────────────

interface SyncUiState {
  syncing: boolean;
  lastSyncAt: string | null;
  conflicts: number;
  lastResult: SyncResult | null;
  setSyncing: (syncing: boolean) => void;
  setLastSyncAt: (iso: string | null) => void;
  setConflicts: (count: number) => void;
  setLastResult: (result: SyncResult | null) => void;
}

export const useSyncStore = create<SyncUiState>((set) => ({
  syncing: false,
  lastSyncAt: null,
  conflicts: 0,
  lastResult: null,
  setSyncing: (syncing) => set({ syncing }),
  setLastSyncAt: (lastSyncAt) => set({ lastSyncAt }),
  setConflicts: (conflicts) => set({ conflicts }),
  setLastResult: (lastResult) => set({ lastResult }),
}));

// ── Réponse du pull delta ──────────────────────────────────────────────────

interface SyncChangesResponse {
  events: EventDto[];
  tasks: TaskDto[];
  emails: EmailDto[];
  deleted: { events: string[]; tasks: string[]; emails: string[] };
  serverTimestamp: string;
}

type MergeOutcome = "pulled" | "seen" | "kept-local" | "merged" | "conflict" | "resurrected";

// ── Moteur ─────────────────────────────────────────────────────────────────

class SyncEngine {
  private syncing = false;
  private started = false;
  private interval: ReturnType<typeof setInterval> | null = null;
  private lastAuthFailure = 0;
  private authFailures = 0;
  private onlineHandler = () => {
    void this.sync();
  };
  private dataSyncedHandler = () => {
    // Le replay a modifié le serveur → pull immédiat (fusion tombstones/delta)
    void this.pull().catch(() => {});
  };
  private sessionChangedHandler = () => {
    // Login/register/demo : la session vient d'être établie — sync immédiate
    // (l'app a pu démarrer sur l'écran de connexion → premier pull en 401).
    this.authFailures = 0;
    this.lastAuthFailure = 0;
    void this.sync();
  };

  /** Démarre : listeners + sync périodique + tir initial. Idempotent. */
  start(): void {
    if (!isBrowser || this.started) return;
    this.started = true;
    connectionMonitor.on("online", this.onlineHandler);
    window.addEventListener("orbit:data-synced", this.dataSyncedHandler);
    window.addEventListener("orbit:session-changed", this.sessionChangedHandler);
    this.interval = setInterval(() => {
      if (connectionMonitor.isEffectiveOnline() && Date.now() - this.lastAuthFailure > this.authRetryDelay()) {
        void this.sync();
      }
    }, SYNC_INTERVAL_MS);
    if (connectionMonitor.isEffectiveOnline()) {
      void this.sync();
    }
  }

  stop(): void {
    if (!isBrowser) return;
    connectionMonitor.off("online", this.onlineHandler);
    window.removeEventListener("orbit:data-synced", this.dataSyncedHandler);
    window.removeEventListener("orbit:session-changed", this.sessionChangedHandler);
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.started = false;
  }

  /** Délai courant avant une nouvelle tentative après 401 (progressif). */
  private authRetryDelay(): number {
    return AUTH_RETRY_SCHEDULE_MS[Math.min(this.authFailures, AUTH_RETRY_SCHEDULE_MS.length - 1)];
  }

  /** Synchronisation complète : push (outbox) puis pull (delta). */
  async sync(): Promise<SyncResult> {
    const result: SyncResult = {
      success: true,
      pushed: 0,
      pulled: 0,
      conflicts: 0,
      errors: [],
    };
    if (this.syncing) {
      return { ...result, success: false, reason: "already_syncing" };
    }
    if (!connectionMonitor.isEffectiveOnline()) {
      return { ...result, success: false, reason: "offline" };
    }

    this.syncing = true;
    useSyncStore.getState().setSyncing(true);
    try {
      // 1. PUSH — replay de l'outbox (toasts + invalidation via événement)
      const push = await replayQueue({ silent: false });
      result.pushed = push.synced;
      if (push.failed > 0) {
        result.errors.push(`${push.failed} action(s) refusée(s) par le serveur`);
      }

      // 2. PULL — delta + tombstones + fusion
      const pull = await this.pull();
      result.pulled = pull.pulled;
      result.conflicts = pull.conflicts;
      if (pull.unauthenticated) {
        result.success = false;
        result.reason = "unauthenticated";
      }
    } catch (error) {
      result.success = false;
      result.errors.push(error instanceof Error ? error.message : "Erreur de synchronisation inconnue");
    } finally {
      this.syncing = false;
      useSyncStore.getState().setSyncing(false);
      useSyncStore.getState().setLastResult(result);
    }
    return result;
  }

  /**
   * Pull delta → merge local. Public (appelé par le Background Sync et
   * orbit:data-synced). Ne lève pas — les erreurs remontent via sync().
   */
  async pull(): Promise<{ pulled: number; conflicts: number; unauthenticated: boolean }> {
    if (!isBrowser || !connectionMonitor.isEffectiveOnline()) {
      return { pulled: 0, conflicts: 0, unauthenticated: false };
    }

    const since = ((await getSyncMeta("lastSyncAt")) as string | undefined) ?? new Date(0).toISOString();

    // Coalescence : deux pulls du même curseur à < 3 s d'écart → un seul merge
    if (syncPullCache.get(`pull:${since}`)) {
      return { pulled: 0, conflicts: 0, unauthenticated: false };
    }
    syncPullCache.set(`pull:${since}`, true);

    const res = await networkRetry.run(
      () =>
        fetch(`/api/sync/changes?since=${encodeURIComponent(since)}`, {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        }),
      isNetworkError
    );

    if (res.status === 401) {
      this.lastAuthFailure = Date.now();
      this.authFailures++;
      return { pulled: 0, conflicts: 0, unauthenticated: true };
    }
    if (!res.ok) {
      throw new Error(`Synchronisation impossible (HTTP ${res.status})`);
    }

    const data = (await res.json()) as SyncChangesResponse;
    // Succès → la session est valide : reprise immédiate du rythme normal
    this.authFailures = 0;
    this.lastAuthFailure = 0;
    let pulled = 0;
    let conflicts = 0;

    for (const dto of data.events) {
      const outcome = await this.mergeOne("event", dto);
      if (outcome === "pulled") pulled++;
      else if (outcome === "conflict") conflicts++;
    }
    for (const dto of data.tasks) {
      const outcome = await this.mergeOne("task", dto);
      if (outcome === "pulled") pulled++;
      else if (outcome === "conflict") conflicts++;
    }
    for (const dto of data.emails) {
      const outcome = await this.mergeOne("email", dto);
      if (outcome === "pulled") pulled++;
      else if (outcome === "conflict") conflicts++;
    }
    for (const id of data.deleted.events) await this.applyTombstone("event", id);
    for (const id of data.deleted.tasks) await this.applyTombstone("task", id);
    for (const id of data.deleted.emails) await this.applyTombstone("email", id);

    await setSyncMeta("lastSyncAt", data.serverTimestamp);
    useSyncStore.getState().setLastSyncAt(data.serverTimestamp);
    useSyncStore.getState().setConflicts(conflicts);

    window.dispatchEvent(
      new CustomEvent("orbit:sync-completed", { detail: { pulled, conflicts, serverTimestamp: data.serverTimestamp } })
    );

    // Garde-fou quota (best-effort, jamais bloquant)
    void maybeEvictCache().catch(() => {});

    return { pulled, conflicts, unauthenticated: false };
  }

  // ── Fusion d'une entité serveur ──────────────────────────────────────────

  private async mergeOne(
    entity: SyncedEntity,
    dto: EventDto | TaskDto | EmailDto
  ): Promise<MergeOutcome> {
    if (entity === "event") return this.mergeRecord(db.events, "event", dto as EventDto);
    if (entity === "task") return this.mergeRecord(db.tasks, "task", dto as TaskDto);
    return this.mergeRecord(db.emails, "email", dto as EmailDto);
  }

  private async mergeRecord<
    L extends {
      id: string;
      _syncStatus: string;
      _lastSyncedAt?: string;
      _localUpdatedAt: string;
      _serverUpdatedAt?: string;
      _serverVersion?: unknown;
      _version: number;
    },
    D extends { id: string; updatedAt: string }
  >(table: Table<L, string>, entity: SyncedEntity, dto: D): Promise<MergeOutcome> {
    const local = await table.get(dto.id);

    // Entité inconnue localement → simple insertion
    if (!local) {
      await table.put({ ...dto, ...syncedMeta(dto.updatedAt) } as unknown as L);
      return "pulled";
    }

    // Déjà vue (delta retransmis / notre propre push)
    if (dto.updatedAt <= (local._serverUpdatedAt ?? "")) return "seen";

    if (local._syncStatus === "synced") {
      await table.put({ ...dto, ...syncedMeta(dto.updatedAt, local._version) } as unknown as L);
      return "pulled";
    }

    // Suppression locale en attente vs modification serveur → LWW
    if (local._syncStatus === "deleted") {
      if (Date.parse(local._localUpdatedAt) > Date.parse(dto.updatedAt)) return "kept-local";
      // Le serveur a ressuscité l'entité (modif plus récente) → on abandonne la
      // suppression locale et on prend l'état serveur
      await queueManager.dropOpsFor(entity, dto.id);
      await table.put({ ...dto, ...syncedMeta(dto.updatedAt, local._version) } as unknown as L);
      return "resurrected";
    }

    // pending / conflict → merge 3-way (base = cliché serveur au moment de la
    // modification locale, conservé dans _serverVersion)
    const base = (local._serverVersion ?? null) as Record<string, unknown> | null;
    type AnyLocalRecord = LocalEvent | LocalTask | LocalEmail;
    const resolution = conflictResolver.resolve<AnyLocalRecord>(
      local as unknown as AnyLocalRecord,
      base,
      dto as unknown as AnyLocalRecord
    );

    if (resolution === null) {
      // Conflit utilisateur : on conserve les deux versions + le drapeau
      await table.update(dto.id, {
        _syncStatus: "conflict",
        _serverVersion: { ...dto } as unknown,
        _serverUpdatedAt: dto.updatedAt,
      } as unknown as UpdateSpec<L>);
      return "conflict";
    }

    if (resolution.strategy === "server") {
      await queueManager.dropOpsFor(entity, dto.id);
      await table.put({ ...dto, ...syncedMeta(dto.updatedAt, local._version) } as unknown as L);
      return "pulled";
    }

    if (resolution.strategy === "local") {
      // L'op locale repartira au prochain push ; on mémorise la version serveur
      // vue pour ne pas re-déclencher le conflit au pull suivant
      await table.update(dto.id, {
        _serverUpdatedAt: dto.updatedAt,
      } as unknown as UpdateSpec<L>);
      return "kept-local";
    }

    // merged : données fusionnées, l'op locale reste en file (elle poussera
    // l'état fusionné le moment venu)
    await table.put({
      ...resolution.data,
      _syncStatus: "pending",
      _lastSyncedAt: local._lastSyncedAt,
      _localUpdatedAt: local._localUpdatedAt,
      _serverUpdatedAt: dto.updatedAt,
      _serverVersion: local._serverVersion,
      _version: local._version + 1,
    } as unknown as L);
    return "merged";
  }

  /** Tombstone : suppression serveur → retrait du cache local + ops associées. */
  private async applyTombstone(entity: SyncedEntity, id: string): Promise<void> {
    if (!id) return;
    try {
      await ENTITY_TABLES[entity]().delete(id);
      await queueManager.dropOpsFor(entity, id);
    } catch {
      // silencieux
    }
  }

  /**
   * Résolution MANUELLE d'un conflit (réglages) : garder la version locale
   * (l'op repartira en push) ou la version serveur (ops abandonnées).
   */
  async resolveConflictManually(
    entity: SyncedEntity,
    entityId: string,
    choice: "local" | "server"
  ): Promise<void> {
    const table = ENTITY_TABLES[entity]() as Table<LocalEvent | LocalTask | LocalEmail, string>;
    const local = await table.get(entityId);
    if (!local) return;

    if (choice === "local") {
      await table.update(entityId, {
        _syncStatus: "pending",
        _localUpdatedAt: new Date().toISOString(),
      });
      return;
    }

    const server = local._serverVersion as Partial<LocalEvent | LocalTask | LocalEmail> | undefined;
    await queueManager.dropOpsFor(entity, entityId);
    if (server && typeof server.id === "string" && typeof server.updatedAt === "string") {
      await table.put({ ...server, ...syncedMeta(server.updatedAt, local._version) } as LocalEvent & LocalTask & LocalEmail);
    } else {
      await table.delete(entityId);
    }
  }
}

/** Singleton (client uniquement — l'import serveur est un no-op sûr). */
export const syncEngine = new SyncEngine();

/** Démarre le moteur (appelé par PwaRegister après l'enregistrement du SW). */
export function startSyncEngine(): void {
  syncEngine.start();
}

/** Sync manuelle (badge / réglages / Background Sync). */
export function triggerSync(): Promise<SyncResult> {
  return syncEngine.sync();
}
