// Orbit — Webhooks sortants signés HMAC-SHA256 (features avancées)
// ─────────────────────────────────────────────────────────────────────────────
// Chaque livraison est un POST JSON vers l'URL du webhook, signé avec le
// secret du webhook (stocké CHIFFRÉ AES-256-GCM — cf. lib/secret-box) :
//   X-Orbit-Signature: sha256=<hmac-sha256 hex du body>
//   X-Orbit-Event:     <nom de l'événement>
// Le HMAC est calculé sur l'EXACT octet-string envoyé (body sérialisé une
// seule fois) — un destinataire qui re-serialise le JSON casserait la signature.
// Chaque livraison (succès OU échec) est journalisée (WebhookLog, purge > 100)
// et met à jour la télémétrie du webhook. JAMAIS d'exception propagée : le
// flux CRUD appelant ne doit jamais échouer à cause des webhooks.

import "server-only"
import { createHmac } from "node:crypto"
import { db } from "@/lib/db"
import { decryptSecret } from "@/lib/secret-box"
import type { Webhook } from "@prisma/client"

/** Événements déclencheurs exposés aux intégrations (REST /api/v1 + UI). */
export const WEBHOOK_EVENTS = [
  "task.created",
  "task.updated",
  "task.deleted",
  "event.created",
  "event.updated",
  "event.deleted",
] as const

/** Événements autorisés — « test » est réservé au bouton « Tester » de l'UI. */
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number] | "test"

/** Timeout de livraison (réseau lent / destinataire muet). */
const DELIVERY_TIMEOUT_MS = 10_000

/** Garde de taille du journal (SQLite) : au-delà, purge des plus anciens. */
const LOG_KEEP = 100

/** Résultat d'une livraison unitaire. */
export type DeliveryResult = {
  ok: boolean
  statusCode?: number
  error?: string
}

/** Webhook minimal nécessaire à une livraison (subset du modèle Prisma). */
export type DeliverableWebhook = Pick<Webhook, "id" | "url" | "secretEnc">

// ─────────────────────────────────────────────────────────────────────────────
// Livraison unitaire
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Livre UN événement à UN webhook et ATTEND le résultat (POST /api/webhooks/test).
 * Journalise la livraison + met à jour la télémétrie — mais ne throw JAMAIS :
 * les échecs (réseau, signature…) sont retournés dans le résultat.
 */
export async function deliverWebhook(
  webhook: DeliverableWebhook,
  event: string,
  data: unknown
): Promise<DeliveryResult> {
  // Body sérialisé UNE SEULE FOIS : c'est exactement cette chaîne qui est
  // signée puis envoyée (signature byte-exact côté destinataire).
  const body = JSON.stringify({ event, timestamp: new Date().toISOString(), data })

  const startedAt = Date.now()
  let result: DeliveryResult

  try {
    // Le secret est déchiffré uniquement ici, le temps de signer.
    const secret = decryptSecret(webhook.secretEnc)
    const signature = createHmac("sha256", secret).update(body).digest("hex")

    const res = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Orbit-Signature": `sha256=${signature}`,
        "X-Orbit-Event": event,
      },
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    })

    result = res.ok
      ? { ok: true, statusCode: res.status }
      : { ok: false, statusCode: res.status, error: `HTTP ${res.status} du destinataire` }
  } catch (error) {
    // Timeout (AbortSignal) / DNS / TLS / secret indéchiffrable…
    result = {
      ok: false,
      error: error instanceof Error ? error.message : "Erreur de livraison inconnue",
    }
  }

  // Journal + télémétrie (best-effort : jamais faire échouer l'appelant).
  const durationMs = Date.now() - startedAt
  const status = result.ok ? "success" : "failed"
  try {
    await db.webhookLog.create({
      data: {
        webhookId: webhook.id,
        event,
        status,
        statusCode: result.statusCode ?? null,
        error: result.error ?? null,
        durationMs,
      },
    })
    await db.webhook.update({
      where: { id: webhook.id },
      data: {
        lastStatus: status,
        lastDeliveryAt: new Date(),
        lastError: result.error ?? null,
      },
    })
    // Purge opportuniste (fire-and-forget) : garde SQLite léger.
    void purgeLogs(webhook.id).catch(() => {})
  } catch (error) {
    console.error(`[webhooks] journalisation impossible (${webhook.id}, ${event})`, error)
  }

  return result
}

/** Supprime les livraisons les plus anciennes au-delà de LOG_KEEP entrées. */
async function purgeLogs(webhookId: string): Promise<void> {
  const count = await db.webhookLog.count({ where: { webhookId } })
  if (count <= LOG_KEEP) return
  const keep = await db.webhookLog.findMany({
    where: { webhookId },
    orderBy: { createdAt: "desc" },
    take: LOG_KEEP,
    select: { id: true },
  })
  if (keep.length >= count) return
  await db.webhookLog.deleteMany({
    where: { webhookId, id: { notIn: keep.map((log) => log.id) } },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Fan-out (triggers CRUD)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notifie TOUS les webhooks actifs de l'utilisateur abonnés à `event`.
 * Non bloquant par conception : les appelants CRUD l'invoquent en
 * `void triggerWebhooks(...).catch(() => {})` — et cette fonction ne throw
 * de toute façon jamais (chaque livraison est isolée).
 */
export async function triggerWebhooks(
  userId: string,
  event: WebhookEvent | string,
  data: unknown
): Promise<void> {
  let targets: DeliverableWebhook[]
  try {
    const webhooks = await db.webhook.findMany({
      where: { userId, isActive: true },
      select: { id: true, url: true, secretEnc: true, events: true },
    })
    targets = webhooks.filter((wh) => {
      // events = Json (string[]) : lecture défensive
      return Array.isArray(wh.events) && (wh.events as string[]).includes(event)
    })
  } catch (error) {
    console.error(`[webhooks] chargement impossible (user ${userId}, ${event})`, error)
    return
  }

  // Livraisons séquentielles et isolées : un destinataire en panne ne
  // ralentit/interrompt jamais les autres plus que son propre timeout.
  for (const webhook of targets) {
    try {
      await deliverWebhook(webhook, event, data)
    } catch (error) {
      // Ceinture et bretelles : deliverWebhook ne throw pas en théorie.
      console.error(`[webhooks] livraison ${event} → ${webhook.url} échouée`, error)
    }
  }
}
