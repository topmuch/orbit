# syntax=docker/dockerfile:1
# ═══════════════════════════════════════════════════════════════════════════
# Orbit — image Docker de PRODUCTION (application web Next.js 16 App Router)
# ───────────────────────────────────────────────────────────────────────────
# Construction :  docker build -t ghcr.io/topmuch/orbit/web:latest .
# (ou via docker-compose.prod.yml :  docker compose build web web-migrate)
#
# Étages (multi-stage) :
#   deps    → dépendances via bun (couche cachée sur package.json + bun.lock)
#   builder → prisma generate + next build (sortie "standalone")
#   migrate → job jetable : `bunx prisma db push` contre le volume orbit_db
#   runner  → image finale minimale, non-root, healthcheck /api/health
#
# Choix techniques (à ne pas changer sans relire la doc du projet) :
#   • BUN est le runtime UNIQUE du projet (bun.lock, jamais npm/node) →
#     image officielle oven/bun:1 (Debian bookworm : bun inclus, node absent).
#     Le serveur standalone démarre par `bun server.js`, exactement comme en
#     local (`NODE_ENV=production bun .next/standalone/server.js`).
#   • `output: "standalone"` est déjà actif dans next.config.ts : next build
#     produit .next/standalone (server.js + node_modules traçé minimal).
#     On copie ensuite .next/standalone, .next/static et public SÉPARÉMENT
#     dans le runner — on n'utilise PAS `bun run build` (ce script fait des
#     cp relatifs pensés pour la sandbox, inadaptés en Docker).
#   • SQLite via Prisma (jamais PostgreSQL) : DATABASE_URL=file:/app/db/custom.db
#     → la base vit dans le volume Docker `orbit_db` ; les pièces jointes
#     emails dans /app/storage (volume `orbit_storage`) car le code les écrit
#     sous process.cwd()/storage/attachments.
#   • AUCUNE variable NEXT_PUBLIC_* n'existe dans le code (la clé VAPID
#     publique est servie par une API serveur) → AUCUN ARG de build : tous
#     les secrets (AUTH_SECRET, VAPID_*, …) sont injectés au RUNTIME par
#     docker-compose.prod.yml, jamais dans les couches d'image.
#   • utilisateur non-root `orbit` (uid/gid 1001) partout où c'est possible.
# ═══════════════════════════════════════════════════════════════════════════

# ── Étage 1/4 : dépendances (bun install, caché par Docker) ────────────────
# Le lockfile garantit une installation reproductible ; --frozen-lockfile
# échoue si bun.lock et package.json divergent (sécurité de build).
FROM oven/bun:1 AS deps
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ── Étage 2/4 : build Next.js ──────────────────────────────────────────────
# Hérite de deps (node_modules présent : next, prisma, @prisma/client…).
FROM deps AS builder
WORKDIR /app

# Sources applicatives — le .dockerignore de la racine exclut données
# utilisateurs (db/, storage/), secrets (.env*), logs et dossiers hors build.
COPY . .

# Le client Prisma 6 doit être généré AVANT le build Next
# (src/lib/db.ts importe @prisma/client à la génération des bundles serveur).
RUN bunx prisma generate

# Base SQLite jetable avec le schéma appliqué, POUR LE BUILD UNIQUEMENT :
# si une page était prérendue (SSG) et lisait la base pendant next build,
# elle trouverait une base vide mais valide. Cette base vit sous
# /app/.build-db (chemin DIFFÉRENT de /app/db) afin de ne JAMAIS finir dans
# le volume orbit_db de production — l'étage migrate y applique lui-même le
# schéma au premier lancement.
RUN mkdir -p /app/.build-db \
 && DATABASE_URL=file:/app/.build-db/custom.db bunx prisma db push --skip-generate

ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    DATABASE_URL=file:/app/.build-db/custom.db

# `bunx next build` (et PAS `bun run build` — voir en-tête). Produit
# .next/standalone (server.js + node_modules traçés, dont le client Prisma,
# imapflow/mailparser/nodemailer en serverExternalPackages) + .next/static.
RUN bunx next build

# ── Étage 3/4 : job de migration (one-shot) ────────────────────────────────
# Utilisé par le service `web-migrate` de docker-compose.prod.yml, qui monte
# le volume orbit_db sur /app/db puis exécute `bunx prisma db push` (le
# projet n'a PAS de dossier migrations/ : db push, idempotent, est la
# convention SQLite du repo). `web` attend la réussite de ce job
# (service_completed_successfully) avant de démarrer.
FROM builder AS migrate
WORKDIR /app

# /app/db est le point de montage du volume : un dossier vide appartenant à
# `orbit` initialise le volume avec les bons droits au premier lancement
# (Docker copie le contenu+droits de l'image au premier montage d'un volume
# nommé vide).
RUN groupadd --gid 1001 orbit \
 && useradd --uid 1001 --gid orbit --shell /bin/sh --create-home orbit \
 && mkdir -p /app/db \
 && chown orbit:orbit /app/db

# Écrase la DATABASE_URL de l'étage builder (base jetable → volume réel).
ENV DATABASE_URL=file:/app/db/custom.db
USER orbit

# --skip-generate : le client Prisma est déjà généré à l'étape builder et
# node_modules (propriété root) n'est pas réinscriptible par l'utilisateur
# orbit. db push ne fait alors qu'écrire dans /app/db (le volume).
ENTRYPOINT ["bunx", "prisma", "db", "push", "--skip-generate"]

# ── Étage 4/4 : image finale (runner, cible PAR DÉFAUT) ────────────────────
FROM oven/bun:1 AS runner
WORKDIR /app

# openssl       → moteur de requêtes Prisma (binaire Debian bookworm)
# ca-certificates → TLS sortant (web-push, IMAP/SMTP, ACME côté web)
# sqlite3       → inspection/debug de la base depuis le conteneur
# curl          → HEALTHCHECK (et dépannage via docker compose exec)
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates sqlite3 curl \
 && rm -rf /var/lib/apt/lists/*

# Utilisateur non-root : aucun processus applicatif ne tourne en root.
RUN groupadd --gid 1001 orbit \
 && useradd --uid 1001 --gid orbit --shell /bin/sh --create-home orbit

# Sortie standalone : d'abord server.js + node_modules traçés, puis les
# assets statiques et publics (convention Next.js standalone). --chown :
# tout appartient à `orbit` (Next écrit ses caches dans .next/cache au
# runtime — optimisation d'images notamment).
COPY --from=builder --chown=orbit:orbit /app/.next/standalone ./
COPY --from=builder --chown=orbit:orbit /app/.next/static ./.next/static
COPY --from=builder --chown=orbit:orbit /app/public ./public
# Filet de sécurité Prisma : le moteur de requêtes
# (libquery_engine-debian-openssl-3.0.x.so.node, ~17 Mo) est chargé
# DYNAMIQUEMENT par @prisma/client au runtime → il est invisible pour le
# tracing statique de Next et peut manquer dans le node_modules standalone.
# On copie donc le client généré (~20 Mo) explicitement : si le tracing
# l'avait déjà inclus, cette copie écrase avec un contenu identique.
COPY --from=builder --chown=orbit:orbit /app/node_modules/.prisma ./node_modules/.prisma

# Points de montage des volumes docker-compose.prod.yml :
#   /app/db      ← volume orbit_db       (base SQLite)
#   /app/storage ← volume orbit_storage  (pièces jointes emails)
RUN mkdir -p /app/db /app/storage && chown orbit:orbit /app/db /app/storage

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DATABASE_URL=file:/app/db/custom.db

USER orbit
EXPOSE 3000

# /api/health est fournie par l'application : elle vérifie base + services
# en aval. Utilisée par compose (depends_on service_healthy de reminder et
# backup) et par le HEALTHCHECK Docker ci-dessous.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://127.0.0.1:3000/api/health || exit 1

CMD ["bun", "server.js"]
