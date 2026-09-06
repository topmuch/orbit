/* Orbit — Service Worker v5
   ─────────────────────────────────────────────────────────────────────────
   Quatre rôles :
   1. OFFLINE COMPLET (Task 7) :
      • Lectures /api (GET) : network-first puis CACHE de secours (données
        consultables hors ligne, marquées X-Orbit-Offline: 1) ; entrées
        horodatées (X-Orbit-Cached-At) et purgées au-delà de 7 jours (TTL) +
        LRU (100 plus récentes conservées) ;
      • Navigations : réseau d'abord, page « / » en cache (prod) sinon
        offline.html — JAMAIS de bundle /_next/ mis en cache en dev
        (bug 13-b : chunks non hashés → bundle gelé) ;
      • Statiques (prod) : cache-first (chunks hashés par contenu).
      EN DÉVELOPPEMENT le handler fetch se limite STRICTEMENT aux GET /api
      et à la navigation de secours — les chunks et la page dev ne sont
      JAMAIS servis depuis le cache.
   2. NOTIFICATIONS (v3) : affichage des push reçus (payload enrichi),
      actions par type (Ouvrir / Ignorer / Terminée), deep link par
      postMessage vers l'app ouverte (navigation SPA sans rechargement),
      « terminer une tâche » directement depuis la notification, et
      marquage « lu » de l'historique à la fermeture.
   3. BACKGROUND SYNC (v5, offline-first) : le tag « orbit-sync » est
      programmé à chaque mise en file (lib/offline/queue-manager) ; le
      navigateur déclenche l'événement quand le réseau revient (même app
      en arrière-plan) → message SYNC_REQUESTED → la page lance push+pull.
   4. MISE À JOUR : skipWaiting sur message (pwa-register) + purge des
      caches obsolètes à l'activation (v4 et moins).

   Les MUTATIONS hors ligne ne passent PAS par le SW : elles sont mises en
   file IndexedDB (Dexie) par la page (lib/offline) et rejouées à la
   reconnexion — cf. docs/offline-guide.md.
   ───────────────────────────────────────────────────────────────────────── */

const CACHE = "orbit-v5";
const API_CACHE = "orbit-api-v5";
const IS_DEV =
  location.hostname === "localhost" || location.hostname === "127.0.0.1";
/** TTL des entrées du cache API (7 jours — au-delà : purge). */
const API_TTL_MS = 7 * 86_400_000;
/** LRU : nombre d'entrées API conservées après purge. */
const API_LRU_KEEP = 100;

const PRECACHE = [
  "/",
  "/offline.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

/* APIs dont la réponse ne doit JAMAIS servir depuis le cache :
   diagnostic push, IA (réponses générées), export de fichiers (binaires),
   test IMAP (POST de toute façon). La SESSION est volontairement cachée :
   network-first → toujours fraîche en ligne ; hors ligne, le dernier état
   connu permet de rester identifié (déconnexion = POST, réseau requis). */
const API_EXCLUDE = [
  "/api/notify",
  "/api/subscribe",
  "/api/ai/",
  "/api/export",
  "/api/events/export",
  "/api/email/accounts/test",
  "/api/sync/", // pull delta : TOUJOURS fraîcheur réseau (jamais servie du cache)
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        // Dev : précachage minimal (jamais la page dev), prod : complet.
        IS_DEV
          ? cache.addAll(["/manifest.json", "/offline.html", "/icons/icon-192.png"]).catch(() => {})
          : cache.addAll(PRECACHE).catch(() => {})
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      // Purge de tous les caches d'une autre version (v3 et moins, api vN…)
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== CACHE && k !== API_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* ══════════════════ Cache/PWA + Offline (Task 7) ══════════════════ */

/**
 * Garde-fou du cache API : LRU approximatif (100 plus récents conservés)
 * + TTL (entrées > 7 j purgées via l'en-tête X-Orbit-Cached-At posée à
 * l'écriture — jamais sur les réponses servies au client).
 */
async function trimApiCache(cache) {
  const keys = await cache.keys();
  // LRU : au-delà de 150 entrées, on ne garde que les 100 plus récentes
  if (keys.length > 150) {
    for (const key of keys.slice(0, keys.length - API_LRU_KEEP)) {
      await cache.delete(key).catch(() => {});
    }
  }
  // TTL : purge des entrées expirées (best-effort, jamais bloquant)
  try {
    const now = Date.now();
    for (const key of await cache.keys()) {
      const cached = await cache.match(key, { ignoreVary: true });
      const cachedAt = Number(cached && cached.headers.get("X-Orbit-Cached-At"));
      if (cachedAt && now - cachedAt > API_TTL_MS) {
        await cache.delete(key).catch(() => {});
      }
    }
  } catch {}
}

/** Met en cache une réponse API en horodatant l'entrée (TTL). */
async function cacheApiResponse(cache, req, res) {
  try {
    const copy = res.clone();
    const headers = new Headers(copy.headers);
    headers.set("X-Orbit-Cached-At", String(Date.now()));
    await cache.put(
      req,
      new Response(copy.body, {
        status: copy.status,
        statusText: copy.statusText || "OK",
        headers,
      })
    );
    await trimApiCache(cache);
  } catch {}
}

function isApiExcluded(pathname) {
  return API_EXCLUDE.some((p) => pathname.startsWith(p));
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Même origine uniquement, GET uniquement
  if (url.origin !== location.origin || req.method !== "GET") return;

  /* ── 1. Navigations : réseau d'abord, secours hors ligne ─────────────────
     (dev ET prod : en dev on ne sert JAMAIS la page « / » du cache —
     uniquement offline.html en secours → bug 13-b impossible) */
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (!IS_DEV) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("/", copy));
          }
          return res;
        })
        .catch(async () => {
          if (IS_DEV) {
            return (
              (await caches.match("/offline.html")) ||
              new Response("Hors ligne", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } })
            );
          }
          const cached = (await caches.match(req)) || (await caches.match("/"));
          return (
            cached ||
            (await caches.match("/offline.html")) ||
            new Response("Hors ligne", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } })
          );
        })
    );
    return;
  }

  /* ── 2. GET /api/* : network-first → cache de secours ────────────────── */
  if (url.pathname.startsWith("/api/") && !isApiExcluded(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then(async (res) => {
          // Cache des réponses valides sans cookie de session (horodatées TTL)
          if (res.ok && res.status === 200 && !res.headers.get("set-cookie")) {
            const cache = await caches.open(API_CACHE);
            cacheApiResponse(cache, req, res).catch(() => {});
          }
          return res;
        })
        .catch(async () => {
          const cache = await caches.open(API_CACHE);
          const cached = await cache.match(req, { ignoreVary: true });
          if (cached) {
            // Marqueur « données potentiellement périmées » pour l'app
            const headers = new Headers(cached.headers);
            headers.set("X-Orbit-Offline", "1");
            return new Response(cached.body, {
              status: cached.status,
              statusText: cached.statusText || "OK",
              headers,
            });
          }
          return new Response(
            JSON.stringify({
              error: "Hors ligne — cette donnée n'est pas encore en cache.",
            }),
            {
              status: 503,
              headers: {
                "Content-Type": "application/json",
                "X-Orbit-Offline": "1",
              },
            }
          );
        })
    );
    return;
  }

  // Hors navigation/API : en dev on ne touche à RIEN (jamais /_next/, jamais /)
  if (IS_DEV) return;

  if (url.pathname.startsWith("/api/")) return; // APIs exclues : réseau direct
  if (url.pathname.startsWith("/_next/webpack-hmr")) return;

  /* ── 3. Statiques (prod) : cache-first (chunks hashés par contenu) ───── */
  event.respondWith(
    caches.match(req).then(
      (cached) =>
        cached ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
    )
  );
});

/* ══════════════════ Web Push (v3, inchangé) ══════════════════
   Payload serveur (lib/push.ts) :
   { title, body, tag?, url?, kind?, type?, data: { view?, eventId?,
     taskId?, emailId?, notificationId? }, actions?, requireInteraction?,
     silent? } */

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload = { title: "Orbit", body: "Vous avez une notification." };
  try {
    payload = event.data.json();
  } catch {
    payload.body = event.data.text();
  }

  const data = payload.data || {};
  const type = payload.type || "";
  const kind = payload.kind || "";

  // Actions par défaut selon le type (max 2 réellement affichées par l'OS)
  let actions =
    payload.actions && payload.actions.length
      ? payload.actions
      : [
          { action: "view", title: "Ouvrir" },
          { action: "dismiss", title: "Ignorer" },
        ];
  if (!payload.actions && type === "TASK_DEADLINE") {
    actions = [
      { action: "view", title: "Voir" },
      { action: "complete", title: "Terminée" },
    ];
  }

  // Icône différenciée par type (icônes existantes du manifest)
  const icon =
    type === "EVENT_REMINDER"
      ? "/icons/icon-192.png"
      : type === "IMPORTANT_EMAIL"
        ? "/icons/icon-192.png"
        : "/icons/icon-192.png";

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon,
      badge: "/icons/icon-192.png",
      tag: payload.tag || "orbit",
      renotify: true, // même tag → remplace l'ancienne notif (fraîcheur garantie)
      requireInteraction: payload.requireInteraction || kind === "event",
      vibrate: payload.silent ? [] : [80, 40, 80],
      silent: Boolean(payload.silent),
      data,
      actions,
    })
  );
});

/* Clic sur la notification (ou action « view ») :
   - fenêtre déjà ouverte → focus + postMessage { orbit: "navigate", view, …}
     (navigation SPA, pas de rechargement) ;
   - action « complete » → PATCH de la tâche terminée + feedback local ;
   - action « dismiss » → fermeture simple ;
   - aucune fenêtre → ouverture de l'app. */
self.addEventListener("notificationclick", (event) => {
  const data = event.notification.data || {};
  const action = event.action;

  // « Terminée » : mutation directe (cookies de session inclus, same-origin)
  if (action === "complete" && data.taskId) {
    event.notification.close();
    event.waitUntil(
      fetch(`/api/tasks/${encodeURIComponent(data.taskId)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      })
        .then((res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return self.registration.showNotification("Orbit — tâche terminée ✓", {
            body: "Bien joué ! La tâche a été marquée comme terminée.",
            tag: `task-done-${data.taskId}`,
            icon: "/icons/icon-192.png",
          });
        })
        .catch(() => {
          // Échec (hors ligne/401) → l'utilisateur la termine dans l'app.
          self.registration.showNotification("Orbit — action impossible hors ligne", {
            body: "Ouvrez Orbit pour marquer la tâche comme terminée.",
            tag: `task-fail-${data.taskId}`,
            data: { view: "tasks", taskId: data.taskId },
          });
        })
    );
    return;
  }

  event.notification.close();
  if (action === "dismiss") {
    // Fermeture simple — le mark-read est géré par « notificationclose ».
    return;
  }

  const view = data.view || null;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          client.focus();
          // Navigation SPA : l'app écoute « message » (app-shell) et change
          // de vue SANS rechargement — deep link vers l'objet concerné.
          if (view && "postMessage" in client) {
            client.postMessage({ orbit: "navigate", ...data });
          }
          return;
        }
      }
      // App fermée : on l'ouvre (le dashboard tient le rôle d'accueil ;
      // la notification reste dans le centre in-app pour le deep link).
      return self.clients.openWindow("/");
    })
  );
});

/* Fermeture de la notification (clic, swipe, action) → marquage lu de
   l'historique serveur (idempotent). Idempotent aussi côté réseau : une
   notification déjà lue renvoie updated: 0. */
self.addEventListener("notificationclose", (event) => {
  const data = event.notification.data || {};
  if (!data.notificationId) return; // pas d'historique (notif de test…)

  event.waitUntil(
    fetch("/api/notifications/mark-read", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notificationId: data.notificationId }),
    }).catch(() => {})
  );
});

/* ══════════════════ Background Sync (v5, offline-first) ══════════════════
   Le tag « orbit-sync » est enregistré par la page à chaque mise en file
   d'une mutation (lib/offline/queue-manager). Quand le navigateur estime le
   réseau revenu, il réveille le SW → on notifie TOUTES les pages ouvertes
   (message SYNC_REQUESTED) → push de l'outbox + pull delta immédiats.
   Sans page ouverte : le replay au montage + la sync initiale rattrapent. */
self.addEventListener("sync", (event) => {
  if (event.tag !== "orbit-sync") return;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ("postMessage" in client) {
            client.postMessage({ type: "SYNC_REQUESTED", tag: "orbit-sync" });
          }
        }
      })
      .catch(() => {})
  );
});

/* Message depuis la page :
   • "skipWaiting" / { type: "SKIP_WAITING" } → activation immédiate (maj SW) ;
   • { type: "CLEAR_CACHES" } → purge Cache Storage (outils réglages) ;
   • { type: "GET_VERSION" } → réponse { type: "VERSION", version } (QA). */
self.addEventListener("message", (event) => {
  const data = event.data;
  if (data === "skipWaiting" || (data && data.type === "SKIP_WAITING")) {
    self.skipWaiting();
    return;
  }
  if (data && data.type === "CLEAR_CACHES") {
    const purge = caches
      .keys()
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .catch(() => {});
    if (event.waitUntil) event.waitUntil(purge);
    return;
  }
  if (data && data.type === "GET_VERSION") {
    if (event.source && "postMessage" in event.source) {
      event.source.postMessage({ type: "VERSION", version: CACHE, apiCache: API_CACHE });
    }
  }
});
