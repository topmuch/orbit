# Orbit — Mode hors ligne complet (Task 7)

> Consultation hors ligne (cache des données), actions mises en file
> d'attente et synchronisées automatiquement, notifications planifiées
> (queue serveur `scheduledAt`), PWA installable.

## Les trois étages

### 1. Lectures hors ligne — Service Worker v4 (`public/sw.js`)

- **GET `/api/*`** : network-first → **cache de secours** (`orbit-api-v4`).
  Les réponses servies depuis le cache portent l'en-tête `X-Orbit-Offline: 1`
  (données potentiellement périmées). Cache borné (~150 entrées, LRU
  approximatif), jamais de réponse avec `Set-Cookie`.
- **Navigations** : réseau d'abord → page `/` en cache (production) →
  `offline.html` en dernier recours. En développement, seul `offline.html`
  est servi en secours — **jamais la page dev ni les chunks `/_next/`**
  (bug 13-b : bundle gelé, irrésolu par conception).
- **Exclusions** (toujours réseau direct) : `/api/notify`, `/api/subscribe`,
  `/api/ai/*` (réponses générées), exports (binaires), test IMAP.
  La **session** (`/api/auth/session`) est cachée : fraîche en ligne, dernier
  état connu hors ligne → on reste identifié (la déconnexion est un POST,
  réseau requis).

### 2. Mutations hors ligne — file d'attente IndexedDB (`src/lib/offline-queue.ts`)

Quand une écriture (créer/éditer/déplacer une tâche, un événement, marquer un
email lu…) échoue pour raison réseau :

1. `api()` (lib/api-client) attrape le `TypeError` de fetch → la mutation
   rejoint la **file IndexedDB** (`orbit-offline/queue`, ordre FIFO) ;
2. toast « Hors ligne — action mise en file d'attente » + badge ambre
   **« N en attente »** dans le header (clic = tentative immédiate) ;
3. l'UI de la mutation reste en attente : à la reconnexion la promesse se
   résout avec la **vraie réponse serveur** (timeout 15 min → message, mais
   l'action RESTE en file et partira plus tard) ;
4. **Replay** (événement `online`, montage, garde 60 s) : rejoué dans
   l'ordre avec les cookies de session — 2xx → synchronisé ; 4xx → abandon
   (état serveur divergent, signalé) ; 5xx/réseau → reste en file ;
5. après un replay réussi, l'événement `orbit:data-synced` invalide TOUTES
   les requêtes React Query (données rafraîchies).

**Non mis en file** : IA (`/api/ai/*` — réponse générée en direct), auth,
push/subscribe, sync IMAP et comptes email (connexion immédiate requise),
import/export (fichiers).

> Robustesse : on ne se fie pas à `navigator.onLine` (il ment — portail
> captif, WiFi « connecté » sans internet). Tout `TypeError` de fetch
> same-origin sur une mutation mettable en file est traité comme une coupure
> réseau.

### 3. Notifications planifiées — queue serveur `Notification.scheduledAt`

- **Programmer une alerte** (bouton « Programmer » du centre de
  notifications) : `POST /api/notify {type:"custom", title, body, scheduledAt}`
  (futur, max 7 jours) → la Notification rejoint la file (`isSent=false`) ;
- le cycle reminder-service (:3032, 60 s) **envoie à l'échéance exacte** via
  `sendExistingNotification` (push + historique marqué) — même application
  fermée, indépendamment de la connexion client (c'est le serveur qui envoie ;
  le service push retient le message jusqu'à livraison) ;
- visible dans l'historique avec le badge ambre **« planifiée »** et l'heure
  d'envoi ; l'heure choisie prime sur les heures calmes (choix explicite) ;
- sans appareil abonné : livraison in-app uniquement (marquée traitée).

## PWA

- Manifest complet (192/512/maskable, standalone, fr) + `offline.html`
  précaché ; installation via le bouton du header / Réglages
  (`beforeinstallprompt`) ;
- SW mis à jour sans intervention (`skipWaiting` + purge des caches
  obsolètes à l'activation) ;
- indicateurs : badge « Hors ligne » (header + Réglages), badge
  « N en attente », toasts de transition.

## Test rapide (QA)

- Couper le serveur Next.js : l'app sert les données depuis le cache
  (`X-Orbit-Offline: 1`) ; recharger → `offline.html` ; redémarrer → retour
  à la normale, file résiduelle rejouée.
- Simuler une coupure ciblée : rejeter les fetchs non-GET depuis la console,
  puis `window.__orbitOffline.replay()` (hook de débogage dev-only :
  `getQueued`, `replay`, `clear`, `count`).

## Limites connues

- Les mutations créées hors ligne n'apparaissent dans les listes qu'après
  replay (les listes se rafraîchissent à la reconnexion) ;
- le cache hors ligne est un **instantané** : les données peuvent dater de la
  dernière visite en ligne (en-tête `X-Orbit-Offline`) ;
- les actions excluses (IA, sync IMAP, auth) nécessitent le réseau.
