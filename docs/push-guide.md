# Orbit — Notifications Push (guide complet)

Système complet de notifications : **Web Push VAPID**, service worker v3,
rappels automatiques (reminder-service), historique in-app et préférences
par utilisateur. 100 % local, aucune dépendance externe.

```
[navigateur] permission → PushManager.subscribe (clé publique VAPID)
     → POST /api/subscribe (upsert, lié à l'utilisateur)
[envoi]      /api/notify (test | custom | reminders)
                └─ lib/push.ts : sanitization → Notification (historique)
                   → web-push VAPID → appareils actifs → purge 404/410
[planif.]    reminder-service :3032 (cycle 60 s, secret partagé)
                └─ scan : événements + tâches + emails IA + heures calmes
[réception]  public/sw.js v3 → showNotification (actions, deep link)
                └─ clic → postMessage { orbit: navigate, view } → app
                └─ fermeture → POST /api/notifications/mark-read
```

## 1. Installation (déjà fait en sandbox — prod)

```bash
# Clés VAPID (déjà générées dans .env)
bunx web-push generate-vapid-keys

# .env
NEXT_PUBLIC_VAPID_PUBLIC_KEY / VAPID_PUBLIC_KEY="…"   # même clé des deux côtés
VAPID_PRIVATE_KEY="…"                                   # JAMAIS côté client
VAPID_SUBJECT="mailto:notifications@orbit.app"
REMINDER_SERVICE_SECRET="$(openssl rand -hex 24)"      # cron partagé
```

## 2. Routes API

| Route | Méthodes | Rôle |
|---|---|---|
| `/api/subscribe` | GET/POST/DELETE | Statut (clé publique), upsert subscription (endpoint, keys, userAgent, platform), désinscription (soft `isActive=false`) |
| `/api/notifications` | GET | Historique `{ notifications, unreadCount }` (`?limit`, `?unreadOnly`) |
| `/api/notifications/mark-read` | POST | `{ notificationId }` \| `{ ids }` \| `{ all }` (idempotent, appelé aussi par le SW) |
| `/api/notifications/preferences` | GET/PUT | Types activés, `eventReminderTime`, heures calmes (créées à la volée) |
| `/api/notify` | POST | `test` (session, 10/min) · `custom` (session, Zod) · `reminders` (secret service) |

## 3. Rappels automatiques (scan 60 s)

- **Événements** — rappels par événement (`reminders` JSON, défaut =
  `eventReminderTime`), occurrences de séries expansées, anti-doublon
  `reminderLog` (occurrence::minutes::type). Rappel `email` = EmailLog
  synthétique local.
- **Tâches** — « échéance aujourd'hui » (1×/jour/tâche, anti-doublon
  Notification `taskId`) + imminence H-1 (filet `reminderSentAt`).
- **Emails importants IA** — `suggestedEvent` détecté et non confirmé
  (fenêtre 7 j, 1 seule fois par email).
- **Heures calmes** — blocage SAUF imminence < 15 min (on ne fait jamais
  rater un rendez-vous) ; interprétées dans le fuseau de l'utilisateur,
  plages pouvant traverser minuit.
- **Hygiène** — purge des notifications > 30 j à chaque cycle.

En production sans reminder-service : cron externe
`curl -X POST https://…/api/notify -H "x-orbit-service-secret: …" -d '{"type":"reminders"}'`
(équivalent Vercel Cron : `*/5 * * * *`).

## 4. Service Worker v3 (`public/sw.js`)

- `push` → `showNotification` (payload `{title, body, tag, data, actions,
  requireInteraction, silent}` ; actions `Voir`/`Terminée` pour les tâches).
- `notificationclick` → app ouverte : focus + **postMessage**
  `{ orbit: "navigate", view, taskId… }` (navigation SPA, écouté par
  app-shell) ; action `complete` → `PATCH /api/tasks/:id` direct (cookies
  inclus) ; app fermée → `openWindow("/")`.
- `notificationclose` → `mark-read` (si `data.notificationId`).
- **Dev-safe** : le handler `fetch` est désactivé sur localhost (bug 13-b :
  cache-first des chunks non hashés) — le SW reste enregistré en dev pour
  tester les push ; cache `orbit-v3` (purge des v2 à l'activate).

## 5. Tester

```bash
# 1. Scan manuel complet
curl -X POST http://localhost:3032/run

# 2. Notification de test (session navigateur)
POST /api/notify {"type":"test"}          # bouton « Envoyer un test » (Réglages)

# 3. Alerte personnalisée
POST /api/notify {"type":"custom","title":"…","body":"…"}

# 4. Heures calmes : régler 22:00→08:00 (Réglages), créer un événement
#    dans ~16 min avec rappel 20 min → POST :3032/run → quietBlocked: 1
```

Navigateur : Réglages → « Activer les rappels push » (permission contextuelle,
jamais à l'inscription) → notification de bienvenue → bouton « Envoyer un
test ». Centre de notifications (cloche) : section **À traiter** (live) +
**Historique** (persisté, clic = marque lu + deep link, « Tout lu »).

## 6. Dépannage

| Symptôme | Cause probable | Correction |
|---|---|---|
| « Permission refusée » | Navigateur : permission bloquée | Icône cadenas → Notifications → Autoriser, puis Réactiver |
| « Aucun appareil abonné » | Subscription non enregistrée / purgée | Re-cliquer « Activer les rappels push » |
| Push parti mais pas affiché | SW pas à jour (v2) | Recharger 2× (activate purge v2) ou `navigator.serviceWorker.getRegistration().then(r => r.update())` |
| 401 sur `/api/notify` | Secret service absent/faux | `REMINDER_SERVICE_SECRET` identique dans `.env` (Next.js + reminder-service le relisent) |
| Notifs nocturnes | Heures calmes désactivées | Réglages → Heures calmes (imminence < 15 min passe toujours) |
| Rappels en double | (rare) log corrompu | Les tags remplacent (renotify) — vérifier `reminders` de l'événement |

**Notes** : les notifications sont privées (payload chiffré par le service
push standard, aucune donnée analytique) ; la clé VAPID privée reste
serveur-only ; `data` exposé au client est blanchi (ids + vue uniquement).
