"use client";

// Orbit — Client API + hooks React Query (contrat unique pour toute l'application)

import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import {
  useOfflineTasks,
  useOfflineEmails,
  useOfflineEvents,
  expandLocalEvents,
} from "@/hooks/useOfflineData";
import { isConnectionOffline } from "@/lib/network/connection-monitor";
import type { LocalEmail } from "@/lib/offline/indexeddb";
import type {
  SessionUser,
  EventDto,
  EventCreateInput,
  EventImportResult,
  TaskDto,
  TaskCreateInput,
  TaskUpdateInput,
  TaskStatsDto,
  TagDto,
  EmailDto,
  EmailAccountDto,
  EmailAccountTestResult,
  EmailSyncResult,
  EmailsPageDto,
  EmailListFilters,
  ComposeEmailInput,
  SmtpTestResult,
  EventSuggestion,
  StatsDto,
  AIPrioritySuggestion,
  AISummary,
  NotificationDto,
  NotificationPreferenceDto,
} from "@/lib/types";

// ---------- Fetch de base ----------

/**
 * Chemins NON mis en file quand le réseau tombe :
 *  • /api/ai/*        → l'IA nécessite le serveur (réponse enrichie en direct)
 *  • /api/auth/*      → session (login offline n'a pas de sens)
 *  • /api/notify      → envoi push / planification (besoin du réseau)
 *  • /api/subscribe   → inscription push navigateur
 *  • /api/email/*     → test/CRUD de compte = connexion IMAP immédiate requise
 *  • /api/emails/sync → synchronisation IMAP
 *  • /api/events/import, /api/events/export, /api/export → fichiers/binaires
 * Tout le reste (tasks, events, tags, emails, mark-read, profile…) est mis
 * en file IndexedDB et rejoué à la reconnexion (lib/offline-queue — Task 7).
 */
const OFFLINE_QUEUE_EXCLUDED = [
  "/api/ai/",
  "/api/auth/",
  "/api/notify",
  "/api/subscribe",
  "/api/email/",
  "/api/emails/sync",
  "/api/emails/send", // envoi SMTP : réseau requis, JAMAIS différé silencieusement
  "/api/events/import",
  "/api/events/export",
  "/api/export",
];

function isOfflineQueueable(path: string, method: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  if (path.startsWith("/api/events/import")) return false; // FormData — jamais en file
  return !OFFLINE_QUEUE_EXCLUDED.some((p) => path.startsWith(p));
}

/** Erreur réseau (fetch échoué) ≠ erreur applicative (4xx/5xx JSON). */
function isNetworkDrop(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /fetch|network|réseau|failed/i.test(error.message)
  );
}

/**
 * Mutation hors ligne : mise en file + ATTENTE du replay (l'UI reste sur son
 * spinner « en cours » ; à la reconnexion la promesse se résout avec la
 * VRAIE réponse serveur). Timeout 15 min → l'UI affiche l'erreur mais
 * l'action RESTE en file (elle partira au prochain retour du réseau).
 */
async function enqueueAndAwait<T>(path: string, method: string, init?: RequestInit): Promise<T> {
  const { enqueueMutation, waitForOutcome, mutationLabel } = await import("@/lib/offline-queue");
  const { toast } = await import("sonner");
  const label = mutationLabel(path, method);
  const body = typeof init?.body === "string" ? init.body : null;

  const item = await enqueueMutation(path, method, body, label);
  toast.info("Hors ligne — action mise en file d'attente", {
    description: `« ${label} » sera envoyée automatiquement dès la reconnexion.`,
  });

  const outcome = await waitForOutcome(item.id, 15 * 60_000);
  if (!outcome.ok) {
    throw new Error(outcome.error ?? "Synchronisation impossible");
  }
  return outcome.data as T;
}

// Exportée (features avancées) : les composants/settings hors de ce fichier
// (cartes API & webhooks, analytics, onboarding…) montent leurs propres hooks
// React Query au-dessus de ce helper au lieu d'éditer ce module partagé.
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();

  // Simulation hors ligne (réglages/QA) : la mutation part directement en
  // file SANS tenter le fetch (une vraie coupure est détectée par le
  // TypeError ci-dessous — navigator.onLine ment trop souvent pour y croire).
  if (
    method !== "GET" &&
    method !== "HEAD" &&
    isConnectionOffline() &&
    isOfflineQueueable(path, method)
  ) {
    return enqueueAndAwait<T>(path, method, init);
  }

  let res: Response;
  try {
    res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...init,
    });
  } catch (error) {
    // Réseau tombé PENDANT une mutation → file d'attente offline (Task 7).
    // On ne se fie PAS à navigator.onLine : il ment régulièrement (WiFi
    // « connecté » sans internet, portail captif…) — un TypeError de fetch
    // same-origin est TOUJOURS un problème réseau. La garde de replay (60 s
    // + événement online) rattrape instantanément un vrai réseau présent.
    if (isNetworkDrop(error) && isOfflineQueueable(path, method)) {
      return enqueueAndAwait<T>(path, method, init);
    }
    throw error;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error ?? `Erreur ${res.status}`)
  }
  return res.json()
}

// ---------- Session ----------

export function useSession() {
  return useQuery<{ user: SessionUser | null }>({
    queryKey: ["session"],
    queryFn: () => api<{ user: SessionUser | null }>("/api/auth/session"),
    staleTime: 60_000,
  })
}

// Mutations d'auth (login/register/logout/demo)
export function useAuthMutations() {
  const qc = useQueryClient()
  const done = () => {
    qc.invalidateQueries()
    // Signal offline-first : le moteur de sync relance un pull immédiat
    // (l'app démarre souvent sur l'écran de connexion → premier pull 401).
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("orbit:session-changed"))
    }
  }

  const login = useMutation({
    mutationFn: (vars: { email: string; password: string }) =>
      api<{ user: SessionUser }>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: done,
  })
  const register = useMutation({
    mutationFn: (vars: { name?: string; email: string; password: string }) =>
      api<{ user: SessionUser }>("/api/auth/register", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: done,
  })
  const demoLogin = useMutation({
    mutationFn: () =>
      api<{ user: SessionUser }>("/api/auth/demo", { method: "POST" }),
    onSuccess: done,
  })
  const logout = useMutation({
    mutationFn: () => api<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
    onSuccess: done,
  })

  return { login, register, demoLogin, logout }
}

// ---------- Événements ----------

/** Entrée de création/édition d'événement (contrat riche — types gelés). */
export type EventInput = EventCreateInput

/** Réponse POST/PATCH /api/events : conflits = avertissement NON bloquant. */
export type EventMutationResult = {
  event: EventDto
  /** Uniquement pour scope "single" : master avec exception appliquée. */
  master?: EventDto | null
  conflicts: EventDto[]
}

/** Réponse DELETE /api/events/:id. */
export type EventDeleteResult = { ok: boolean; master?: EventDto | null }

/** Portée d'une modification/suppression sur une série récurrente. */
export type EventScope = "single" | "series"

async function fetchEvents(
  isoStart: string | undefined,
  isoEnd: string | undefined
): Promise<{ events: EventDto[] }> {
  const params = new URLSearchParams()
  if (isoStart) params.set("start", isoStart)
  if (isoEnd) params.set("end", isoEnd)
  const qs = params.toString()
  return api<{ events: EventDto[] }>(`/api/events${qs ? `?${qs}` : ""}`)
}

/**
 * Tronque un instant à la MINUTE pour la queryKey : les plages calculées avec
 * `new Date()` (notifications-center, liaisons calendrier des tâches…) sinon
 * changent à chaque re-render/remount (millisecondes) → boucle de refetch
 * auto-entretenue (chaque fetch écrit dev.log → re-render → nouvelle clé…).
 * Granularité minute = au plus 1 requête/minute par plage — imperceptible
 * pour des plages de 24 h à 8 mois.
 */
function minuteKey(d: Date): string {
  return new Date(Math.floor(d.getTime() / 60_000) * 60_000).toISOString()
}

/** Événements (occurrences expansées) d'une plage [start, end].
 *  Hors ligne : masters du cache Dexie expansés localement (même moteur que
 *  le serveur — lib/calendar) ; en ligne : React Query classique. */
export function useEventsRange(start?: Date, end?: Date) {
  const isoStart = start ? minuteKey(start) : undefined
  const isoEnd = end ? minuteKey(end) : undefined
  const online = useOnlineStatus()
  const offlineMasters = useOfflineEvents()
  const query = useQuery<{ events: EventDto[] }>({
    queryKey: ["events", "range", isoStart ?? "", isoEnd ?? ""],
    // La requête conserve les instants EXACTS (la clé seule est tronquée) :
    // un cache servi d'une minute à l'autre reste dans la tolérance des plages.
    queryFn: () => fetchEvents(start?.toISOString(), end?.toISOString()),
    // Anti-burst : les remounts rapides servent le cache au lieu de refetcher
    // (les invalidations après mutations passent toujours).
    staleTime: 30_000,
    enabled: online,
  })

  if (!online) {
    const events = expandLocalEvents(offlineMasters, start, end)
    return { ...query, data: { events }, isLoading: false, isFetching: false }
  }
  return query
}

/** Alias legacy : useEvents(from, to) — même queryFn/queryKey que useEventsRange
 *  (les paramètres historiques from/to sont convertis en instants ISO). */
export function useEvents(from?: Date, to?: Date) {
  return useEventsRange(from, to)
}

export function useEventMutations() {
  const qc = useQueryClient()
  const invalidateAll = () => {
    qc.invalidateQueries({ queryKey: ["events"] })
    qc.invalidateQueries({ queryKey: ["stats"] })
    // Un rappel de type "email" peut créer un EmailLog → rafraîchir la boîte.
    qc.invalidateQueries({ queryKey: ["emails"] })
  }

  const create = useMutation({
    mutationFn: (input: EventInput) =>
      api<EventMutationResult>("/api/events", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: invalidateAll,
  })

  const update = useMutation({
    mutationFn: (vars: {
      id: string
      input: Partial<EventInput>
      scope?: EventScope
      occurrenceStart?: string
    }) =>
      api<EventMutationResult>(`/api/events/${vars.id}`, {
        method: "PATCH",
        // scope/occurrenceStart voyagent DANS le body JSON (contrat backend).
        body: JSON.stringify({
          ...vars.input,
          ...(vars.scope !== undefined ? { scope: vars.scope } : {}),
          ...(vars.occurrenceStart !== undefined
            ? { occurrenceStart: vars.occurrenceStart }
            : {}),
        }),
      }),
    onSuccess: invalidateAll,
  })

  const remove = useMutation({
    mutationFn: (vars: { id: string; scope?: EventScope; occurrenceStart?: string }) => {
      // DELETE : scope/occurrenceStart passent en query string.
      const params = new URLSearchParams()
      if (vars.scope) params.set("scope", vars.scope)
      if (vars.occurrenceStart) params.set("occurrenceStart", vars.occurrenceStart)
      const qs = params.toString()
      return api<EventDeleteResult>(`/api/events/${vars.id}${qs ? `?${qs}` : ""}`, {
        method: "DELETE",
      })
    },
    onSuccess: invalidateAll,
  })

  return { create, update, remove }
}

/** Import iCal (multipart FormData, champ "file"). */
export function useEventImport() {
  const qc = useQueryClient()
  return useMutation<EventImportResult, Error, File>({
    // Pas de Content-Type JSON : le navigateur pose le boundary multipart.
    mutationFn: async (file: File) => {
      const fd = new FormData()
      fd.append("file", file)
      const res = await fetch("/api/events/import", { method: "POST", body: fd })
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null
        throw new Error(body?.error ?? `Erreur ${res.status}`)
      }
      return res.json() as Promise<EventImportResult>
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["events"] })
      qc.invalidateQueries({ queryKey: ["stats"] })
      qc.invalidateQueries({ queryKey: ["emails"] })
    },
  })
}

/** Export iCal → téléchargement navigateur (fonction, pas un hook).
 *  Retourne le nom du fichier téléchargé. */
export async function exportEvents(range?: { start: Date; end: Date }): Promise<string> {
  const params = new URLSearchParams()
  if (range) {
    params.set("start", range.start.toISOString())
    params.set("end", range.end.toISOString())
  }
  const qs = params.toString()
  const res = await fetch(`/api/events/export${qs ? `?${qs}` : ""}`)
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Export impossible (erreur ${res.status})`)
  }
  const blob = await res.blob()
  // Nom depuis Content-Disposition (attachment; filename="orbit-YYYYMMDD.ics"),
  // sinon valeur par défaut équivalente.
  const cd = res.headers.get("Content-Disposition") ?? ""
  const filename =
    /filename="([^"]+)"/.exec(cd)?.[1] ??
    `orbit-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}.ics`
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 5_000)
  return filename
}

// ---------- Tâches (contrats gelés 13-a) ----------

/** Réponse GET /api/tasks (pagination + total — le front charge tout). */
export type TaskListResult = {
  tasks: TaskDto[]
  page: number
  limit: number
  total: number
}

/** Entrée de création de tâche (tags par nom, sous-tâches simples). */
export type TaskInput = TaskCreateInput

/** Entrée de mise à jour (tableaux tags/subtasks = remplacement complet). */
export type TaskPatchInput = TaskUpdateInput

/** Tâches de l'utilisateur (volume personnel : tout, relations incluses).
 *  Hors ligne : cache Dexie (live query — mutations optimistes visibles). */
export function useTasks() {
  const online = useOnlineStatus()
  const offlineTasks = useOfflineTasks()
  const query = useQuery<TaskListResult>({
    queryKey: ["tasks"],
    queryFn: () => api<TaskListResult>("/api/tasks"),
    enabled: online,
  })

  if (!online) {
    const tasks = offlineTasks as unknown as TaskDto[]
    return {
      ...query,
      data: { tasks, page: 1, limit: tasks.length, total: tasks.length },
      isLoading: false,
      isFetching: false,
    }
  }
  return query
}

/** Statistiques du système de tâches (Kanban + semaine de complétions). */
export function useTaskStats() {
  return useQuery<{ stats: TaskStatsDto }>({
    queryKey: ["task-stats"],
    queryFn: () => api<{ stats: TaskStatsDto }>("/api/tasks/stats"),
  })
}

// ---------- Tags ----------

/** Tag avec nombre de tâches associées (GET /api/tags). */
export type TagWithCount = TagDto & { taskCount: number }

/** Tags partagés de l'utilisateur. */
export function useTags() {
  return useQuery<{ tags: TagWithCount[] }>({
    queryKey: ["tags"],
    queryFn: () => api<{ tags: TagWithCount[] }>("/api/tags"),
  })
}

/**
 * Invalidation commune après toute mutation de tâche : les tâches (liste,
 * stats de tâches, compteurs de tags) ET les stats globales du dashboard.
 */
function useInvalidateTaskData() {
  const qc = useQueryClient()
  return () => {
    qc.invalidateQueries({ queryKey: ["tasks"] })
    qc.invalidateQueries({ queryKey: ["task-stats"] })
    qc.invalidateQueries({ queryKey: ["tags"] })
    qc.invalidateQueries({ queryKey: ["stats"] })
  }
}

export function useTaskMutations() {
  const qc = useQueryClient()
  const invalidate = useInvalidateTaskData()

  const create = useMutation({
    mutationFn: (input: TaskInput) =>
      api<{ task: TaskDto }>("/api/tasks", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  })

  const update = useMutation({
    mutationFn: (vars: { id: string; input: TaskPatchInput }) =>
      api<{ task: TaskDto }>(`/api/tasks/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify(vars.input),
      }),
    onSuccess: invalidate,
  })

  /** Déplacement Kanban (drag & drop) : position = INDICE cible 0-based,
   *  le serveur renormalise toute la colonne. */
  const move = useMutation({
    mutationFn: (vars: { id: string; status: TaskDto["status"]; position: number }) =>
      api<{ task: TaskDto }>(`/api/tasks/${vars.id}/move`, {
        method: "PATCH",
        body: JSON.stringify({ status: vars.status, position: vars.position }),
      }),
    onSuccess: invalidate,
  })

  /** Archivage = DELETE soft (status=archived). Un 2e appel purgerait. */
  const archive = useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; mode: "archived" | "deleted" }>(`/api/tasks/${id}`, {
        method: "DELETE",
      }),
    onSuccess: invalidate,
  })

  /** Suppression définitive (?hard=1 → purge + sous-tâches). */
  const removeHard = useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; mode: "archived" | "deleted" }>(`/api/tasks/${id}?hard=1`, {
        method: "DELETE",
      }),
    onSuccess: invalidate,
  })

  return { create, update, move, archive, removeHard }
}

// ---------- Sous-tâches ----------

/** Réponse des mutations de sous-tâches : tâche recalculée côté serveur. */
export type SubtaskMutationResult = {
  task: TaskDto
  subtask?: { id: string; title: string; completed: boolean; position: number; createdAt: string }
}

export function useSubtaskMutations() {
  const qc = useQueryClient()

  /** Remplace la tâche portée dans le cache ["tasks"] par la réponse serveur
   *  (les sous-tâches reviennent triées par position). */
  const replaceTask = (task: TaskDto) => {
    qc.setQueryData<TaskListResult>(["tasks"], (old) =>
      old ? { ...old, tasks: old.tasks.map((t) => (t.id === task.id ? task : t)) } : old
    )
  }

  const add = useMutation({
    mutationFn: (vars: { taskId: string; title: string }) =>
      api<SubtaskMutationResult>(`/api/tasks/${vars.taskId}/subtasks`, {
        method: "POST",
        body: JSON.stringify({ title: vars.title }),
      }),
    onSuccess: (res) => {
      replaceTask(res.task)
      qc.invalidateQueries({ queryKey: ["task-stats"] })
    },
  })

  const patch = useMutation({
    mutationFn: (vars: {
      taskId: string
      subtaskId: string
      title?: string
      completed?: boolean
      /** Indice cible 0-based → renormalisation serveur. */
      position?: number
    }) =>
      api<SubtaskMutationResult>(
        `/api/tasks/${vars.taskId}/subtasks/${vars.subtaskId}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            ...(vars.title !== undefined ? { title: vars.title } : {}),
            ...(vars.completed !== undefined ? { completed: vars.completed } : {}),
            ...(vars.position !== undefined ? { position: vars.position } : {}),
          }),
        }
      ),
    onSuccess: (res) => {
      replaceTask(res.task)
      qc.invalidateQueries({ queryKey: ["task-stats"] })
    },
  })

  const remove = useMutation({
    mutationFn: (vars: { taskId: string; subtaskId: string }) =>
      api<SubtaskMutationResult>(
        `/api/tasks/${vars.taskId}/subtasks/${vars.subtaskId}`,
        { method: "DELETE" }
      ),
    onSuccess: (res) => {
      replaceTask(res.task)
      qc.invalidateQueries({ queryKey: ["task-stats"] })
    },
  })

  return { add, patch, remove }
}

// ---------- Tags (mutations) ----------

export function useTagMutations() {
  const qc = useQueryClient()

  /** Un tag renommé/supprimé change les tags embarqués dans les tâches :
   *  on invalide aussi ["tasks"] (la DELETE détache sans toucher les tâches). */
  const invalidate = useInvalidateTaskData()

  const create = useMutation({
    mutationFn: (vars: { name: string; color: string }) =>
      api<{ tag: TagDto }>("/api/tags", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: invalidate,
  })

  const update = useMutation({
    mutationFn: (vars: { id: string; name?: string; color?: string }) =>
      api<{ tag: TagDto }>(`/api/tags/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify(vars),
      }),
    onSuccess: invalidate,
  })

  const remove = useMutation({
    mutationFn: (id: string) => api<{ ok: boolean }>(`/api/tags/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  })

  return { create, update, remove }
}

// ---------- Emails ----------

/** Construit l'URL de liste (query string stable pour React Query). */
function emailListUrl(filters: EmailListFilters): string {
  const sp = new URLSearchParams()
  sp.set("folder", filters.folder)
  if (filters.q?.trim()) sp.set("q", filters.q.trim())
  if (filters.accountId) sp.set("accountId", filters.accountId)
  if (filters.unread) sp.set("unread", "true")
  if (filters.starred) sp.set("starred", "true")
  if (filters.page && filters.page > 1) sp.set("page", String(filters.page))
  if (filters.limit) sp.set("limit", String(filters.limit))
  if (filters.sort === "oldest") sp.set("sort", "oldest")
  const qs = sp.toString()
  return qs ? `/api/emails?${qs}` : "/api/emails"
}

/**
 * Page d'emails calculée depuis le cache local (filtres dossiers/recherche/
 * compte + compteurs + comptes dérivés — adresse comme pseudo-id hors ligne).
 * Mêmes conventions que GET /api/emails (étoilés = suivi, hors corbeille).
 */
function computeOfflineEmailsPage(
  local: LocalEmail[],
  filters: EmailListFilters
): EmailsPageDto {
  const q = filters.q?.trim().toLowerCase() ?? ""

  let list = local.filter((email) => {
    if (filters.folder === "STARRED") {
      if (!email.isStarred || email.folder === "TRASH") return false
    } else if (filters.folder !== "ALL" && email.folder !== filters.folder) {
      return false
    }
    if (filters.unread && email.isRead) return false
    if (filters.starred && !email.isStarred) return false
    if (q) {
      const haystack =
        `${email.subject} ${email.fromName ?? ""} ${email.fromAddress} ${email.snippet ?? ""} ${email.bodyText ?? ""}`.toLowerCase()
      if (!haystack.includes(q)) return false
    }
    return true
  })

  // Compte : correspondance par ADRESSE hors ligne (pseudo-id dérivé)
  if (filters.accountId) {
    const matches = list.filter((email) => email.accountAddress === filters.accountId)
    if (matches.length > 0) list = matches
  }

  list = [...list].sort((a, b) =>
    filters.sort === "oldest"
      ? Date.parse(a.receivedAt) - Date.parse(b.receivedAt)
      : Date.parse(b.receivedAt) - Date.parse(a.receivedAt)
  )

  const counts = {
    inbox: local.filter((e) => e.folder === "INBOX").length,
    inboxUnread: local.filter((e) => e.folder === "INBOX" && !e.isRead).length,
    starred: local.filter((e) => e.isStarred && e.folder !== "TRASH").length,
    sent: local.filter((e) => e.folder === "SENT").length,
    archive: local.filter((e) => e.folder === "ARCHIVE").length,
    trash: local.filter((e) => e.folder === "TRASH").length,
    unread: local.filter((e) => !e.isRead).length,
    all: local.length,
  }

  const accountMap = new Map<
    string,
    { id: string; address: string; label: string | null; unread: number; canSend: boolean }
  >()
  for (const email of local) {
    if (!email.accountAddress) continue
    const existing = accountMap.get(email.accountAddress)
    if (existing) {
      if (!email.isRead) existing.unread++
    } else {
      accountMap.set(email.accountAddress, {
        id: email.accountAddress,
        address: email.accountAddress,
        label: null,
        unread: email.isRead ? 0 : 1,
        canSend: false,
      })
    }
  }

  const limit = filters.limit ?? (filters.folder === "ALL" ? 60 : 25)
  const page = filters.page ?? 1
  const start = (page - 1) * limit

  return {
    emails: list.slice(start, start + limit) as unknown as EmailDto[],
    total: list.length,
    page,
    limit,
    counts,
    accounts: [...accountMap.values()],
  }
}

/**
 * Liste des emails (filtres dossiers/recherche/compte + compteurs + comptes).
 * SANS argument : vue globale (badge de navigation, centre de notifications).
 * Hors ligne : cache Dexie (live query — lectures/étoiles optimistes visibles).
 * En ligne : rafraîchissement 60 s ≈ quasi temps réel (sync serveur 60 s).
 */
export function useEmails(filters?: EmailListFilters) {
  const effective = filters ?? { folder: "ALL" as const }
  const online = useOnlineStatus()
  const offlineEmails = useOfflineEmails()
  const query = useQuery<EmailsPageDto>({
    queryKey: ["emails", JSON.stringify(effective)],
    queryFn: () => api<EmailsPageDto>(emailListUrl(effective)),
    refetchInterval: 60_000,
    placeholderData: (prev) => prev, // pagination sans flash
    enabled: online,
  })

  if (!online) {
    return {
      ...query,
      data: computeOfflineEmailsPage(offlineEmails, effective),
      isLoading: false,
      isFetching: false,
    }
  }
  return query
}

/** Détail complet d'un email (HTML nettoyé + pièces jointes + compte).
 *  Hors ligne : enregistrement du cache Dexie (corps complet inclus — le
 *  pull de sync stocke le format détail). */
export function useEmailDetail(id: string | null) {
  const online = useOnlineStatus()
  const offlineEmails = useOfflineEmails()
  const query = useQuery<{ email: EmailDto }>({
    queryKey: ["email-detail", id],
    queryFn: () => api<{ email: EmailDto }>(`/api/emails/${id}`),
    enabled: Boolean(id) && online,
    staleTime: 30_000,
  })

  if (!online && id) {
    const local = offlineEmails.find((email) => email.id === id)
    if (local) {
      return { ...query, data: { email: local as unknown as EmailDto }, isLoading: false, isFetching: false }
    }
  }
  return query
}

/** PATCH unitaire (lu / étoilé / dossier / traité). */
export type EmailPatchInput = {
  id: string
  isRead?: boolean
  isProcessed?: boolean
  isStarred?: boolean
  folder?: "INBOX" | "SENT" | "ARCHIVE" | "TRASH"
}

export type EmailBulkAction =
  | "read"
  | "unread"
  | "star"
  | "unstar"
  | "archive"
  | "trash"
  | "restore"
  | "delete"

export function useEmailMutations() {
  const qc = useQueryClient()
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["emails"] })
    qc.invalidateQueries({ queryKey: ["email-detail"] })
    qc.invalidateQueries({ queryKey: ["stats"] })
    qc.invalidateQueries({ queryKey: ["email-accounts"] })
  }

  const patch = useMutation({
    mutationFn: (vars: EmailPatchInput) =>
      api<{ email: EmailDto }>(`/api/emails/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          isRead: vars.isRead,
          isProcessed: vars.isProcessed,
          isStarred: vars.isStarred,
          folder: vars.folder,
        }),
      }),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: string) => api<{ ok: boolean }>(`/api/emails/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  })
  const sync = useMutation({
    mutationFn: () => api<EmailSyncResult>("/api/emails/sync", { method: "POST" }),
    onSuccess: invalidate,
  })
  const analyze = useMutation({
    mutationFn: (emailId: string) =>
      api<{ suggestion: EventSuggestion | null; message?: string }>("/api/ai/analyze", {
        method: "POST",
        body: JSON.stringify({ emailId }),
      }),
    onSuccess: invalidate,
  })
  const bulk = useMutation({
    mutationFn: (vars: { ids: string[]; action: EmailBulkAction }) =>
      api<{ updated: number }>("/api/emails/bulk", {
        method: "PATCH",
        body: JSON.stringify(vars),
      }),
    onSuccess: invalidate,
  })
  const send = useMutation({
    mutationFn: (input: ComposeEmailInput) =>
      api<{ ok: boolean; messageId: string; rejected: string[] }>("/api/emails/send", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  })

  return { patch, remove, sync, analyze, bulk, send }
}

// ---------- Comptes email IMAP + SMTP ----------

/** Comptes de l'utilisateur (JAMAIS de mot de passe dans les DTO). */
export function useEmailAccounts() {
  return useQuery<{ accounts: EmailAccountDto[] }>({
    queryKey: ["email-accounts"],
    queryFn: () => api<{ accounts: EmailAccountDto[] }>("/api/email/accounts"),
    staleTime: 60_000,
  })
}

/** Entrées du formulaire de compte (mot de passe en clair UNIQUEMENT en
 *  mémoire le temps de l'appel — jamais persisté côté client). */
export type EmailAccountInput = {
  label?: string
  address: string
  imapHost: string
  imapPort: number
  imapSecure: boolean
  username: string
  password: string
  allowSelfSigned: boolean
  syncIntervalMin: number
  fetchDays: number
  maxMessages: number
  // ── SMTP (envoi — optionnel) ──
  smtpHost?: string
  smtpPort?: number
  smtpSecure?: boolean
  smtpUsername?: string
  smtpPassword?: string
}

export function useEmailAccountMutations() {
  const qc = useQueryClient()
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["email-accounts"] })
    qc.invalidateQueries({ queryKey: ["emails"] })
    qc.invalidateQueries({ queryKey: ["stats"] })
  }

  /** Tester une connexion IMAP SANS rien enregistrer. */
  const test = useMutation({
    mutationFn: (input: Pick<EmailAccountInput, "imapHost" | "imapPort" | "imapSecure" | "username" | "password" | "allowSelfSigned">) =>
      api<EmailAccountTestResult>("/api/email/accounts/test", {
        method: "POST",
        body: JSON.stringify(input),
      }),
  })

  /** Tester une connexion SMTP SANS rien enregistrer. */
  const testSmtp = useMutation({
    mutationFn: (input: {
      smtpHost: string
      smtpPort: number
      smtpSecure: boolean
      username: string
      password: string
    }) =>
      api<SmtpTestResult>("/api/email/accounts/test-smtp", {
        method: "POST",
        body: JSON.stringify(input),
      }),
  })

  const create = useMutation({
    mutationFn: (input: EmailAccountInput) =>
      api<{ account: EmailAccountDto }>("/api/email/accounts", {
        method: "POST",
        // test:true → IMAP vérifié AVANT stockage ; testSmtp → SMTP idem si fourni
        body: JSON.stringify({ ...input, test: true, testSmtp: true }),
      }),
    onSuccess: invalidate,
  })

  /** PATCH : champs optionnels — password vide = inchangé. */
  const update = useMutation({
    mutationFn: (vars: {
      id: string
      input: Partial<Omit<EmailAccountInput, "password">> & {
        password?: string
        isActive?: boolean
        label?: string | null
        // null = désactiver l'envoi SMTP du compte
        smtpHost?: string | null
        smtpPassword?: string
      }
    }) => {
      const imapChanged =
        vars.input.password !== undefined ||
        vars.input.imapHost !== undefined ||
        vars.input.imapPort !== undefined ||
        vars.input.imapSecure !== undefined ||
        vars.input.username !== undefined
      const smtpChanged =
        vars.input.smtpHost !== undefined ||
        vars.input.smtpPort !== undefined ||
        vars.input.smtpSecure !== undefined ||
        vars.input.smtpUsername !== undefined ||
        vars.input.smtpPassword !== undefined
      return api<{ account: EmailAccountDto }>(`/api/email/accounts/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          ...vars.input,
          test: imapChanged,
          testSmtp: smtpChanged,
        }),
      })
    },
    onSuccess: invalidate,
  })

  const remove = useMutation({
    mutationFn: (id: string) => api<{ ok: boolean }>(`/api/email/accounts/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  })

  /** Synchroniser UN compte maintenant. */
  const syncOne = useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; count: number; error: string | null }>(`/api/email/accounts/${id}/sync`, {
        method: "POST",
      }),
    onSuccess: invalidate,
  })

  return { test, testSmtp, create, update, remove, syncOne }
}

// ---------- Notifications planifiées (alertes personnalisées programmées) ----------

/** Programme une alerte personnalisée (queue serveur scheduledAt). */
export function useScheduleNotification() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { title: string; body: string; scheduledAt: string }) =>
      api<{ ok: boolean; scheduled: boolean; notificationId: string }>("/api/notify", {
        method: "POST",
        body: JSON.stringify({ type: "custom", ...vars }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications"] }),
  })
}

// ---------- IA (analyse d'emails + assistant) ----------

/** Résultat de POST /api/ai/analyze (micro-service IA : Ollama → fallback). */
export interface AIAnalysisResult {
  suggestion: EventSuggestion | null
  message?: string
  email?: EmailDto
}

/**
 * useAIAnalysis — analyse IA d'un email (Prompt 5).
 * Déclenche POST /api/ai/analyze qui délègue au micro-service IA
 * (mini-services/ai-service en sandbox, docker/ai-service en production).
 */
export function useAIAnalysis() {
  const qc = useQueryClient()
  return useMutation<AIAnalysisResult, Error, string>({
    mutationFn: (emailId: string) =>
      api<AIAnalysisResult>("/api/ai/analyze", {
        method: "POST",
        body: JSON.stringify({ emailId }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["emails"] })
    },
  })
}

// ---------- IA locale : suggestion de priorité + synthèse (Prompt IA) ----------

/** Entrée de suggestion de priorité : tâche existante OU tâche en création. */
export type AIPriorityInput =
  | { taskId: string }
  | { title: string; description?: string | null; dueDate?: string | null }

/**
 * useAIPrioritySuggestion — POST /api/ai/suggest-priority.
 * Mode { taskId } : suggestion persistée sur la tâche (aiSuggestedPriority).
 * Mode { title } : suggestion jetable (formulaire de création).
 */
export function useAIPrioritySuggestion() {
  const qc = useQueryClient()
  return useMutation<{ suggestion: AIPrioritySuggestion }, Error, AIPriorityInput>({
    mutationFn: (input) =>
      api<{ suggestion: AIPrioritySuggestion }>("/api/ai/suggest-priority", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: (data) => {
      if (data.suggestion.persisted) {
        void qc.invalidateQueries({ queryKey: ["tasks"] })
        void qc.invalidateQueries({ queryKey: ["task-stats"] })
      }
    },
  })
}

/** Entrée de synthèse : email de la boîte OU texte libre. */
export type AISummarizeInput =
  | { emailId: string; style?: "bullet_points" | "paragraph" | "key_points"; maxLength?: number }
  | { content: string; style?: "bullet_points" | "paragraph" | "key_points"; maxLength?: number }

/**
 * useAISummary — POST /api/ai/summarize (cache 10 min côté micro-service).
 * Utilisé par la vue emails (« Résumer ») et les descriptions de tâches longues.
 */
export function useAISummary() {
  return useMutation<{ summary: AISummary; emailId?: string }, Error, AISummarizeInput>({
    mutationFn: (input) =>
      api<{ summary: AISummary; emailId?: string }>("/api/ai/summarize", {
        method: "POST",
        body: JSON.stringify(input),
      }),
  })
}

/**
 * streamAssistant — lit le flux texte de POST /api/ai/chat et appelle
 * `onToken` à chaque fragment reçu (affichage streaming). Retourne le
 * texte complet assemblé. Lève en cas d'erreur réseau/serveur.
 */
export async function streamAssistant(
  messages: { role: "user" | "assistant"; content: string }[],
  onToken: (full: string) => void,
  signal?: AbortSignal
): Promise<string> {
  const res = await fetch("/api/ai/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
    signal,
  })
  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error ?? "L'assistant est indisponible")
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let acc = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    acc += decoder.decode(value, { stream: true })
    onToken(acc)
  }
  return acc
}

/** État du micro-service IA (GET /api/ai/status) — carte Réglages. */
export interface AIStatus {
  serviceUp: boolean
  provider: string // "ollama" | "zai-fallback" | "nextjs-fallback"
  model: string
  ollamaConfigured: boolean
  ollamaReachable: boolean
}

export function useAIStatus() {
  return useQuery<AIStatus>({
    queryKey: ["ai-status"],
    queryFn: () => api<AIStatus>("/api/ai/status"),
    staleTime: 30_000,
    refetchInterval: 60_000,
  })
}

// ---------- Statistiques ----------

export function useStats() {
  return useQuery<{ stats: StatsDto }>({
    queryKey: ["stats"],
    queryFn: () => api<{ stats: StatsDto }>("/api/stats"),
  })
}

// ---------- Profil ----------

/** Réponse PATCH /api/profile (le DTO porte le fuseau en plus de la session). */
export type ProfileUser = SessionUser & { timezone?: string | null }

export function useProfileMutation() {
  const qc = useQueryClient()
  return useMutation({
    // Compat : l'appel historique par `name` seul (string) reste accepté.
    mutationFn: (vars: string | { name?: string; timezone?: string }) => {
      const body = typeof vars === "string" ? { name: vars } : vars
      return api<{ user: ProfileUser }>("/api/profile", {
        method: "PATCH",
        body: JSON.stringify(body),
      })
    },
    onSuccess: () => {
      qc.setQueryData(["session"], undefined)
      qc.invalidateQueries({ queryKey: ["session"] })
    },
  })
}

// ---------- Notifications push (Web Push / VAPID) ----------

/** Statut push de l'utilisateur (GET /api/subscribe). */
export interface PushStatus {
  configured: boolean
  publicKey: string
  subscriptions: number
}

/** Décode une clé VAPID base64url → Uint8Array (applicationServerKey). */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(b64)
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)))
}

export function usePushStatus() {
  return useQuery<PushStatus>({
    queryKey: ["push-status"],
    queryFn: () => api<PushStatus>("/api/subscribe"),
  })
}

export function usePushMutations() {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: ["push-status"] })

  /**
   * Activer les rappels push — flux complet :
   * permission navigateur → PushManager.subscribe (clé VAPID) → POST /api/subscribe.
   * La permission est demandée uniquement sur interaction utilisateur (clic).
   */
  const enable = useMutation({
    mutationFn: async () => {
      if (!("Notification" in window)) {
        throw new Error("Notifications non supportées par ce navigateur")
      }
      if (Notification.permission === "denied") {
        throw new Error(
          "Notifications refusées — réactivez-les dans les réglages du navigateur (icône cadenas)"
        )
      }
      const permission =
        Notification.permission === "granted"
          ? "granted"
          : await Notification.requestPermission()
      if (permission !== "granted") throw new Error("Permission non accordée")

      const status = await api<PushStatus>("/api/subscribe")
      if (!status.configured || !status.publicKey) {
        throw new Error("Notifications non configurées sur le serveur")
      }

      const reg = await navigator.serviceWorker.ready
      const existing = await reg.pushManager.getSubscription()
      const sub =
        existing ??
        (await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(status.publicKey) as BufferSource,
        }))

      const json = sub.toJSON()
      // Plateforme déduite de l'User-Agent (télémétrie légère, 100 % locale)
      const ua = navigator.userAgent
      const platform = /Tablet|iPad/i.test(ua)
        ? "tablet"
        : /Mobi|Android/i.test(ua)
          ? "mobile"
          : "desktop"
      return api<{ ok: boolean; subscriptions: number }>("/api/subscribe", {
        method: "POST",
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: {
            p256dh: (json.keys as Record<string, string>)?.p256dh,
            auth: (json.keys as Record<string, string>)?.auth,
          },
          userAgent: ua.slice(0, 300),
          platform,
        }),
      })
    },
    onSuccess: invalidate,
  })

  /** Désactiver : désinscription navigateur + DELETE côté serveur. */
  const disable = useMutation({
    mutationFn: async () => {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await api("/api/subscribe", {
          method: "DELETE",
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {})
        await sub.unsubscribe()
      }
    },
    onSuccess: invalidate,
  })

  /** Notification de test (POST /api/notify { type: "test" }). */
  const test = useMutation({
    mutationFn: () =>
      api<{ ok: boolean }>("/api/notify", {
        method: "POST",
        body: JSON.stringify({ type: "test" }),
      }),
  })

  return { enable, disable, test }
}

// ---------- Notifications (historique in-app + préférences) ----------

/** Réponse de GET /api/notifications. */
export interface NotificationListResult {
  notifications: NotificationDto[]
  unreadCount: number
}

/** Rafraîchissement intelligent de l'historique des notifications. */
export function useNotifications(limit = 50) {
  return useQuery<NotificationListResult>({
    queryKey: ["notifications", limit],
    queryFn: () =>
      api<NotificationListResult>(`/api/notifications?limit=${limit}`),
    // Poll léger : les rappels arrivent par le cycle 60 s du reminder-service.
    refetchInterval: 60_000,
  })
}

/** Mutations de lecture (une, plusieurs, tout). */
export function useNotificationMutations() {
  const qc = useQueryClient()
  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ["notifications"] })

  const markRead = useMutation({
    mutationFn: (input: { notificationId?: string; ids?: string[]; all?: boolean }) =>
      api<{ ok: boolean; updated: number }>("/api/notifications/mark-read", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    // Optimiste : badge et pastilles réactifs immédiatement.
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: ["notifications"] })
      const keys = qc.getQueriesData<NotificationListResult>({ queryKey: ["notifications"] })
      for (const [key, data] of keys) {
        if (!data) continue
        qc.setQueryData<NotificationListResult>(key, {
          unreadCount: input.all
            ? 0
            : Math.max(0, data.unreadCount - (input.ids?.length ?? (input.notificationId ? 1 : 0))),
          notifications: data.notifications.map((n) =>
            input.all ||
            (input.notificationId && n.id === input.notificationId) ||
            (input.ids && input.ids.includes(n.id))
              ? { ...n, isRead: true }
              : n
          ),
        })
      }
    },
    onSettled: invalidate,
  })

  return { markRead }
}

/** Préférences de notifications (GET /api/notifications/preferences). */
export function useNotificationPreferences() {
  return useQuery<{ preferences: NotificationPreferenceDto }>({
    queryKey: ["notification-preferences"],
    queryFn: () => api<{ preferences: NotificationPreferenceDto }>("/api/notifications/preferences"),
  })
}

/** Mise à jour partielle des préférences (PUT). */
export function useNotificationPreferencesMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: Partial<NotificationPreferenceDto>) =>
      api<{ preferences: NotificationPreferenceDto }>("/api/notifications/preferences", {
        method: "PUT",
        body: JSON.stringify(input),
      }),
    onSuccess: (data) => {
      qc.setQueryData(["notification-preferences"], data)
    },
  })
}

/** Alerte personnalisée (POST /api/notify { type: "custom" }). */
export function useCustomNotification() {
  return useMutation({
    mutationFn: (input: { title: string; body: string; tag?: string }) =>
      api<{ ok: boolean; report: { sent: number } }>("/api/notify", {
        method: "POST",
        body: JSON.stringify({ type: "custom", ...input }),
      }),
  })
}
