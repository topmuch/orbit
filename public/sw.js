/* Orbit — Service Worker
   Stratégie : navigations en network-first (fraîcheur), statiques cache-first, API hors cache. */

const CACHE = "orbit-v1";
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
      .then((cache) => cache.addAll(PRECACHE))
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

/* Web Push — affichage des notifications reçues du serveur Orbit
   Payload attendu : { title, body, tag?, url?, kind? } */
self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload = { title: "Orbit", body: "Vous avez une notification." };
  try {
    payload = event.data.json();
  } catch {
    payload.body = event.data.text();
  }

  const tag = payload.tag || "orbit";
  const url = payload.url || "/";

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag,
      renotify: true, // même tag → remplace l'ancienne notif (fraîcheur garantie)
      requireInteraction: payload.kind === "event" || payload.kind === "task",
      vibrate: [80, 40, 80],
      data: { url },
      actions: [
        { action: "open", title: "Ouvrir Orbit" },
        { action: "dismiss", title: "Ignorer" },
      ],
    })
  );
});

/* Clic sur la notification (ou action « open ») :
   - fenêtre déjà ouverte → focus + navigation vers le deep link
   - sinon → ouverture de l'app
   - action « dismiss » → fermeture simple */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  if (event.action === "dismiss") return;

  const url = event.notification.data?.url || "/";

  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          client.focus();
          if ("navigate" in client && url !== "/" && client.url !== self.location.origin + url) {
            client.navigate(url).catch(() => {});
          }
          return;
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
