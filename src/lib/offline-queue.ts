"use client";

// ═══════════════════════════════════════════════════════════════════════════
// Orbit — File d'attente des mutations hors ligne (Task 7 → v2 Dexie)
// ───────────────────────────────────────────────────────────────────────────
// Quand la connexion tombe, les actions d'écriture (créer/éditer/déplacer
// une tâche, marquer un email lu…) sont stockées dans l'outbox Dexie
// (pendingOperations — entity/entityId/type/retryCount) avec application
// OPTIMISTE dans le cache local, puis rejouées DANS L'ORDRE à la reconnexion :
//   • déclencheurs : événement « online », montage, Background Sync (SW),
//     moteur de sync (30 s), garde 60 s ;
//   • chaque élément rejoué avec les cookies de session (same-origin) ;
//   • 4xx applicatif (409, 422…) → action abandonnée (état serveur divergent)
//     et entité locale marquée « conflict » ; 401/403 → l'action RESTE en file
//     (la session peut revenir) ;
//   • 5xx / réseau → retryCount++ (abandon après maxRetries=5) ;
//   • après un replay réussi : le cliché serveur remplace l'optimiste, un
//     événement « orbit:data-synced » est émis → React Query rafraîchit TOUT
//     et le moteur de sync tire le delta (tombstones comprises).
//
// Les lectures hors ligne : cache structuré Dexie (hooks useOffline*) + cache
// SW des GET /api (network-first) — cf. public/sw.js et lib/offline/.
// ═══════════════════════════════════════════════════════════════════════════

import { create } from "zustand";
import { toast } from "sonner";
import { db, setSyncMeta, getSyncMeta, type PendingOperation } from "@/lib/offline/indexeddb";
import { queueManager, deriveOperation, postPushApply, registerSyncTag } from "@/lib/offline/queue-manager";

/** Vue compatibilité d'une opération en file (outils de débogage). */
export interface QueuedMutation {
  id: string;
  seq: number; // ordre FIFO global
  url: string;
  method: string;
  body: string | null;
  label: string;
  createdAt: number;
}

/** Résultat du replay d'un élément (renvoyé aux promesses en attente). */
export interface QueueOutcome {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
}

// ── État réactif (badge « N en attente » dans le shell) ─────────────────────

interface OfflineQueueState {
  count: number;
  replaying: boolean;
  setCount: (count: number) => void;
  setReplaying: (replaying: boolean) => void;
}

export const useOfflineQueueStore = create<OfflineQueueState>((set) => ({
  count: 0,
  replaying: false,
  setCount: (count) => set({ count }),
  setReplaying: (replaying) => set({ replaying }),
}));

// ── Waiters (l'app offline reste « en cours » jusqu'au replay) ─────────────

type Waiter = { resolve: (outcome: QueueOutcome) => void; timer: ReturnType<typeof setTimeout> };
const waiters = new Map<string, Waiter>();

/** Anti-concurrence : un seul replay à la fois. */
let replaying = false;

/** Compteur réactif rafraîchi à chaque changement de file (public : PwaRegister). */
export async function refreshCount(): Promise<void> {
  try {
    const count = await queueManager.count();
    useOfflineQueueStore.getState().setCount(count);
  } catch {
    // IndexedDB indisponible (mode privé…) — silencieux
  }
}

/**
 * Ajoute une mutation à la file : dérivation sémantique (entité/id/type),
 * application OPTIMISTE locale, enregistrement, Background Sync programmé.
 */
export async function enqueueMutation(
  url: string,
  method: string,
  body: string | null,
  label: string
): Promise<QueuedMutation> {
  const op = await queueManager.enqueue(url, method, body, label);
  await refreshCount();
  return {
    id: op.id,
    seq: op.seq,
    url: op.data.url,
    method: op.data.method,
    body: op.data.body,
    label: op.data.label,
    createdAt: Date.parse(op.timestamp),
  };
}

/** Contenu de la file (vue compatibilité), trié FIFO. */
export async function getQueued(): Promise<QueuedMutation[]> {
  try {
    const ops = await queueManager.all();
    return ops.map((op) => ({
      id: op.id,
      seq: op.seq,
      url: op.data.url,
      method: op.data.method,
      body: op.data.body,
      label: op.data.label,
      createdAt: Date.parse(op.timestamp),
    }));
  } catch {
    return [];
  }
}

/** Attend le résultat du replay de l'élément (l'app offline reste « en cours »). */
export function waitForOutcome(id: string, timeoutMs = 15 * 60_000): Promise<QueueOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      // L'élément RESTE en file (il sera synchronisé plus tard, même app fermée
      // au retour : le replay au montage s'en charge) — seule l'UI renonce.
      resolve({
        ok: false,
        status: 0,
        error: "Hors ligne depuis trop longtemps — l'action sera synchronisée à la reconnexion.",
      });
    }, timeoutMs);
    waiters.set(id, { resolve, timer });
  });
}

function settleWaiter(id: string, outcome: QueueOutcome): void {
  const waiter = waiters.get(id);
  if (!waiter) return;
  waiters.delete(id);
  clearTimeout(waiter.timer);
  waiter.resolve(outcome);
}

/**
 * 4xx APPLICATIF = refus définitif du serveur pour CETTE action → abandon.
 * 401/403 : la session peut revenir (login) → on GARDE l'action en file.
 * 408/429 : transitoire → retry.
 */
function isPermanentFailure(status: number): boolean {
  return (
    status >= 400 &&
    status < 500 &&
    status !== 401 &&
    status !== 403 &&
    status !== 408 &&
    status !== 429
  );
}

/**
 * 4xx définitif : l'état serveur a divergé (409 conflit, 404 disparue…).
 * L'entité locale passe « conflict » (résolution manuelle dans les réglages),
 * la création temporaire éventuelle est retirée du cache.
 */
async function markOpConflict(op: PendingOperation): Promise<void> {
  try {
    if (op.tempLocalId) {
      if (op.entity === "task") await db.tasks.delete(op.tempLocalId);
      else if (op.entity === "event") await db.events.delete(op.tempLocalId);
      else if (op.entity === "email") await db.emails.delete(op.tempLocalId);
    }
    if (op.entityId && (op.entity === "task" || op.entity === "event" || op.entity === "email")) {
      const changes = {
        _syncStatus: "conflict" as const,
        _serverUpdatedAt: new Date().toISOString(),
      };
      if (op.entity === "task") await db.tasks.update(op.entityId, changes);
      else if (op.entity === "event") await db.events.update(op.entityId, changes);
      else await db.emails.update(op.entityId, changes);
    }
  } catch {
    // silencieux
  }
}

/**
 * Rejoue la file dans l'ordre. Retourne le bilan — ne lève JAMAIS (les
 * éléments en échec réseau restent en file pour la prochaine tentative).
 */
export async function replayQueue(opts: { silent?: boolean } = {}): Promise<{
  synced: number;
  failed: number;
  remaining: number;
}> {
  if (replaying || typeof window === "undefined") {
    return { synced: 0, failed: 0, remaining: 0 };
  }
  replaying = true;
  useOfflineQueueStore.getState().setReplaying(true);
  const result = { synced: 0, failed: 0, remaining: 0 };

  try {
    const ops = await queueManager.all();
    const errors: string[] = [];

    for (const op of ops) {
      let outcome: QueueOutcome;
      try {
        const res = await fetch(op.data.url, {
          method: op.data.method,
          headers: op.data.body !== null ? { "Content-Type": "application/json" } : undefined,
          body: op.data.body,
          credentials: "same-origin",
        });
        const data = await res.json().catch(() => null);

        if (res.ok) {
          // Succès : le cliché serveur remplace l'optimiste (id temporaire
          // supprimé), puis l'op quitte la file.
          await postPushApply(op, data);
          await queueManager.delete(op.id);
          outcome = { ok: true, status: res.status, data };
          result.synced++;
        } else if (res.status === 401 || res.status === 403) {
          // Session absente : l'action RESTE en file (elle est peut-être
          // légitime dès la reconnexion) — on stoppe le cycle.
          outcome = { ok: false, status: res.status, error: "Session requise" };
          break;
        } else if (isPermanentFailure(res.status)) {
          // 4xx applicatif : refus définitif pour CETTE action — on
          // l'abandonne et on CONTINUE la file.
          const message =
            (data as { error?: string } | null)?.error ?? `Erreur ${res.status}`;
          await markOpConflict(op);
          await queueManager.delete(op.id);
          outcome = { ok: false, status: res.status, error: message };
          result.failed++;
          errors.push(`« ${op.data.label} » refusée (${res.status})`);
        } else {
          // 5xx / 408 / 429 : le serveur est en difficulté → retry compté,
          // on garde TOUT le reste en file.
          const retryCount = op.retryCount + 1;
          if (retryCount >= op.maxRetries) {
            await queueManager.delete(op.id);
            outcome = {
              ok: false,
              status: res.status,
              error: `Abandon après ${op.maxRetries} tentatives`,
            };
            result.failed++;
            errors.push(`« ${op.data.label} » abandonnée après ${op.maxRetries} tentatives`);
          } else {
            await queueManager.update(op.id, { retryCount, error: `HTTP ${res.status}` });
            outcome = { ok: false, status: res.status, error: `Erreur ${res.status}` };
            break; // serveur instable → prochaine tentative plus tard
          }
        }
      } catch {
        // réseau encore coupé → on garde le reste en file
        outcome = { ok: false, status: 0, error: "Réseau indisponible" };
        break;
      }

      settleWaiter(op.id, outcome);
    }

    result.remaining = await queueManager.count().catch(() => 0);
    useOfflineQueueStore.getState().setCount(result.remaining);

    if (result.synced > 0) {
      // Données modifiées côté serveur → React Query rafraîchit tout + le
      // moteur de sync tire le delta (tombstones comprises).
      window.dispatchEvent(new CustomEvent("orbit:data-synced", { detail: result }));
    }

    if (!opts.silent && (result.synced > 0 || errors.length > 0)) {
      if (result.synced > 0) {
        toast.success(`${result.synced} action(s) synchronisée(s)`, {
          description: result.remaining
            ? `${result.remaining} encore en attente.`
            : "Vos données sont à jour.",
        });
      }
      for (const message of errors.slice(0, 3)) {
        toast.warning("Action non synchronisée", { description: message });
      }
    }
  } catch {
    // IndexedDB indisponible (mode privé…) — silencieux
  } finally {
    replaying = false;
    useOfflineQueueStore.getState().setReplaying(false);
  }

  return result;
}

/** Purge totale (aucune donnée conservée) — utilitaire de débogage. */
export async function clearQueue(): Promise<void> {
  await queueManager.clear().catch(() => {});
  await refreshCount();
}

// ── Migration de la file historique (IndexedDB brut, Task 7) ────────────────

/**
 * Importe l'ancienne file « orbit-offline » (IDB brut) dans l'outbox Dexie,
// puis purge l'ancien magasin. Idempotent (clé de métadonnée). Appelé une
 * fois par PwaRegister au montage.
 */
export async function importLegacyQueue(): Promise<void> {
  try {
    const migrated = (await getSyncMeta("legacyQueueMigrated")) as boolean | undefined;
    if (migrated) return;
    await setSyncMeta("legacyQueueMigrated", true);

    if (typeof indexedDB === "undefined") return;
    interface LegacyItem {
      url: string;
      method: string;
      body: string | null;
      label: string;
    }
    const legacy = await new Promise<LegacyItem[]>((resolve) => {
      const req = indexedDB.open("orbit-offline");
      req.onsuccess = () => {
        const database = req.result;
        if (!database.objectStoreNames.contains("queue")) {
          database.close();
          resolve([]);
          return;
        }
        const tx = database.transaction("queue", "readonly");
        const getAll = tx.objectStore("queue").getAll();
        getAll.onsuccess = () => resolve((getAll.result ?? []) as LegacyItem[]);
        getAll.onerror = () => resolve([]);
        tx.oncomplete = () => database.close();
      };
      req.onerror = () => resolve([]);
    });

    for (const item of legacy) {
      if (item && typeof item.url === "string") {
        await queueManager.enqueue(item.url, item.method ?? "POST", item.body ?? null, item.label ?? "Action");
      }
    }
    if (legacy.length > 0) await refreshCount();

    // Purge de l'ancien magasin (données désormais dans Dexie)
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase("orbit-offline");
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
  } catch {
    // silencieux — la migration est opportuniste
  }
}

// ── Libellés FR pour les toasts ─────────────────────────────────────────────

/** Libellé lisible d'une mutation mise en file. */
export function mutationLabel(path: string, method: string): string {
  if (path.startsWith("/api/tasks/") && path.includes("/move")) return "Déplacement de tâche";
  if (path.startsWith("/api/tasks/") && path.includes("/subtasks")) return "Sous-tâche";
  if (path.startsWith("/api/tasks/stats")) return "Statistiques";
  if (path.startsWith("/api/tasks/")) return method === "DELETE" ? "Suppression de tâche" : "Modification de tâche";
  if (path.startsWith("/api/tasks")) return method === "POST" ? "Création de tâche" : "Tâches";
  if (path.startsWith("/api/events/")) return method === "DELETE" ? "Suppression d'événement" : "Modification d'événement";
  if (path.startsWith("/api/events")) return method === "POST" ? "Création d'événement" : "Événements";
  if (path.startsWith("/api/tags/")) return "Étiquette";
  if (path.startsWith("/api/tags")) return "Étiquette";
  if (path.startsWith("/api/emails/")) return method === "DELETE" ? "Suppression d'email" : "Email";
  if (path.startsWith("/api/notifications/mark-read")) return "Notification lue";
  if (path.startsWith("/api/profile")) return "Profil";
  return "Action";
}

// ── Boutique de débogage dev-only (QA de la file sans coupure réseau) ────────

if (typeof window !== "undefined" && process.env.NODE_ENV === "development") {
  (window as unknown as Record<string, unknown>).__orbitOffline = {
    getQueued,
    replay: () => replayQueue({ silent: false }),
    clear: clearQueue,
    count: () => useOfflineQueueStore.getState().count,
    ops: () => queueManager.all(),
  };
}

// Ré-export pour les intégrateurs historiques (api-client importe dynamiquement)
export { deriveOperation, registerSyncTag };
