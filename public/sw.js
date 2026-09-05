/* Orbit — Service Worker v3
   ─────────────────────────────────────────────────────────────────────────
   Deux rôles :
   1. CACHE/PWA (production) : navigations network-first, statiques
      cache-first, API hors cache. EN DÉVELOPPEMENT (localhost:3000) le
      handler fetch est DÉSACTIVÉ : les chunks /_next/ dev ne sont pas
      hashés et un cache-first gèlerait le bundle (bug 13-b) — mais le SW
      reste enregistré pour permettre les notifications push en dev.
   2. NOTIFICATIONS (v3) : affichage des push reçus (payload enrichi),
      actions par type (Ouvrir / Ignorer / Terminée), deep link par
      postMessage vers l'app ouverte (navigation SPA sans rechargement),
      « terminer une tâche » directement depuis la notification, et
      marquage « lu » de l'historique à la fermeture.
   ───────────────────────────────────────────────────────────────────────── */

const CACHE = "orbit-v3";
const IS_DEV =
  location.hostname === "localhost" || location.hostname === "127.0.0.1";

const PRECACHE = [
  "/",
  "/offline.html",
  "/manifest.json",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        // Dev : précachage minimal (jamais la page dev), prod : complet.
        IS_DEV
          ? cache.addAll(["/manifest.json", "/offline.html"]).catch(() => {})
          : cache.addAll(PRECACHE).catch(() => {})
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Cache/PWA — PRODUCTION UNIQUEMENT (cf. en-tête : bug 13-b en dev). */
if (!IS_DEV) {
  self.addEventListener("fetch", (event) => {
    const req = event.request;
    if (req.method !== "GET") return;

    const url = new URL(req.url);
    if (url.origin !== location.origin) return;
    if (url.pathname.startsWith("/api/")) return; // données : toujours réseau
    if (url.pathname.startsWith("/_next/webpack-hmr")) return;

    if (req.mode === "navigate") {
      event.respondWith(
        fetch(req)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put("/", copy));
            return res;
          })
          .catch(() =>
            caches.match(req).then((cached) => cached || caches.match("/offline.html"))
          )
      );
      return;
    }

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
}

/* ══════════════════ Web Push (v3) ══════════════════
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

/* Message depuis la page (ex. « skipWaiting » après mise à jour) */
self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") self.skipWaiting();
});
