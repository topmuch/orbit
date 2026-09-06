# Orbit — Emails réels IMAP (Task 6)

> Vraies boîtes de réception dans Orbit : connexion IMAP **lecture seule**,
> mots de passe **chiffrés AES-256-GCM**, synchronisation automatique.

## Vue d'ensemble

```
[navigateur] ── Réglages → « Comptes email (IMAP) »
      │  POST /api/email/accounts (test de connexion PRÉALABLE, puis stockage)
      ▼
[Next.js /api/email/*] ── lib/secret-box (AES-256-GCM, clé dérivée AUTH_SECRET)
      │                        └── mot de passe chiffré AVANT tout stockage
      ▼
[lib/imap.ts] ── imapflow + mailparser (lecture seule, BODY.PEEK[])
      │              upsert EmailLog par (userId, messageId) — idempotent
      ▼
[reminder-service :3032] ── POST /api/notify {type:"email-sync"} toutes les 60 s
                            (la route ne traite que les comptes ÉCHUS)
```

## Sécurité

- **Chiffrement au repos** : `passwordEnc` = `v1:<iv>:<tag>:<chiffré>`
  (AES-256-GCM authentifié). Clé = SHA-256 de `AUTH_SECRET|orbit:secret-box:v1`
  — aucun secret supplémentaire à gérer.
- Le mot de passe est déchiffré **uniquement en mémoire**, le temps de la
  connexion IMAP. Jamais loggé (logger imapflow désactivé), jamais renvoyé
  dans un DTO (`EmailAccountDto` n'expose aucun champ secret).
- Rotation possible : ressaisir le mot de passe dans « Modifier » si
  `AUTH_SECRET` change (l'erreur « illisible » est explicite).
- `allowSelfSigned` : accepte les certificats auto-signés (serveurs internes,
  QA) — déconseillé sur Internet.

## Routes

| Route | Auth | Description |
|---|---|---|
| `GET /api/email/accounts` | session | Comptes (sans secrets) + nb d'emails |
| `POST /api/email/accounts` | session | Création — **test IMAP préalable** (sauf `test:false`), chiffrement, 409 si adresse déjà configurée |
| `PATCH /api/email/accounts/[id]` | session | Réglages ; mot de passe vierge = inchangé ; re-test si identifiants modifiés (`test:true`) |
| `DELETE /api/email/accounts/[id]` | session | Supprime le compte — **les emails restent** (accountId → null) |
| `POST /api/email/accounts/test` | session | Test de connexion SANS stockage (rate limit 10/min) |
| `POST /api/email/accounts/[id]/sync` | session | Synchronisation immédiate d'un compte |
| `POST /api/emails/sync` | session | Synchronise tous les comptes actifs ; **fallback démo** (`demo:true`) si aucun compte |
| `POST /api/notify {type:"email-sync"}` | secret service | Cycle automatique (comptes dus uniquement) |

## Synchronisation

- **Fenêtre** : première sync = `fetchDays` derniers jours (7/30/90/365) ;
  ensuite `lastSyncAt` − 10 min de recouvrement (les dates IMAP sont
  approximatives au jour près).
- **Dédoublonnage** : upsert sur `@@unique([userId, messageId])` —
  re-synchroniser ne duplique jamais ; un même Message-ID reçu sur deux
  comptes d'un même utilisateur n'apparaît qu'une fois.
- **Bornes** : `maxMessages` par passe (défaut 100), corps tronqué à 20 000
  caractères — SQLite reste léger.
- **Lecture seule** : `BODY.PEEK[]` (imapflow) → jamais de `\Seen` posé côté
  serveur, aucun STORE/EXPUNGE.
- Erreurs traduites en FR actionnable (auth refusée → mot de passe
  d'application pour Gmail/Outlook, host introuvable, port, timeout, certificat).

## Serveurs courants (pré-remplissage UI)

Gmail `imap.gmail.com:993` (mot de passe d'application) · Outlook
`outlook.office365.com:993` · iCloud `imap.mail.me.com:993` (mot de passe
d'application) · Yahoo `imap.mail.yahoo.com:993` · Free `imap.free.fr:993` ·
Orange `imap.orange.fr:993`.

## QA en sandbox (serveur IMAP mock)

Le sandbox n'a pas accès à un vrai serveur IMAP — un **mock IMAP complet**
(TLS auto-signé) permet de valider la chaîne réelle :

```bash
bun scripts/mock-imap-server.ts     # imaps://localhost:3993
# identifiants : qa@orbit.app / qa-imap-pass
```

Dans Orbit : Ajouter un compte → serveur `127.0.0.1`, port `3993`, TLS ✓,
« Certificat auto-signé » ✓, identifiants QA. 3 messages MIME (ASCII simple,
UTF-8 base64 avec accents, texte long) sont servis — parse complet validé
(objets encodés, noms d'affichage, corps, dates).

> Note : `imapflow` tourne dans le processus Next.js (Node) — c'est bien le
> vrai client IMAP utilisé en production.
