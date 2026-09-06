// GET /api/sync/changes?since=<ISO> — Pull delta offline-first (bidirectionnel)
// ─────────────────────────────────────────────────────────────────────────────
// Source de vérité du moteur de synchronisation client (lib/db/sync-engine) :
//   • since absent/epoch → réhydratation COMPLÈTE du cache IndexedDB ;
//   • since = dernier serverTimestamp reçu → seules les entités modifiées
//     (updatedAt > since) + les tombstones (suppressions d'autres appareils)
//     transitent — réponse minimaliste en steady-state ;
//   • serverTimestamp (horloge SERVEUR) : jamais dériver d'une horloge client
//     décalée (multi-appareils fiable).
// Mise à jour serveur (mutations replayées) : les routes REST existantes.
// Emails renvoyés au format DÉTAIL (bodyHtml inclus) : lecture complète offline.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionUser } from "@/lib/auth";
import { rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { toEventDto, toTaskDto, toEmailDto } from "@/lib/dto";
import { TASK_INCLUDE } from "@/lib/tasks-service";

/** Plafond anti-flood par type d'entité (volume personnel : très large). */
const MAX_ENTITIES = 500;
/** Tombstones renvoyées par pull (les anciennes purgées). */
const TOMBSTONE_WINDOW = 1000;
/** Purge des tombstones plus vieilles que 30 jours (fenêtre hors ligne max). */
const TOMBSTONE_TTL_MS = 30 * 86_400_000;

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "Non authentifié" }, { status: 401 });

  // Le moteur client sync ~toutes les 30 s + à chaque reconnexion.
  const rl = rateLimit(`sync:changes:${user.id}`, 120);
  if (!rl.ok) return tooManyRequests(rl);

  const { searchParams } = new URL(req.url);
  const sinceParam = searchParams.get("since");
  let since = new Date(0); // epoch = réhydratation complète
  if (sinceParam) {
    const parsed = new Date(sinceParam);
    if (Number.isNaN(parsed.getTime()) || sinceParam === "") {
      return NextResponse.json(
        { error: "Paramètre « since » invalide — instant ISO 8601 attendu." },
        { status: 400 }
      );
    }
    since = parsed;
  }

  // ── Tombstones (suppressions d'autres appareils à propager) ────────────────
  const tombstones = await db.syncTombstone.findMany({
    where: { userId: user.id, deletedAt: { gt: since } },
    select: { entity: true, entityId: true },
    take: TOMBSTONE_WINDOW,
  });
  // Purge opportuniste (hors fenêtre de rattrapage 30 j)
  await db.syncTombstone
    .deleteMany({
      where: { userId: user.id, deletedAt: { lt: new Date(Date.now() - TOMBSTONE_TTL_MS) } },
    })
    .catch(() => {});

  const deleted = {
    events: tombstones.filter((t) => t.entity === "event").map((t) => t.entityId),
    tasks: tombstones.filter((t) => t.entity === "task").map((t) => t.entityId),
    emails: tombstones.filter((t) => t.entity === "email").map((t) => t.entityId),
  };

  // ── Delta des trois entités synchronisées ─────────────────────────────────
  const [events, tasks, emails] = await Promise.all([
    db.event.findMany({
      where: { userId: user.id, updatedAt: { gt: since } },
      orderBy: { startTime: "asc" },
      take: MAX_ENTITIES,
    }),
    db.task.findMany({
      where: { userId: user.id, updatedAt: { gt: since } },
      include: TASK_INCLUDE,
      orderBy: { updatedAt: "asc" },
      take: MAX_ENTITIES,
    }),
    db.emailLog.findMany({
      where: { userId: user.id, updatedAt: { gt: since } },
      include: {
        account: { select: { address: true, label: true } },
        attachments: true,
      },
      orderBy: { updatedAt: "asc" },
      take: MAX_ENTITIES,
    }),
  ]);

  return NextResponse.json(
    {
      events: events.map(toEventDto),
      tasks: tasks.map(toTaskDto),
      emails: emails.map((e) => toEmailDto(e, { detail: true })),
      deleted,
      serverTimestamp: new Date().toISOString(),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
