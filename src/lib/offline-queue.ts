"use client";

// ═══════════════════════════════════════════════════════════════════════════
// Orbit — File d'attente des mutations hors ligne (Task 7) — usage client
// ───────────────────────────────────────────────────────────────────────────
// Quand la connexion tombe, les actions d'écriture (créer/éditer/déplacer
// une tâche, marquer un email lu…) sont stockées dans IndexedDB (outbox) et
// rejouées DANS L'ORDRE dès le retour du réseau :
//   • déclencheurs : événement « online », montage de l'app, garde 60 s ;
//   • chaque élément rejoué avec les cookies de session (same-origin) ;
//   • 4xx → l'action est abandonnée (état serveur divergent) et signalée ;
//   • 5xx / réseau → l'élément RESTE en file (nouvelle tentative plus tard) ;
//   • après un replay réussi, un événement « orbit:data-synced » est émis →
//     React Query invalide TOUTES les requêtes (données rafraîchies).
//
// Les lectures hors ligne sont gérées par le Service Worker v4 (cache des
// GET /api, network-first) — cf. public/sw.js.
// ═══════════════════════════════════════════════════════════════════════════

import { create } from "zustand";
import { toast } from "sonner";

/** Élément mis en file (uniquement method+url+body — jamais de fichier). */
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

// ── IndexedDB (aucune dépendance — IDB brut) ────────────────────────────────

const DB_NAME = "orbit-offline";
const STORE = "queue";
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB indisponible"));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: "id" });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error ?? new Error("IndexedDB indisponible"));
      };
    });
  }
  return dbPromise;
}

function idbRequest<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => resolve(req.result as T);
        req.onerror = () => reject(req.error);
      })
  );
}

// ── File d'attente ──────────────────────────────────────────────────────────

/** Attente de l'api() en cours pendant que l'élément est en file. */
type Waiter = { resolve: (outcome: QueueOutcome) => void; timer: ReturnType<typeof setTimeout> };
const waiters = new Map<string, Waiter>();

/** Anti-concurrence : un seul replay à la fois. */
let replaying = false;
let seqCounter = Date.now();

/** Compteur réactif rafraîchi à chaque changement de file (public : PwaRegister). */
export async function refreshCount(): Promise<void> {
  const items = await getQueued().catch(() => [] as QueuedMutation[]);
  useOfflineQueueStore.getState().setCount(items.length);
}

/** Ajoute une mutation à la file (appelée par api() quand le réseau tombe). */
export async function enqueueMutation(
  url: string,
  method: string,
  body: string | null,
  label: string
): Promise<QueuedMutation> {
  const item: QueuedMutation = {
    id: `q-${(++seqCounter).toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    seq: seqCounter,
    url,
    method: method.toUpperCase(),
    body,
    label,
    createdAt: Date.now(),
  };
  await idbRequest("readwrite", (s) => s.put(item));
  await refreshCount();
  return item;
}

/** Contenu de la file, trié FIFO. */
export async function getQueued(): Promise<QueuedMutation[]> {
  const items = await idbRequest<QueuedMutation[]>("readonly", (s) => s.getAll());
  return items.sort((a, b) => a.seq - b.seq);
}

/** Attend le résultat du replay de l'élément (l'app offline reste « en cours »). */
export function waitForOutcome(id: string, timeoutMs = 15 * 60_000): Promise<QueueOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(id);
      // L'élément RESTE en file (il sera synchronisé plus tard, même app fermée
      // au retour : le replay au montage s'en charge) — seule l'UI renonce.
      resolve({ ok: false, status: 0, error: "Hors ligne depuis trop longtemps — l'action sera synchronisée à la reconnexion." });
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

/** 4xx (hors 408/429) = refus définitif du serveur → abandon, pas de retry. */
function isPermanentFailure(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
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
    const items = await getQueued();
    const errors: string[] = [];

    for (const item of items) {
      let outcome: QueueOutcome;
      try {
        const res = await fetch(item.url, {
          method: item.method,
          headers: item.body !== null ? { "Content-Type": "application/json" } : undefined,
          body: item.body,
          credentials: "same-origin",
        });
        const data = await res.json().catch(() => null);
        if (res.ok) {
          outcome = { ok: true, status: res.status, data };
          result.synced++;
        } else if (isPermanentFailure(res.status)) {
          // 4xx : refus définitif pour CETTE action (état serveur divergent,
          // ex. 409 conflit) — on l'abandonne et on CONTINUE la file.
          outcome = {
            ok: false,
            status: res.status,
            error: (data as { error?: string } | null)?.error ?? `Erreur ${res.status}`,
          };
          result.failed++;
          errors.push(`« ${item.label} » refusée (${res.status})`);
        } else {
          // 5xx : le serveur est en difficulté → on garde TOUT le reste en file
          outcome = { ok: false, status: res.status, error: `Erreur ${res.status}` };
          break;
        }
      } catch {
        // réseau encore coupé → on garde le reste en file
        outcome = { ok: false, status: 0, error: "Réseau indisponible" };
        break;
      }

      await idbRequest("readwrite", (s) => s.delete(item.id));
      settleWaiter(item.id, outcome);
    }

    result.remaining = (await getQueued()).length;
    useOfflineQueueStore.getState().setCount(result.remaining);

    if (result.synced > 0) {
      // Données modifiées côté serveur → React Query rafraîchit tout
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
  await idbRequest("readwrite", (s) => s.clear());
  await refreshCount();
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
  };
}
