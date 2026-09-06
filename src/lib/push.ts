// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Couche Web Push (VAPID) — usage serveur uniquement
// ───────────────────────────────────────────────────────────────────────────
// Cycle de vie complet :
//   [navigateur] permission → PushManager.subscribe(clé publique VAPID)
//        → POST /api/subscribe (upsert en base, lié à l'utilisateur)
//   [envoi]    /api/notify (test/alertes) ou rappels automatiques
//              (reminder-service :3032 → secret partagé)
//   [réception] Service Worker (public/sw.js v3) → showNotification()
//                + actions (Ouvrir / Ignorer / Terminée)
//   [hygiène]  404/410 du service push → désactivation de la subscription
//              morte + purge des notifications > 30 jours (cycle de scan).
//
// Chaque envoi peut PERSISTER une Notification (historique in-app :
// centre de notifications, isRead/isSent, deep link). L'id est injecté
// dans le payload push → le SW peut marquer lue à la fermeture.
// ═══════════════════════════════════════════════════════════════════════════

import webpush from "web-push"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { formatInTz } from "@/lib/timezone"
import type { NotificationType } from "@/lib/validators"

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? ""
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? ""
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? "mailto:orbit@localhost"

/** Bornes de sanitization (spec sécurité : jamais de contenu brut illimité). */
const TITLE_MAX = 100
const BODY_MAX = 500

/** Payload sérialisé envoyé au Service Worker (event « push »). */
export interface PushPayload {
  title: string
  body: string
  tag?: string // regroupe les notifications (remplace au lieu d'empiler)
  url?: string // deep link de secours si l'app n'est pas ouverte
  kind?: "event" | "task" | "email" | "suggestion" | "test"
  /** Type persisté dans l'historique (défaut SYSTEM). */
  type?: NotificationType
  /** Vue SPA cible + ids d'objets (deep link postMessage). */
  data?: Record<string, unknown>
  /** Actions affichées sur la notification OS (max 2 réellement affichées). */
  actions?: Array<{ action: string; title: string }>
  requireInteraction?: boolean
  silent?: boolean
}

export interface PushSendReport {
  sent: number // notifications acceptées par le service push
  removed: number // subscriptions mortes purgées (404/410)
  failed: number // erreurs réseau inattendues
  /** Notification d'historique créée (null si persist: false). */
  notificationId?: string
}

let configured = false

/** Configure web-push avec les clés VAPID (idempotent). */
export function ensureWebPushConfigured(): boolean {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false
  if (!configured) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
    configured = true
  }
  return true
}

/** Clé publique VAPID (base64) — à exposer au navigateur pour subscribe(). */
export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY
}

/** Vrai si les clés VAPID sont présentes (envoi possible). */
export function isPushConfigured(): boolean {
  return Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY)
}

/** Erreurs attendues d'une subscription morte (endpoint révoqué). */
function isDeadSubscription(statusCode: number | undefined): boolean {
  return statusCode === 404 || statusCode === 410
}

/** Nettoie un texte de notification (bornes + trim). */
function sanitizeText(value: string, max: number): string {
  return value.trim().slice(0, max)
}

/**
 * Envoie un push à TOUTES les subscriptions actives d'un utilisateur.
 * Persistance optionnelle : crée la Notification d'historique (avec id,
 * injecté au payload pour le mark-read côté SW), puis isSent/sentAt.
 * Purge automatiquement les subscriptions mortes (404/410).
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
  opts: { persist?: boolean } = {}
): Promise<PushSendReport> {
  if (!ensureWebPushConfigured()) {
    throw new Error("VAPID non configuré")
  }

  const title = sanitizeText(payload.title, TITLE_MAX)
  const body = sanitizeText(payload.body, BODY_MAX)
  if (!title || !body) {
    return { sent: 0, removed: 0, failed: 0 }
  }

  // ── Historique in-app (Notification) ─────────────────────────────────────
  let notificationId: string | undefined
  if (opts.persist !== false) {
    const notification = await db.notification.create({
      data: {
        userId,
        type: payload.type ?? "SYSTEM",
        title,
        body,
        // Payload.data = enregistrements simples (ids + vue) — cast contrôlé
        data: (payload.data ?? undefined) as Prisma.InputJsonValue | undefined,
        isSent: false,
      },
    })
    notificationId = notification.id
  }

  // ── Envoi aux appareils ──────────────────────────────────────────────────
  const subscriptions = await db.pushSubscription.findMany({
    where: { userId, isActive: true },
  })
  const report: PushSendReport = { sent: 0, removed: 0, failed: 0 }
  if (!subscriptions.length) {
    if (notificationId) {
      report.notificationId = notificationId
    }
    return report
  }

  // Le SW reçoit le payload enrichi : data { ...payload.data, notificationId }
  const wirePayload: PushPayload = {
    ...payload,
    title,
    body,
    data: { ...(payload.data ?? {}), ...(notificationId ? { notificationId } : {}) },
  }
  const stringified = JSON.stringify(wirePayload)

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        // Le format PushSubscription du navigateur : { endpoint, keys: {p256dh, auth} }
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys as { p256dh: string; auth: string } },
          stringified
        )
        report.sent++
        // Télémétrie légère : dernier envoi réussi (jamais de contenu).
        await db.pushSubscription
          .update({ where: { id: sub.id }, data: { lastUsedAt: new Date() } })
          .catch(() => {})
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode
        if (isDeadSubscription(statusCode)) {
          // L'utilisateur a révoqué la permission / désinstallé : on purge.
          await db.pushSubscription
            .update({ where: { id: sub.id }, data: { isActive: false } })
            .catch(() => {})
          report.removed++
        } else {
          console.error("[orbit:push]", error)
          report.failed++
        }
      }
    })
  )

  // ── Statut d'envoi de l'historique ───────────────────────────────────────
  if (notificationId) {
    await db.notification
      .update({
        where: { id: notificationId },
        data: { isSent: report.sent > 0, sentAt: report.sent > 0 ? new Date() : null },
      })
      .catch(() => {})
    report.notificationId = notificationId
  }

  return report
}

/**
 * Envoie une notification DÉJÀ PERSISTÉE (file d'attente planifiée : les
 * Notification.scheduledAt arrivées à échéance). Contrairement à
 * sendPushToUser, aucune ligne n'est créée : la ligne existante est
 * simplement marquée isSent/sentAt après l'envoi.
 *
 * Cas particulier : l'utilisateur n'a AUCUN appareil abonné → la notification
 * reste livrée via le centre in-app (c'est sa seule destination possible) et
 * est marquée envoyée pour ne pas être rejouée indéfiniment par le cycle.
 */
export async function sendExistingNotification(
  notification: { id: string; userId: string; type: string; title: string; body: string; data: unknown }
): Promise<PushSendReport> {
  if (!ensureWebPushConfigured()) {
    throw new Error("VAPID non configuré")
  }

  const title = sanitizeText(notification.title, TITLE_MAX)
  const body = sanitizeText(notification.body, BODY_MAX)

  const data = { ...(((notification.data ?? {}) as Record<string, unknown>)), notificationId: notification.id }
  const wirePayload: PushPayload = {
    title,
    body,
    tag: `orbit-scheduled-${notification.id}`,
    type: (notification.type as PushPayload["type"]) ?? "SYSTEM",
    data,
  }

  const subscriptions = await db.pushSubscription.findMany({
    where: { userId: notification.userId, isActive: true },
  })

  const report: PushSendReport = { sent: 0, removed: 0, failed: 0, notificationId: notification.id }

  if (!subscriptions.length) {
    // Livraison in-app uniquement → considérée comme traitée
    await db.notification
      .update({ where: { id: notification.id }, data: { isSent: true, sentAt: new Date() } })
      .catch(() => {})
    return report
  }

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys as { p256dh: string; auth: string } },
          JSON.stringify(wirePayload)
        )
        report.sent++
        await db.pushSubscription
          .update({ where: { id: sub.id }, data: { lastUsedAt: new Date() } })
          .catch(() => {})
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode
        if (isDeadSubscription(statusCode)) {
          await db.pushSubscription
            .update({ where: { id: sub.id }, data: { isActive: false } })
            .catch(() => {})
          report.removed++
        } else {
          console.error("[orbit:push]", error)
          report.failed++
        }
      }
    })
  )

  await db.notification
    .update({
      where: { id: notification.id },
      data: { isSent: true, sentAt: new Date() },
    })
    .catch(() => {})

  return report
}

/** Compte les subscriptions actives d'un utilisateur (statut UI). */
export async function countSubscriptions(userId: string): Promise<number> {
  return db.pushSubscription.count({ where: { userId, isActive: true } })
}

// ── Heures calmes ───────────────────────────────────────────────────────────

export interface QuietHoursContext {
  quietHoursEnabled: boolean
  quietHoursStart: string | null
  quietHoursEnd: string | null
}

/** « HH:MM » → minutes depuis minuit (null si invalide). */
function parseHHMM(value: string | null | undefined): number | null {
  if (!value) return null
  const m = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/)
  if (!m) return null
  return Number(m[1]) * 60 + Number(m[2])
}

/**
 * Vrai si `now` tombe dans les heures calmes de l'utilisateur (interprétées
 * dans SON fuseau IANA). Les plages peuvent traverser minuit (22:00→08:00).
 * Plage invalide/incomplète → jamais silencieux (échec ouvert).
 */
export function isQuietHours(pref: QuietHoursContext, now: Date, timezone: string): boolean {
  if (!pref.quietHoursEnabled) return false
  const start = parseHHMM(pref.quietHoursStart)
  const end = parseHHMM(pref.quietHoursEnd)
  if (start === null || end === null || start === end) return false

  // Heure locale de l'utilisateur « HH:MM » (Intl fr-FR) → minutes
  const hhmm = formatInTz(now, timezone, { hour: "2-digit", minute: "2-digit" })
  const parsed = hhmm.match(/(\d{1,2}):(\d{2})/)
  if (!parsed) return false
  const nowMin = Number(parsed[1]) * 60 + Number(parsed[2])

  if (start < end) return nowMin >= start && nowMin < end
  // Traversée de minuit : 22:00→08:00 = [22:00, 24:00[ ∪ [00:00, 08:00[
  return nowMin >= start || nowMin < end
}

/**
 * Purge de l'historique : notifications de plus de 30 jours (spec
 * performance). Appelée par le cycle de rappels (une fois par minute suffit,
 * le deleteMany est trivial en SQLite).
 */
export async function cleanupOldNotifications(): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000)
  const res = await db.notification.deleteMany({ where: { createdAt: { lt: cutoff } } })
  return res.count
}
