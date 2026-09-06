"use client";

// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Base locale IndexedDB (Dexie.js) — cache offline-first structuré
// ───────────────────────────────────────────────────────────────────────────
// Miroir local des trois entités synchronisées (événements/tâches/emails) +
// file d'opérations en attente + métadonnées de sync. TOUTES les lectures
// hors ligne sont servies depuis ici (hooks useOffline*), les écritures
// hors ligne passent par pendingOperations (outbox) et sont appliquées
// OPTIMISTEMENT dans les tables locales.
//
// Métadonnées de synchronisation (préfixe _ — jamais sérialisées vers l'UI) :
//   _syncStatus      synced | pending | conflict | deleted
//   _lastSyncedAt    dernière écriture PULLÉE du serveur (ISO)
//   _localUpdatedAt  dernière écriture LOCALE (ISO — conflits LWW)
//   _serverUpdatedAt updatedAt serveur au moment du dernier pull (ISO)
//   _serverVersion   cliché serveur au moment d'un conflit non résolu
//   _version         compteur de révisions (détection de conflits)
//
// Schéma v1. Dexie n'ouvre la base qu'au PREMIER accès table (jamais au
// seul import) : sûr côté SSR — tous les accès vivent dans des effets ou
// des gestionnaires d'événements client.
// ═══════════════════════════════════════════════════════════════════════════

import Dexie, { type Table } from "dexie";
import type { EventDto, TaskDto, EmailDto } from "@/lib/types";

// ── Types locaux (DTO serveur + métadonnées de sync) ───────────────────────

export type SyncStatus = "synced" | "pending" | "conflict" | "deleted";

export interface SyncMeta {
  _syncStatus: SyncStatus;
  _lastSyncedAt?: string;
  _localUpdatedAt: string;
  _serverUpdatedAt?: string;
  /** Cliché serveur conservé pour résolution manuelle d'un conflit. */
  _serverVersion?: unknown;
  _version: number;
}

/** Événement MASTER (récurrence non expansée) — expansion à la lecture. */
export type LocalEvent = EventDto & SyncMeta;

export type LocalTask = TaskDto & SyncMeta;

export type LocalEmail = EmailDto & SyncMeta;

// ── File d'opérations (outbox) ─────────────────────────────────────────────

export type OperationType = "create" | "update" | "delete";

export type OperationEntity = "event" | "task" | "email" | "tag" | "other";

/** Charge utile transport (la mutation rejouée telle quelle à la reconnexion). */
export interface OperationPayload {
  url: string;
  method: string;
  body: string | null;
  label: string;
}

export interface PendingOperation {
  id: string;
  /** Ordre FIFO global (les dépendances entre opérations sont séquentielles). */
  seq: number;
  type: OperationType;
  entity: OperationEntity;
  entityId: string;
  data: OperationPayload;
  /** Identifiant Dexie temporaire créé hors ligne (remplacé par l'id serveur). */
  tempLocalId?: string;
  timestamp: string;
  retryCount: number;
  maxRetries: number;
  error?: string;
}

// ── Métadonnées de sync (curseur, conflits résolus…) ───────────────────────

export interface SyncMetadata {
  key: string;
  value: unknown;
  updatedAt: string;
}

// ── Base ───────────────────────────────────────────────────────────────────

class OrbitDatabase extends Dexie {
  events!: Table<LocalEvent, string>;
  tasks!: Table<LocalTask, string>;
  emails!: Table<LocalEmail, string>;
  pendingOperations!: Table<PendingOperation, string>;
  syncMetadata!: Table<SyncMetadata, string>;

  constructor() {
    super("OrbitDB");
    this.version(1).stores({
      // Index de requête seulement — tous les champs restent stockés.
      events: "id, startTime, endTime, _syncStatus, updatedAt",
      tasks: "id, status, priority, position, dueDate, _syncStatus, updatedAt",
      emails: "id, folder, isRead, isStarred, receivedAt, _syncStatus, updatedAt, accountAddress",
      pendingOperations: "id, seq, entity, entityId, timestamp, type",
      syncMetadata: "key",
    });
    // v2 : index composé [entity+entityId] — abandon des ops d'une entité
    // (le serveur a gagné un conflit / tombstone) sans scan complet.
    this.version(2).stores({
      pendingOperations: "id, seq, entity, entityId, timestamp, type, [entity+entityId]",
    });
  }
}

export const db = new OrbitDatabase();

// ── Helpers partagés ───────────────────────────────────────────────────────

/** Métadonnées fraîches pour une entité synchronisée depuis le serveur. */
export function syncedMeta(serverUpdatedAt: string, previousVersion = 0): SyncMeta {
  const now = new Date().toISOString();
  return {
    _syncStatus: "synced",
    _lastSyncedAt: now,
    _localUpdatedAt: now,
    _serverUpdatedAt: serverUpdatedAt,
    _version: Math.max(1, previousVersion + 1),
  };
}

/** Marque une entité modifiée localement (optimiste, en attente de push). */
export function pendingMeta(current: SyncMeta | undefined): SyncMeta {
  const now = new Date().toISOString();
  return {
    _syncStatus: "pending",
    _lastSyncedAt: current?._lastSyncedAt,
    _localUpdatedAt: now,
    _serverUpdatedAt: current?._serverUpdatedAt,
    _version: (current?._version ?? 0) + 1,
  };
}

/** Lecture d'une clé de métadonnée (curseur de pull…). */
export async function getSyncMeta(key: string): Promise<unknown> {
  const row = await db.syncMetadata.get(key);
  return row?.value;
}

/** Écriture d'une clé de métadonnée. */
export async function setSyncMeta(key: string, value: unknown): Promise<void> {
  await db.syncMetadata.put({ key, value, updatedAt: new Date().toISOString() });
}

/**
 * Résultat d'une sync (affiché par useSyncStatus / les toasts).
 * pushed = mutations rejouées, pulled = entités fusionnées, conflicts = conflits
 * non résolus automatiquement (attente d'une décision utilisateur).
 */
export interface SyncResult {
  success: boolean;
  pushed: number;
  pulled: number;
  conflicts: number;
  errors: string[];
  reason?: "offline" | "already_syncing" | "unauthenticated";
}

/** Tables par nom d'entité (typage gardé par l'appelant). */
export const ENTITY_TABLES = {
  event: () => db.events,
  task: () => db.tasks,
  email: () => db.emails,
} as const;

export type SyncedEntity = "event" | "task" | "email";
