"use client";

// Orbit — Client API + hooks React Query (contrat unique pour toute l'application)

import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  SessionUser,
  EventDto,
  TaskDto,
  EmailDto,
  EventSuggestion,
  StatsDto,
} from "@/lib/types";

// ---------- Fetch de base ----------

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
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

export function useEvents(from?: Date, to?: Date) {
  const params = new URLSearchParams()
  if (from) params.set("from", from.toISOString())
  if (to) params.set("to", to.toISOString())
  const qs = params.toString()
  return useQuery<{ events: EventDto[] }>({
    queryKey: ["events", from?.toISOString() ?? "", to?.toISOString() ?? ""],
    queryFn: () => api<{ events: EventDto[] }>(`/api/events${qs ? `?${qs}` : ""}`),
  })
}

export type EventInput = {
  title: string
  description?: string
  startTime: string
  endTime: string
  source?: "manual" | "email_extract" | "ai"
}

export function useEventMutations() {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: ["events"] })
  const invalidateStats = () => qc.invalidateQueries({ queryKey: ["stats"] })

  const create = useMutation({
    mutationFn: (input: EventInput) =>
      api<{ event: EventDto }>("/api/events", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => {
      invalidate()
      invalidateStats()
    },
  })
  const update = useMutation({
    mutationFn: (vars: { id: string; input: Partial<EventInput> }) =>
      api<{ event: EventDto }>(`/api/events/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify(vars.input),
      }),
    onSuccess: () => {
      invalidate()
      invalidateStats()
    },
  })
  const remove = useMutation({
    mutationFn: (id: string) => api<{ ok: boolean }>(`/api/events/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      invalidate()
      invalidateStats()
    },
  })

  return { create, update, remove }
}

// ---------- Tâches ----------

export function useTasks() {
  return useQuery<{ tasks: TaskDto[] }>({
    queryKey: ["tasks"],
    queryFn: () => api<{ tasks: TaskDto[] }>("/api/tasks"),
  })
}

export type TaskInput = {
  title: string
  description?: string
  status?: "todo" | "doing" | "done"
  priority?: number
  dueDate?: string | null
}

export function useTaskMutations() {
  const qc = useQueryClient()
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["tasks"] })
    qc.invalidateQueries({ queryKey: ["stats"] })
  }

  const create = useMutation({
    mutationFn: (input: TaskInput) =>
      api<{ task: TaskDto }>("/api/tasks", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: invalidate,
  })
  const update = useMutation({
    mutationFn: (vars: { id: string; input: Partial<TaskInput> }) =>
      api<{ task: TaskDto }>(`/api/tasks/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify(vars.input),
      }),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: string) => api<{ ok: boolean }>(`/api/tasks/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  })

  return { create, update, remove }
}

// ---------- Emails ----------

export function useEmails() {
  return useQuery<{ emails: EmailDto[] }>({
    queryKey: ["emails"],
    queryFn: () => api<{ emails: EmailDto[] }>("/api/emails"),
  })
}

export function useEmailMutations() {
  const qc = useQueryClient()
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["emails"] })
    qc.invalidateQueries({ queryKey: ["stats"] })
  }

  const patch = useMutation({
    mutationFn: (vars: { id: string; isRead?: boolean; isProcessed?: boolean }) =>
      api<{ email: EmailDto }>(`/api/emails/${vars.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isRead: vars.isRead, isProcessed: vars.isProcessed }),
      }),
    onSuccess: invalidate,
  })
  const remove = useMutation({
    mutationFn: (id: string) => api<{ ok: boolean }>(`/api/emails/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  })
  const sync = useMutation({
    mutationFn: () => api<{ ok: boolean; count: number }>("/api/emails/sync", { method: "POST" }),
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

  return { patch, remove, sync, analyze }
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

export function useProfileMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) =>
      api<{ user: SessionUser }>("/api/profile", {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
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
      return api<{ ok: boolean; subscriptions: number }>("/api/subscribe", {
        method: "POST",
        body: JSON.stringify({
          endpoint: json.endpoint,
          keys: {
            p256dh: (json.keys as Record<string, string>)?.p256dh,
            auth: (json.keys as Record<string, string>)?.auth,
          },
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
