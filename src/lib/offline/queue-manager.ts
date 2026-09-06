"use client";

// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Queue manager : file d'opérations offline (outbox) + optimisme
// ───────────────────────────────────────────────────────────────────────────
// Toute mutation hors ligne devient une PendingOperation Dexie (entity,
// entityId, type, charge utile HTTP, retryCount/maxRetries) ET est appliquée
// OPTIMISTEMENT dans la table locale correspondante (_syncStatus: pending) :
// l'UI offline reflète immédiatement la modification (live queries Dexie).
//
//   enqueue()          → dérive l'opération de l'URL HTTP, applique l'optimiste,
//                        enregistre l'op, programme le Background Sync SW ;
//   applyOptimistic()  → miroir local des mutations connues (tâches, événements,
//                        emails) — champs inconnus ignorés sans erreur ;
//   postPushApply()    → après un replay RÉUSSI : le cliché serveur remplace
//                        l'optimiste (id temporaire supprimé) ;
//   dropOpsFor()       → abandon des opérations d'une entité (le serveur a gagné).
//
// L'envoi réel (replay) vit dans lib/offline-queue (intégration api()/waiters).
// ═══════════════════════════════════════════════════════════════════════════

import { db, pendingMeta, type PendingOperation, type OperationEntity, type OperationType, type LocalTask, type LocalEvent, type LocalEmail } from "./indexeddb";
import type { TaskStatus, TaskPriority } from "@/lib/types";

// ── Dérivation URL → opération typée ───────────────────────────────────────

export interface DerivedOperation {
  type: OperationType;
  entity: OperationEntity;
  entityId: string;
  /** true si l'URL porte ?hard=1 (suppression définitive de tâche). */
  hard: boolean;
}

/** Extrait l'id de ressource d'un segment d'URL (décodé). */
function pathId(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const id = rest.split("/")[0];
  return id ? decodeURIComponent(id) : null;
}

const TASK_SEGMENT = "/api/tasks/";
const EVENT_SEGMENT = "/api/events/";
const EMAIL_SEGMENT = "/api/emails/";

/**
 * Mappe une requête HTTP (url/méthode) vers l'opération sémantique
 * (entité + id + type). Les routes inconnues deviennent entity « other » —
 * elles restent synchronisées, sans optimisme local.
 */
export function deriveOperation(rawUrl: string, method: string): DerivedOperation {
  const url = new URL(rawUrl, "http://local.invalid");
  const pathname = url.pathname.replace(/\/+$/, "");
  const hard = /[?&](hard=1|hard=true)(&|$)/.test(url.search);
  const op = method.toUpperCase();

  // Tâches
  if (pathname === "/api/tasks") {
    return { type: op === "POST" ? "create" : "update", entity: "task", entityId: "", hard: false };
  }
  if (pathname.startsWith(TASK_SEGMENT)) {
    const id = pathId(pathname, TASK_SEGMENT);
    if (id === "stats") return { type: "update", entity: "other", entityId: "", hard: false };
    if (id) {
      return {
        type: op === "POST" ? "create" : op === "DELETE" ? "delete" : "update",
        entity: "task",
        entityId: id,
        hard,
      };
    }
  }

  // Événements
  if (pathname === "/api/events") {
    return { type: op === "POST" ? "create" : "update", entity: "event", entityId: "", hard: false };
  }
  if (pathname.startsWith(EVENT_SEGMENT)) {
    const id = pathId(pathname, EVENT_SEGMENT);
    if (id === "export" || id === "import") {
      return { type: "update", entity: "other", entityId: "", hard: false };
    }
    if (id) {
      return {
        type: op === "DELETE" ? "delete" : "update",
        entity: "event",
        entityId: id,
        hard: true,
      };
    }
  }

  // Emails
  if (pathname === "/api/emails") {
    return { type: op === "POST" ? "create" : "update", entity: "email", entityId: "", hard: false };
  }
  if (pathname.startsWith(EMAIL_SEGMENT)) {
    const id = pathId(pathname, EMAIL_SEGMENT);
    if (id === "sync" || id === "send" || id === "bulk") {
      return { type: "update", entity: "other", entityId: "", hard: false };
    }
    if (id) {
      return {
        type: op === "DELETE" ? "delete" : "update",
        entity: "email",
        entityId: id,
        hard: true,
      };
    }
  }

  // Étiquettes (pas de table locale : synchronisées sans optimisme)
  if (pathname.startsWith("/api/tags")) {
    const id = pathId(pathname, "/api/tags/");
    return { type: op === "DELETE" ? "delete" : op === "POST" ? "create" : "update", entity: "tag", entityId: id ?? "", hard: false };
  }

  return { type: op === "DELETE" ? "delete" : op === "POST" ? "create" : "update", entity: "other", entityId: "", hard: false };
}

// ── Background Sync (Service Worker) ───────────────────────────────────────

/** Programme le tag de Background Sync — le SW relancera la sync au retour. */
export function registerSyncTag(): void {
  try {
    void navigator.serviceWorker?.ready.then((registration) => {
      const sync = (registration as ServiceWorkerRegistration & {
        sync?: { register: (tag: string) => Promise<void> };
      }).sync;
      return sync?.register("orbit-sync").catch(() => {
        // Background Sync indisponible (Firefox/Safari) : les gardes
        // horaires + événement online prennent le relais.
      });
    });
  } catch {
    // SW non supporté — silencieux
  }
}

// ── Queue manager ──────────────────────────────────────────────────────────

export class QueueManager {
  /**
   * Enregistre une mutation en file + applique l'optimisme local.
   * Retourne l'opération (id utilisé par les waiters de l'UI).
   */
  async enqueue(
    url: string,
    method: string,
    body: string | null,
    label: string
  ): Promise<PendingOperation> {
    const derived = deriveOperation(url, method);
    const seq = Date.now() + Math.floor(Math.random() * 1000);
    const op: PendingOperation = {
      id: `q-${seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      seq,
      type: derived.type,
      entity: derived.entity,
      entityId: derived.entityId,
      data: { url, method: method.toUpperCase(), body, label },
      timestamp: new Date().toISOString(),
      retryCount: 0,
      maxRetries: 5,
    };

    // Optimiste AVANT l'enregistrement : l'op référence l'id temporaire créé.
    const tempLocalId = await applyOptimistic(op, derived);
    if (tempLocalId) op.tempLocalId = tempLocalId;

    try {
      await db.pendingOperations.add(op);
    } catch (error) {
      // Base indisponible (navigation privée…) : on annule l'optimiste et on
      // laisse l'erreur remonter (comportement historique sans file).
      if (tempLocalId) await safeDelete(derived.entity, tempLocalId);
      throw error;
    }

    registerSyncTag();
    return op;
  }

  /** File complète, ordre FIFO. */
  async all(): Promise<PendingOperation[]> {
    return db.pendingOperations.orderBy("seq").toArray();
  }

  async count(): Promise<number> {
    return db.pendingOperations.count();
  }

  async update(id: string, changes: Partial<PendingOperation>): Promise<void> {
    await db.pendingOperations.update(id, changes);
  }

  async delete(id: string): Promise<void> {
    await db.pendingOperations.delete(id);
  }

  async clear(): Promise<void> {
    await db.pendingOperations.clear();
  }

  /** Opérations en attente pour une entité (le serveur a gagné → abandon). */
  async opsForEntity(entity: OperationEntity, entityId: string): Promise<PendingOperation[]> {
    if (!entityId) return [];
    return db.pendingOperations.where({ entity, entityId }).toArray();
  }

  /** Abandonne les opérations d'une entité (résolution de conflit serveur). */
  async dropOpsFor(entity: OperationEntity, entityId: string): Promise<number> {
    const ops = await this.opsForEntity(entity, entityId);
    for (const op of ops) await db.pendingOperations.delete(op.id);
    return ops.length;
  }
}

async function safeDelete(entity: OperationEntity, id: string): Promise<void> {
  try {
    if (entity === "task") await db.tasks.delete(id);
    else if (entity === "event") await db.events.delete(id);
    else if (entity === "email") await db.emails.delete(id);
  } catch {
    // silencieux
  }
}

// ── Application optimiste locale ────────────────────────────────────────────

/** Champs de métadonnées exclus du cliché métier (base du merge 3-way). */
const META_FIELDS = new Set([
  "_syncStatus",
  "_lastSyncedAt",
  "_localUpdatedAt",
  "_serverUpdatedAt",
  "_serverVersion",
  "_version",
]);

/** Cliché métier d'un enregistrement local (base du merge 3-way). */
function snapshotBusiness(record: object): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!META_FIELDS.has(key)) out[key] = value;
  }
  return out;
}

/** TagDto temporaire (id local — remplacé par les tags serveur au pull). */
function tempTag(name: string, color?: string, index = 0) {
  return { id: `tmp-tag-${index}-${Math.random().toString(36).slice(2, 7)}`, name, color: color ?? "#00D4FF" };
}

function tempSubtask(title: string, index: number) {
  return {
    id: `tmp-sub-${index}-${Math.random().toString(36).slice(2, 7)}`,
    title,
    completed: false,
    position: (index + 1) * 1000,
    createdAt: new Date().toISOString(),
  };
}

function parseBody(body: string | null): Record<string, unknown> {
  if (!body) return {};
  try {
    const parsed = JSON.parse(body);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Position de fin de colonne Kanban (même convention serveur : +1000). */
async function nextPosition(status: string): Promise<number> {
  try {
    const column = await db.tasks.where("status").equals(status).toArray();
    const max = column.reduce((acc, t) => Math.max(acc, t.position), 0);
    return max + 1000;
  } catch {
    return 1000;
  }
}

/**
 * Applique une mutation au cache local (optimiste). Retourne l'id temporaire
 * créé (créations) — null sinon. Ne lève JAMAIS : une entité absente du cache
 * (jamais pullée) est simplement ignorée (l'op partira quand même au replay).
 */
export async function applyOptimistic(
  op: PendingOperation,
  derived: DerivedOperation
): Promise<string | null> {
  const body = parseBody(op.data.body);
  const now = new Date().toISOString();
  const url = new URL(op.data.url, "http://local.invalid");

  try {
    // ── TÂCHES ────────────────────────────────────────────────────────────
    if (derived.entity === "task") {
      if (derived.type === "create") {
        const tempId = `tmp-task-${op.seq.toString(36)}`;
        const status = (body.status as TaskStatus | undefined) ?? "todo";
        const local: LocalTask = {
          id: tempId,
          title: (body.title as string) ?? "Tâche",
          description: (body.description as string | null) ?? null,
          status,
          priority: (body.priority as TaskPriority) ?? "MEDIUM",
          position: await nextPosition(status),
          dueDate: (body.dueDate as string | null) ?? null,
          completedAt: status === "done" ? now : null,
          tags: ((body.tags as { name: string; color?: string }[] | undefined) ?? []).map((t, i) => tempTag(t.name, t.color, i)),
          subtasks: ((body.subtasks as { title: string }[] | undefined) ?? []).map((s, i) => tempSubtask(s.title, i)),
          aiSuggestedPriority: null,
          aiConfidence: null,
          eventId: (body.eventId as string | null) ?? null,
          createdAt: now,
          updatedAt: now,
          ...pendingMeta(undefined),
        };
        await db.tasks.put(local);
        return tempId;
      }

      const current = await db.tasks.get(derived.entityId);
      if (!current) return null;

      if (derived.type === "delete") {
        if (derived.hard || current.status === "archived") {
          await db.tasks.update(derived.entityId, { _syncStatus: "deleted", _localUpdatedAt: now });
        } else {
          // Soft delete : archivage (même sémantique que le serveur)
          await db.tasks.update(derived.entityId, {
            status: "archived",
            ...pendingMeta(current),
            _serverVersion: snapshotBusiness(current),
          });
        }
        return null;
      }

      // update / move — champs présents seulement
      const changes: Partial<LocalTask> = {
        ...pendingMeta(current),
        _serverVersion: snapshotBusiness(current),
      };
      if (body.title !== undefined) changes.title = body.title as string;
      if (body.description !== undefined) changes.description = body.description as string | null;
      if (body.status !== undefined) {
        changes.status = body.status as TaskStatus;
        changes.completedAt =
          body.status === "done" ? (current.completedAt ?? now) : null;
      }
      if (body.priority !== undefined) changes.priority = body.priority as TaskPriority;
      if (body.position !== undefined) changes.position = body.position as number;
      if (body.dueDate !== undefined) changes.dueDate = body.dueDate as string | null;
      if (body.eventId !== undefined) changes.eventId = body.eventId as string | null;
      if (Array.isArray(body.tags)) {
        changes.tags = (body.tags as { name: string; color?: string }[]).map((t, i) =>
          tempTag(t.name, t.color, i)
        );
      }
      if (Array.isArray(body.subtasks)) {
        changes.subtasks = (body.subtasks as { title: string; completed?: boolean }[]).map((s, i) => ({
          ...tempSubtask(s.title, i),
          completed: Boolean(s.completed),
        }));
      }
      await db.tasks.update(derived.entityId, changes);
      return null;
    }

    // ── ÉVÉNEMENTS ────────────────────────────────────────────────────────
    if (derived.entity === "event") {
      if (derived.type === "create") {
        const tempId = `tmp-event-${op.seq.toString(36)}`;
        const local: LocalEvent = {
          id: tempId,
          title: (body.title as string) ?? "Événement",
          description: (body.description as string | null) ?? null,
          location: (body.location as string | null) ?? null,
          startTime: (body.startTime as string) ?? now,
          endTime: (body.endTime as string) ?? now,
          allDay: Boolean(body.allDay),
          timezone: (body.timezone as string) ?? "UTC",
          color: (body.color as string | null) ?? null,
          source: "manual",
          recurrence: (body.recurrence as LocalEvent["recurrence"]) ?? null,
          recurrenceExceptions: null,
          attendees: (body.attendees as LocalEvent["attendees"]) ?? null,
          reminders: (body.reminders as LocalEvent["reminders"]) ?? null,
          externalId: null,
          createdAt: now,
          updatedAt: now,
          isOccurrence: false,
          seriesId: null,
          occurrenceStart: null,
          ...pendingMeta(undefined),
        };
        await db.events.put(local);
        return tempId;
      }

      const current = await db.events.get(derived.entityId);
      if (!current) return null;

      if (derived.type === "delete") {
        // scope=single → simple exception de série : logique serveur seule,
        // pas d'optimiste (l'op sera rejouée telle quelle).
        const scopeSingle = url.searchParams.get("scope") === "single" || body.scope === "single";
        if (!scopeSingle) {
          await db.events.update(derived.entityId, { _syncStatus: "deleted", _localUpdatedAt: now });
        }
        return null;
      }

      const changes: Partial<LocalEvent> = {
        ...pendingMeta(current),
        _serverVersion: snapshotBusiness(current),
      };
      for (const field of ["title", "description", "location", "startTime", "endTime", "timezone", "color"] as const) {
        if (body[field] !== undefined) {
          (changes as Record<string, unknown>)[field] = body[field];
        }
      }
      if (body.allDay !== undefined) changes.allDay = Boolean(body.allDay);
      if (body.recurrence !== undefined) changes.recurrence = body.recurrence as LocalEvent["recurrence"];
      if (body.attendees !== undefined) changes.attendees = body.attendees as LocalEvent["attendees"];
      if (body.reminders !== undefined) changes.reminders = body.reminders as LocalEvent["reminders"];
      await db.events.update(derived.entityId, changes);
      return null;
    }

    // ── EMAILS ────────────────────────────────────────────────────────────
    if (derived.entity === "email") {
      const current = await db.emails.get(derived.entityId);
      if (!current) return null;

      if (derived.type === "delete") {
        await db.emails.update(derived.entityId, { _syncStatus: "deleted", _localUpdatedAt: now });
        return null;
      }

      const changes: Partial<LocalEmail> = {
        ...pendingMeta(current),
        _serverVersion: snapshotBusiness(current),
      };
      if (body.isRead !== undefined) changes.isRead = Boolean(body.isRead);
      if (body.isStarred !== undefined) changes.isStarred = Boolean(body.isStarred);
      if (body.isProcessed !== undefined) changes.isProcessed = Boolean(body.isProcessed);
      if (body.folder !== undefined) changes.folder = body.folder as LocalEmail["folder"];
      await db.emails.update(derived.entityId, changes);
      return null;
    }
  } catch {
    // Cache local indisponible : l'opération reste en file (sync garantie),
    // seul l'optimisme visuel est perdu.
  }
  return null;
}

// ── Après un push réussi ────────────────────────────────────────────────────

/**
 * Remplace l'optimiste par le cliché SERVEUR renvoyé par le replay.
 * data = corps JSON de la réponse ({task}|{event,…}|{email}|{ok}).
 */
export async function postPushApply(op: PendingOperation, data: unknown): Promise<void> {
  const payload = (typeof data === "object" && data !== null ? data : {}) as Record<string, unknown>;
  const serverDto =
    (payload.task ?? payload.event ?? payload.email) as Record<string, unknown> | undefined;
  const now = new Date().toISOString();

  try {
    if (op.entity === "task") {
      if (op.tempLocalId) await db.tasks.delete(op.tempLocalId);
      if (serverDto && typeof serverDto.id === "string") {
        await db.tasks.put({
          ...(serverDto as unknown as LocalTask),
          _syncStatus: "synced",
          _lastSyncedAt: now,
          _localUpdatedAt: now,
          _serverUpdatedAt: now,
          _version: (op.retryCount ?? 0) + 1,
        });
      } else if (op.type === "delete" && op.entityId) {
        await db.tasks.delete(op.entityId);
      } else if (op.entityId) {
        await db.tasks.update(op.entityId, { _syncStatus: "synced", _localUpdatedAt: now, _serverUpdatedAt: now });
      }
      return;
    }
    if (op.entity === "event") {
      if (op.tempLocalId) await db.events.delete(op.tempLocalId);
      if (serverDto && typeof serverDto.id === "string") {
        await db.events.put({
          ...(serverDto as unknown as LocalEvent),
          _syncStatus: "synced",
          _lastSyncedAt: now,
          _localUpdatedAt: now,
          _serverUpdatedAt: now,
          _version: 1,
        });
      } else if (op.type === "delete" && op.entityId) {
        await db.events.delete(op.entityId);
      } else if (op.entityId) {
        await db.events.update(op.entityId, { _syncStatus: "synced", _localUpdatedAt: now, _serverUpdatedAt: now });
      }
      return;
    }
    if (op.entity === "email") {
      if (op.tempLocalId) await db.emails.delete(op.tempLocalId);
      if (serverDto && typeof serverDto.id === "string") {
        await db.emails.put({
          ...(serverDto as unknown as LocalEmail),
          _syncStatus: "synced",
          _lastSyncedAt: now,
          _localUpdatedAt: now,
          _serverUpdatedAt: now,
          _version: 1,
        });
      } else if (op.type === "delete" && op.entityId) {
        await db.emails.delete(op.entityId);
      } else if (op.entityId) {
        await db.emails.update(op.entityId, { _syncStatus: "synced", _localUpdatedAt: now, _serverUpdatedAt: now });
      }
    }
  } catch {
    // silencieux — le pull suivant réconciliera
  }
}

/** Instance partagée (l'outbox est accédée par api() et le replay). */
export const queueManager = new QueueManager();
