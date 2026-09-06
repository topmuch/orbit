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

---

# Partie 2 — Envoi SMTP (boîte complète style Gmail/Outlook)

## Vue d'ensemble

La boîte Orbit est désormais complète :

| Fonctionnalité | Détail |
|---|---|
| **Dossiers virtuels** | Boîte · Étoilés · Envoyés · Archivés · Corbeille (compteurs en sidebar) |
| **Lecture riche** | HTML des emails nettoyé (sanitize-html) + rendu dans une **iframe sandbox** — double barrière anti-XSS |
| **Pièces jointes** | Stockées sur disque (`storage/attachments/`, 10 max, 15 Mo max) — téléchargement authentifié |
| **Images inline** | `cid:` réécrit en data-URI par mailparser → rendu direct dans l'iframe |
| **Envoi SMTP** | Répondre / Répondre à tous / Transférer / Écrire — copie dans « Envoyés » |
| **Actions groupées** | Sélection multiple → lus/non lus, étoiler, archiver, corbeille, suppression définitive |
| **Recherche** | Sujet + expéditeur + corps, debounce 300 ms, filtre par compte |
| **Raccourcis clavier** | `R` répondre · `A` archiver · `S` étoiler · `#` corbeille · `Échap` retour |
| **Drapeaux serveur** | `\Seen`/`\Flagged` propagés vers l'IMAP (best-effort) — lecture/étoile cohérentes partout |
| **Quasi temps réel** | Rafraîchissement 60 s côté UI + sync automatique 60 s côté serveur |

## Configuration SMTP (Gmail / Outlook / iCloud)

Dans **Réglages → Comptes email**, éditez un compte et activez « Envoi SMTP » :

| Fournisseur | Serveur | Port | Mode |
|---|---|---|---|
| Gmail | `smtp.gmail.com` | 465 | TLS (ou 587 STARTTLS) |
| Outlook / Office 365 | `smtp.office365.com` | 587 | STARTTLS |
| iCloud | `smtp.mail.me.com` | 465 | TLS |
| Yahoo | `smtp.mail.yahoo.com` | 465 | TLS |
| Free | `smtp.free.fr` | 465 | TLS |

- **Identifiants** : laissez vides pour réutiliser ceux de l'IMAP (Gmail/Outlook
  utilisent les mêmes) ; sinon renseignez les champs dédiés.
- **Gmail/Outlook avec 2FA** : mot de passe d'**application** obligatoire
  (https://myaccount.google.com/apppasswords).
- **Test préalable** : bouton « Tester le SMTP » (EHLO + AUTH + NOOP, rien
  n'est enregistré). La création avec SMTP teste aussi avant tout stockage.
- Le mot de passe SMTP est chiffré **AES-256-GCM** comme l'IMAP (clé dérivée
  de `AUTH_SECRET`, jamais en clair, jamais renvoyé).

## Sécurité — les 5 règles

1. **HTML blanchi au stockage** : `sanitize-html` retire `<script>`, styles,
   `onclick`, schémas `javascript:`, iframes… (cf. `lib/html-sanitize.ts`).
2. **Rendu isolé** : iframe `sandbox="allow-popups"` (pas de scripts, pas
   d'accès au DOM parent) + `<base target="_blank">` pour les liens.
3. **Pièces jointes contrôlées** : `/api/emails/attachments/[id]` vérifie
   session + propriété, `nosniff`, noms aléatoires sur disque (anti-traversal).
4. **Rate limiting** : envoi 50/h/utilisateur, bulk 30/min, comptes 10/min.
5. **Jamais de secret en log** : `logger: false` chez nodemailer et imapflow.

## QA en sandbox (mock SMTP)

```bash
bun scripts/mock-smtp-server.ts   # localhost:2525 (plaintext, AUTH PLAIN/LOGIN)
# identifiants : qa@orbit.app / qa-smtp-pass
```

Compte Orbit : SMTP `127.0.0.1:2525`, mode TLS décoché, mot de passe
`qa-smtp-pass`. Le mock IMAP sert en plus un 4e message multipart
(HTML « sale » + image inline + PDF) qui valide toute la chaîne :
sanitization → stockage → rendu iframe → téléchargement de pièce jointe.

> Volume Docker production : monter `./storage` (pièces jointes persistantes).

## Dépannage SMTP

| Erreur | Cause probable |
|---|---|
| « Authentification SMTP refusée » | Mot de passe d'application manquant (2FA) |
| « Envoi refusé par le serveur (relais interdit) » | Le compte n'est pas autorisé à envoyer (FAI) |
| « Négociation TLS impossible » | Mauvais mode : TLS 465 ≠ STARTTLS 587 |
| « Serveur SMTP introuvable » | Nom d'hôte erroné |
| 409 « Envoi non configuré » | Aucun `smtpHost` sur le compte → Réglages → Envoi SMTP |
