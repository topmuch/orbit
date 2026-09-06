# Orbit — Guide de déploiement production

> Déploiement **complet et 100 % local** sur un serveur dédié : application
> (Next.js/Bun), SQLite, IA Ollama, rappels, reverse proxy **Caddy** (HTTPS
> automatique), monitoring (Prometheus/Grafana/Loki) et sauvegardes —
> le tout orchestré par `docker-compose.prod.yml`.
>
> ⚠️ Toutes les commandes de ce guide s'exécutent **sur le serveur de
> production** (l'environnement de développement sandbox n'a pas Docker).

## Vue d'ensemble

```
                    Internet (80/443)
                          │
                     ┌────▼─────┐
                     │  caddy   │  TLS ACME auto · HTTP→HTTPS · www→apex
                     └────┬─────┘  grafana.DOMAIN · prometheus.DOMAIN
              ┌───────────┼───────────────┐
         ┌────▼───┐  ┌────▼────┐    ┌─────▼─────┐
         │  web   │  │ ai-api  │    │  ollama   │
         │ (Next) │  │ (FastAPI│    │llama3.1:8b│
         │        │  │  :3031) │    │  ~4,9 Go  │
         └────┬───┘  └─────────┘    └───────────┘
              │            reminder :3032 ──► web /api/notify (secret)
   orbit_db   │            backup (snapshot SQLite + pièces jointes)
   (SQLite)   │
              └── volumes Docker : orbit_db · orbit_storage · orbit_backups
                                  ollama_models · caddy_data · caddy_config
```

## 📋 1. Prérequis

### Matériel — deux modes, à choisir AVANT d'acheter/louer

| Mode | CPU | RAM | Disque | Usage |
|---|---|---|---|---|
| **Sans IA locale** (ai-api+ollama non démarrés) | 2 cœurs | 2 Go | 20 Go | App + emails + rappels ; les fonctions IA sont indisponibles |
| **Avec Ollama llama3.1:8b** (recommandé) | 4-8 cœurs | **16 Go** (8 Go min. + swap) | 30+ Go **SSD** | Tout Orbit, IA comprise |

> 💡 Un **GPU NVIDIA est optionnel** (accélération ~10× de l'inférence) —
> sans GPU, Ollama fonctionne sur CPU mais lentement (voir FAQ).
> Prévoir le disque : modèle ~4,9 Go + données + sauvegardes.

### Logiciels

- Ubuntu 22.04 LTS ou Debian 12 (à jour)
- **Docker 24+** avec **Compose v2** (`docker compose`, pas `docker-compose`)
- `git`, `curl`, `jq` (pratique pour lire `/api/health`)

### DNS — chez votre registrar

Avant tout démarrage, créez ces enregistrements (remplacez `orbit.exemple.fr`
et `203.0.113.10` par vos valeurs) :

| Enregistrement | Type | Cible | Sert à |
|---|---|---|---|
| `orbit.exemple.fr` | `A` | `203.0.113.10` | **l'application** |
| `www.orbit.exemple.fr` | `A` ou `CNAME` | idem apex | redirection www→apex (Caddy) |
| `grafana.orbit.exemple.fr` | `A` ou `CNAME` | idem | dashboards Grafana |
| `prometheus.orbit.exemple.fr` | `A` ou `CNAME` | idem | interface Prometheus |

> 💡 Ajoutez un `AAAA` en plus du `A` si votre serveur a de l'IPv6 — Caddy
> gère les deux. Attendez la propagation DNS (`dig +short orbit.exemple.fr`)
> **avant** le premier démarrage, sinon Let's Encrypt échouera.

## 🔧 2. Préparation du serveur

```bash
# Pare-feu : SSH + HTTP + HTTPS uniquement
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status

# Docker (script officiel)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # puis se déconnecter/reconnecter
docker compose version          # doit afficher v2.x

# Anti-brute-force SSH (recommandé)
sudo apt update && sudo apt install -y fail2ban jq
```

> ⚠️ Ne **jamais** ouvrir d'autres ports : SQLite, Ollama et les services
> internes ne sont accessibles que dans le réseau Docker `orbit_network`.

## 📥 3. Récupération du code & configuration

```bash
sudo mkdir -p /opt/orbit && sudo chown $USER /opt/orbit
git clone https://github.com/<votre-compte>/orbit.git /opt/orbit
cd /opt/orbit

cp .env.production.example .env.production
```

### Génération de TOUS les secrets

Éditez `.env.production` et renseignez chaque valeur (rôle et commandes
détaillées dans le fichier lui-même) :

```bash
# AUTH_SECRET — OBLIGATOIRE (sessions + clé de chiffrement des mots de passe
# IMAP/SMTP). Généré une seule fois, JAMAIS changé ensuite :
openssl rand -hex 32

# REMINDER_SERVICE_SECRET — authentifie reminder-service vers /api/notify :
openssl rand -hex 24

# METRICS_SECRET — OPTIONNEL, protège /api/metrics :
openssl rand -hex 24

# Clés VAPID (Web Push) — si bun n'est pas installé : npx web-push generate-vapid-keys
npx web-push generate-vapid-keys
#  → renseigner VAPID_PUBLIC_KEY et VAPID_PRIVATE_KEY
```

Renseignez aussi : `DOMAIN_NAME`, `ACME_EMAIL`, `GRAFANA_ADMIN_PASSWORD`,
éventuellement `OLLAMA_MODEL`/`TZ`. Vérifiez le fichier :

```bash
grep -E "^[A-Z_]+=" .env.production   # aucune valeur ne doit rester "generer-avec…"
```

> ⚠️ `.env.production` ne quitte **jamais** le serveur : `.env*` est ignoré
> par git. Aucun secret n'apparaît dans les images Docker (pas de build arg —
> les variables sont injectées au démarrage des conteneurs).

### Première fois avec l'IA locale : pré-télécharger le modèle

Le conteneur `ollama` télécharge automatiquement le modèle (~**4,9 Go**) au
premier démarrage. Lancez-le AVANT le reste pour ne pas bloquer le démarrage
global (le healthcheck de `ai-api` attend le modèle) :

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d ollama
docker compose -f docker-compose.prod.yml --env-file .env.production logs -f ollama
#   → patienter « pulling manifest… 100% » (plusieurs minutes selon le débit)
# ou forcer manuellement :
docker compose -f docker-compose.prod.yml --env-file .env.production exec ollama ollama pull llama3.1:8b
```

> 💡 Mode sans IA ? Ignorez cette étape et démarrez normalement — les
> fonctions IA afficheront « momentanément indisponible », tout le reste
> fonctionne. Vous pourrez activer ollama plus tard sans rien réinstaller.

## 🚀 4. Premier démarrage

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
docker compose -f docker-compose.prod.yml --env-file .env.production ps
```

**Le service `web-migrate`** (Exited 0) est normal : c'est un conteneur
*one-shot* qui applique le schéma Prisma à la base SQLite du volume
`orbit_db` (`bunx prisma db push`) avant le démarrage de `web`. Il se relance
à chaque mise à jour pour appliquer les évolutions du schéma — laissez-le tel quel.

Vérification finale :

```bash
# 1. Tous les services Up (web, ai-api, ollama, reminder, caddy, backup)
docker compose -f docker-compose.prod.yml ps

# 2. Santé de l'application — 30-60 s après le up
curl -s https://orbit.exemple.fr/api/health | jq
```

Interprétation de `/api/health` :

| Réponse | HTTP | Signifié |
|---|---|---|
| `"status": "healthy"` | 200 | Tout va bien (DB, IA, rappels joignables) |
| `"status": "degraded"` | **200** | L'app fonctionne, mais un service secondaire est KO (souvent l'IA pas encore chargée les premières minutes) |
| `"status": "unhealthy"` | 503 | **Base SQLite inaccessible** — investigation immédiate (TROUBLESHOOTING §3) |

> 💡 Premier certificat Let's Encrypt : Caddy l'obtient au premier hit sur
> le domaine — ouvrez `https://orbit.exemple.fr` une fois, puis vérifiez
> `docker compose -f docker-compose.prod.yml --env-file .env.production logs caddy`.

Créez ensuite votre compte utilisateur via l'écran de connexion (ou le
compte démo pour tester), configurez les comptes IMAP/SMTP dans Réglages,
installez la PWA sur vos appareils et activez les notifications push.

## 📊 5. Monitoring (optionnel mais recommandé)

Le monitoring se démarre **après** la production (il se rattache au réseau
externe `orbit_network`) :

```bash
docker compose -f docker-compose.monitoring.yml --env-file .env.production up -d
```

- **Grafana** : `https://grafana.orbit.exemple.fr` — connexion
  `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` ; le dashboard
  **orbit-overview** est déjà provisionné.
- **Prometheus** : `https://prometheus.orbit.exemple.fr` — cible l'app
  (`/api/metrics`), cAdvisor et node-exporter.

Alertes, logs Loki, dashboards communautaires : voir **[docs/MONITORING.md](MONITORING.md)**.

## 🔄 6. Mises à jour

### Voie A — CI/CD automatique (GitHub Actions)

`.github/workflows/deploy.yml` build l'image, la publie sur **GHCR**, se
connecte en SSH au serveur, redéploie, vérifie `/api/health` et **annule le
déploiement (rollback auto)** en cas d'échec. La CI (`ci.yml` : lint + tsc +
build avec Bun) valide chaque push avant déploiement.

À créer une seule fois dans **Settings → Secrets and variables → Actions** :

| Type | Nom | Valeur |
|---|---|---|
| Secret | `SSH_PRIVATE_KEY` | clé privée SSH autorisée sur le serveur (dédiée au déploiement) |
| Secret | `SERVER_HOST` | `orbit.exemple.fr` |
| Secret | `SERVER_USER` | utilisateur SSH (ex. `deploy`) |
| Variable | `DOMAIN_NAME` | `orbit.exemple.fr` |

> 💡 Sur le serveur, le déploiement automatique utilise le même
> `/opt/orbit` : il n'y a rien à faire d'autre. `IMAGE_TAG=latest` dans
> `.env.production` suit la dernière image publiée.

### Voie B — manuelle depuis le serveur

```bash
cd /opt/orbit
git fetch origin
./scripts/deploy.sh <sha>        # ex. ./scripts/deploy.sh a1b2c3d
```

`deploy.sh` synchronise le code sur le commit voulu, redéploie la stack,
vérifie la santé et **revient seul à la version précédente** si le health
check échoue. À tout moment : `./scripts/health-check.sh` pour un contrôle
ponctuel.

## ⏪ 7. Rollback (revenir à une version antérieure)

Par ordre de préférence :

```bash
# 1. Rollback scripté — revient à la version N-1 (image gardée en cache)
./scripts/deploy.sh --rollback

# 2. Épingler une version précise : tag d'image GHCR dans .env.production
#    (SHA court d'un déploiement passé), puis :
nano .env.production                 # IMAGE_TAG="a1b2c3d"
docker compose -f docker-compose.prod.yml --env-file .env.production up -d web

# 3. Dernier recours : reconstruire depuis un ancien commit (lent)
git checkout <ancien-commit>
./scripts/deploy.sh                  # rebuild + redéploiement
git checkout main                    # revenir ensuite
```

> ⚠️ Le schéma SQLite évolue avec les versions : les rollbacks ne
> **dégradent** jamais le schéma (`prisma db push` est additif). Le point 3
> est le seul risqué si une migration ancienne ne comprend pas les tables
> récentes — testez la restauration d'une sauvegarde dans ce cas
> (docs/BACKUP.md).

## 🗄️ 8. Où vivent les données

`docker compose -f docker-compose.prod.yml ps` + `docker volume ls`
(préfixe `orbit-prod_` — le projet compose s'appelle `orbit-prod`) :

| Volume Docker | Contenu | Sauvegardé |
|---|---|---|
| `orbit_db` | SQLite `/app/db/custom.db` — **toutes** les données (comptes, événements, tâches, emails, préférences) | ✅ snapshot `.backup` quotidien |
| `orbit_storage` | `/app/storage` — pièces jointes des emails | ✅ archive tar |
| `orbit_backups` | snapshots + archives du conteneur backup | — (c'est la sauvegarde) |
| `ollama_models` | modèles Ollama (~4,9 Go) | non (retéléchargeables) |
| `caddy_data` | certificats ACME | recommandé offsite |
| `caddy_config` | état runtime Caddy | non |

Sauvegardes automatiques + restauration + copie offsite : **[docs/BACKUP.md](BACKUP.md)**.

## 🔒 9. Sécurité — checklist

- [x] **Secrets** générés par `openssl`/`web-push`, uniques, jamais commités
      (`.gitignore` couvre `.env*`), jamais passés en build arg
- [x] **TLS automatique** : Caddy obtient et renouvelle les certificats
      (ACME), redirige HTTP→HTTPS et www→apex
- [x] **Pare-feu UFW** : seuls 22 / 80 / 443 ouverts (+ fail2ban sur SSH)
- [x] **Headers de sécurité** Next.js actifs en production (CSP, nosniff…)
- [x] **Rate limiting applicatif** : routes IA 10/min/user, envois SMTP
      50/h, notify-test 10/min — déjà implémentés dans l'app
- [x] **Conteneurs non-root** (web tourne en uid 1001)
- [x] **Aucune base exposée** : SQLite est un fichier dans le volume `orbit_db`
      — aucun port de base à ouvrir ou à durcir
- [ ] **`METRICS_SECRET`** défini si Prometheus est exposé publiquement
- [ ] **Sauvegardes offsite chiffrées** (rclone crypt vers NAS/S3) — voir
      docs/BACKUP.md §4
- [ ] Mises à jour serveur régulières : `sudo apt update && sudo apt upgrade`

## 🌍 10. Fuseau horaire

`TZ` dans `.env.production` (ex. `Africa/Dakar`, `Europe/Paris`) est passé à
tous les conteneurs : timestamps des logs, planification des sauvegardes et
fuseau par défaut du rendu serveur des dates. Les utilisateurs gardent leur
fuseau individuel dans l'application (Réglages). Liste des valeurs :
`timedatectl list-timezones`.

## ❓ 11. FAQ

**Puis-je déployer sur mon LAN sans domaine public ?**
Oui : dans `docker/caddy/Caddyfile.prod`, remplacez les blocs de vos domaines
par une adresse locale avec `tls internal` (certificats auto-signés Caddy —
accepter l'avertissement navigateur une fois). Pas d'ACME, pas de DNS
nécessaire. Les notifications push **ne fonctionnent pas** sans HTTPS
publiquement valide sur la plupart des navigateurs.

**Je n'ai pas de GPU, l'IA est lente — normal ?**
Oui, llama3.1:8b sur CPU donne ~1-5 tokens/s. Solutions : passer à
`OLLAMA_MODEL=mistral:7b`, réduire la taille des contenus à analyser,
augmenter le swap et patienter (timeout 90 s), ou ajouter un GPU NVIDIA.
Voir TROUBLESHOOTING §4.

**Pourquoi Caddy plutôt que Traefik ?**
Choix assumé : Caddy est déjà la gateway utilisée en développement (docker
compose dev → cohérence des configs), sa configuration est ~10× plus courte
(un fichier Caddyfile lisible), et l'ACME y est natif sans store externe ni
labels Docker. Traefik est un excellent produit — rien ne vous y empêche,
mais il faudra réécrire le routage et la gestion TLS.

**L'app peut-elle tourner sans les services IA ?**
Oui — il suffit de ne démarrer que les services utiles (voir prérequis
« sans IA ») :

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d web caddy reminder backup
```

Les fonctions IA renvoient un message propre d'indisponibilité, tout le
reste (calendrier, tâches, emails, push, offline) est fonctionnel.

**Comment tester les alertes du monitoring ?**
Voir docs/MONITORING.md §5 (ex. arrêter un service quelques minutes).

---

En cas de souci : **[docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md)** —
diagnostic par symptôme avec les commandes exactes.
