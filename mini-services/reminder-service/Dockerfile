# syntax=docker/dockerfile:1
# ═══════════════════════════════════════════════════════════════════════════
# Orbit — micro-service de rappels (reminder-service) · port 3032
# ───────────────────────────────────────────────────────────────────────────
# Boucle REMINDER_INTERVAL_MS → POST ${APP_URL}/api/notify avec l'en-tête
# x-orbit-service-secret (secret partagé). Serveur de supervision sur
# GET /health. Voir docker-compose.prod.yml (service `reminder`).
#
# Spécificités :
#   • Bun PUR, ZÉRO dépendance npm (package.json sans "dependencies") →
#     pas de bun install : on copie package.json + index.ts, c'est tout.
#   • En dev, index.ts charge ../../.env ; en conteneur ce chemin n'existe
#     pas (Bun.file échoue → catch silencieux) : la config vient ENTIEREMENT
#     des variables d'environnement du compose.
#   • En production on lance `bun index.ts` SANS --hot (le --hot est réservé
#     au script "dev" — jamais de rechargement à chaud en prod).
#   • APP_URL=http://web:3000 : résolution par le DNS interne du réseau
#     Docker orbit_network (le rappel passe par le reverse proxy interne,
#     pas par le domaine public — pas de TLS à traverser).
# ═══════════════════════════════════════════════════════════════════════════
FROM oven/bun:1
WORKDIR /app

# curl : HEALTHCHECK compose sur :3032/health (aucune autre dépendance).
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# Utilisateur non-root (même uid/gid 1001 que l'image web).
RUN groupadd --gid 1001 orbit \
 && useradd --uid 1001 --gid orbit --shell /bin/sh --create-home orbit

# Le .dockerignore local exclut node_modules, service.log et .env* :
# le contexte ne contient que package.json et index.ts.
COPY --chown=orbit:orbit package.json index.ts ./

ENV NODE_ENV=production \
    PORT=3032 \
    APP_URL=http://web:3000

USER orbit
EXPOSE 3032

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD curl -f http://127.0.0.1:3032/health || exit 1

CMD ["bun", "index.ts"]
