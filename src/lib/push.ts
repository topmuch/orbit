// ═══════════════════════════════════════════════════════════════════════════
// Orbit — Couche Web Push (VAPID) — usage serveur uniquement
// ───────────────────────────────────────────────────────────────────────────
// Cycle de vie complet :
//   [navigateur] permission → PushManager.subscribe(clé publique VAPID)
//        → POST /api/subscribe (upsert en base, lié à l'utilisateur)
//   [envoi]    POST /api/notify (test utilisateur) ou rappels automatiques
//              (reminder-service :3032 → secret partagé)
//   [réception] Service Worker (public/sw.js) → showNotification()
//   [hygiène]  404/410 du service push → suppression automatique de la
//              subscription morte en base.
// ═══════════════════════════════════════════════════════════════════════════

import webpush from "web-push"
import { db } from "@/lib/db"

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY ?? ""
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? ""
const VAPID_SUBJECT = process.env.VAPID_SUBJECT ?? "mailto:orbit@localhost"

/** Payload sérialisé envoyé au Service Worker (event « push »). */
export interface PushPayload {
  title: string
  body: string
  tag?: string // regroupe les notifications (remplace au lieu d'empiler)
  url?: string // deep link ouvert au clic
  kind?: "event" | "task" | "test"
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

export interface PushSendReport {
  sent: number // notifications acceptées par le service push
  removed: number // subscriptions mortes purgées (404/410)
  failed: number // erreurs réseau inattendues
}

/** Erreurs attendues d'une subscription morte (endpoint révoqué). */
function isDeadSubscription(statusCode: number | undefined): boolean {
  return statusCode === 404 || statusCode === 410
}

/**
 * Envoie un push à TOUTES les subscriptions d'un utilisateur.
 * Purge automatiquement les subscriptions mortes (404/410) du service push.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload
): Promise<PushSendReport> {
  if (!ensureWebPushConfigured()) {
    throw new Error("VAPID non configuré")
  }

  const subscriptions = await db.pushSubscription.findMany({ where: { userId } })
  const report: PushSendReport = { sent: 0, removed: 0, failed: 0 }
  const stringified = JSON.stringify(payload)

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        // Le format PushSubscription du navigateur : { endpoint, keys: {p256dh, auth} }
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys as { p256dh: string; auth: string } },
          stringified
        )
        report.sent++
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode
        if (isDeadSubscription(statusCode)) {
          // L'utilisateur a révoqué la permission / désinstallé : on purge.
          await db.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {})
          report.removed++
        } else {
          console.error("[orbit:push]", error)
          report.failed++
        }
      }
    })
  )

  return report
}

/** Compte les subscriptions actives d'un utilisateur (statut UI). */
export async function countSubscriptions(userId: string): Promise<number> {
  return db.pushSubscription.count({ where: { userId } })
}
