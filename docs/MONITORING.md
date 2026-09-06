# Orbit — Monitoring (Prometheus · Grafana · Loki)

> Stack complète de supervision déployée par `docker-compose.monitoring.yml` :
> métriques (Prometheus + cAdvisor + node-exporter), dashboards (Grafana),
> logs centralisés (Loki + promtail) et alertes — le tout **local**,
> servi en HTTPS par Caddy sur des sous-domaines dédiés.

## 🏗️ 1. Architecture de la stack

```
                        ┌─────────────── Grafana ───────────────┐
                        │  dashboards · alerting · Explore      │
                        └──────┬──────────────────────┬─────────┘
                               │ reads                │ queries
                    ┌──────────▼─────────┐   ┌────────▼─────────┐
                    │     Prometheus     │   │       Loki       │
                    │ (règles d'alertes) │   │  (stocks les logs)│
                    └──┬─────┬─────┬─────┘   └────────▲─────────┘
          scrapes       │     │     │                  │ collecte
   ┌────────────────────┘     │     └───────────┐      │
   │                          │                 │      │
┌──▼─────────┐  ┌─────────────▼──┐  ┌───────────▼──┐  ┌┴───────────────┐
│ orbit web  │  │    cadvisor    │  │ node-exporter│  │    promtail    │
│/api/metrics│  │ conteneurs CPU │  │ hôte CPU/RAM │  │ logs de TOUS   │
│  /api/     │  │ RAM/réseau/IO  │  │ disque, load │  │ les conteneurs │
│  health    │  └────────────────┘  └──────────────┘  └────────────────┘
└────────────┘      (réseau externe orbit_network, joint à la prod)
```

- **prometheus** scrape 3 cibles : l'app web (`/api/metrics`), cAdvisor
  (chaque conteneur) et node-exporter (la machine hôte). Il évalue aussi les
  règles d'alertes (`monitoring/alerts.yml`, provisionnées automatiquement).
- **grafana** lit Prometheus et Loki ; le dashboard `orbit-overview` et la
  datasource sont provisionnés au démarrage.
- **promtail** collecte les logs de tous les conteneurs Docker et les pousse
  dans Loki avec le label `container`.

## 🚀 2. Démarrage

> ⚠️ **Toujours APRÈS la stack de production** : la stack monitoring joint
> le réseau externe `orbit_network` créé par `docker-compose.prod.yml`.
> Démarrer avant → « network orbit_network declared as external, but could
> not be found » (corrigeable en démarrant la prod puis en relançant).

```bash
# 1) La production doit être up (voir docs/DEPLOYMENT.md §4)
docker compose -f docker-compose.prod.yml --env-file .env.production ps

# 2) Démarrer le monitoring
docker compose -f docker-compose.monitoring.yml --env-file .env.production up -d
docker compose -f docker-compose.monitoring.yml --env-file .env.production ps

# 3) Vérifier que les cibles Prometheus sont toutes UP
#    → ouvrir https://prometheus.orbit.exemple.fr → menu Status → Targets
```

## 🔗 3. Accès

| Service | URL | Authentification |
|---|---|---|
| Grafana | `https://grafana.orbit.exemple.fr` | `GRAFANA_ADMIN_USER` / `GRAFANA_ADMIN_PASSWORD` (`.env.production`) |
| Prometheus | `https://prometheus.orbit.exemple.fr` | — (protégé par le pare-feu/réseau ; pas de secrets) |

> 💡 Changez le mot de passe Grafana au premier usage (Grafana peut le
> demander) et gardez `GRAFANA_ADMIN_PASSWORD` synchronisé dans
> `.env.production`.

## 📈 4. Dashboard `orbit-overview`

Ouverture : Grafana → Dashboards → **orbit-overview** (provisionné, aucune
configuration à faire). Contenu type :

| Zone | Ce que vous y lisez |
|---|---|
| **Santé des services Orbit** | web / ai-api / reminder / ollama : up ou down (vert/rouge) |
| **Latence & disponibilité** | temps de réponse de `/api/health`, taux de réussite |
| **Ressources conteneurs** (cAdvisor) | CPU, RAM, réseau par conteneur — repérer un ollama affamé |
| **Ressources hôte** (node-exporter) | CPU, RAM, disque, load de la machine |
| **Uptime** | durée depuis le dernier démarrage de la stack |

Fourchette utile : le dashboard couvre l'essentiel de la santé Orbit et de
l'hôte ; pour l'analyse fine, importez les dashboards communautaires (§8).

## 🚨 5. Alertes

Définies dans `monitoring/alerts.yml` (FR) et évaluées par Prometheus ;
visibles dans Grafana (Alerting) et `https://prometheus.orbit.exemple.fr/alerts`.

| Alerte | Condition | Gravité | Action |
|---|---|---|---|
| **OrbitAppDown** | le service web ne répond plus depuis ≥ 1 min | 🔴 critique | `docker compose … ps` + logs web → TROUBLESHOOTING §2, rollback si besoin |
| **OrbitDatabaseDown** | `/api/health` signale la base KO (`unhealthy`) | 🔴 critique | TROUBLESHOOTING §3 (volume, disque, uid 1001) — données à sauvegarder avant tout |
| **OrbitAIServiceDown** | ai-api/ollama injoignable | 🟠 warning | L'app fonctionne en mode dégradé ; TROUBLESHOOTING §4 (RAM, modèle) |
| **OrbitReminderDown** | reminder-service :3032 muet | 🟠 warning | Rappels et sync IMAP suspendus ; `logs reminder` |
| **InstanceDown** | une cible Prometheus (exporter) est down | 🟠 warning | Vérifier le conteneur concerné (souvent monitoring lui-même) |
| **HostDiskAlmostFull** | disque de l'hôte ~ saturé | 🟠 warning | `df -h` ; nettoyer vieux snapshots (BACKUP.md), images Docker (`docker image prune`) |
| **HostMemoryHigh** | RAM de l'hôte sous pression prolongée | 🟠 warning | Souvent Ollama — TROUBLESHOOTING §4 (swap, mistral:7b) |

> 💡 Test des alertes (sans rien casser) : `docker compose -f
> docker-compose.prod.yml --env-file .env.production stop reminder` quelques
> minutes → OrbitReminderDown se déclenche, puis `up -d reminder`.

## 📝 6. Logs (Grafana + Loki)

Tous les logs des conteneurs sont centralisés par promtail dans Loki :

1. Grafana → menu **Explore** → datasource **Loki** ;
2. requête sur le label `container`, ex. :
   - `{container="web"}` — l'application (erreurs API, IMAP/SMTP…) ;
   - `{container="reminder"}` — cycles de scan et sync emails ;
   - `{container="ollama"}` / `{container="caddy"}` / `{container="backup"}` ;
3. affiner avec des filtres de texte, ex. `{container="web"} |= "error"`.

> 💡 Loki remplace avantageusement `docker compose logs` pour chercher dans
> l'historique ; les logs récents restent consultables en direct via
> `docker compose -f docker-compose.prod.yml --env-file .env.production logs <service>`.

## 🩺 7. Endpoints de santé de l'application

### `GET /api/health` — diagnostic applicatif complet

```bash
curl -s https://orbit.exemple.fr/api/health | jq
```

JSON détaillé : statut global + sous-systèmes (base SQLite, service IA,
service de rappels, comptes IMAP…), avec code HTTP :

- **200 + `healthy`** : tout va bien ;
- **200 + `degraded`** : l'app répond, un service secondaire est KO ;
- **503 + `unhealthy`** : la base est inaccessible — agir immédiatement.

### `GET /api/metrics` — métriques Prometheus

Format texte Prometheus (compteurs HTTP, timings, métriques métier),
scrapé par Prometheus. **Si `METRICS_SECRET` est défini** dans
`.env.production`, l'accès requiert le secret :

```bash
curl -s -H "Authorization: Bearer $METRICS_SECRET" https://orbit.exemple.fr/api/metrics | head
```

Le secret est passé automatiquement par `monitoring/prometheus.yml`.
Sans secret défini, l'endpoint répond librement (à réserver au réseau interne).

## ➕ 8. Dashboards communautaires importables

Deux classiques complètent `orbit-overview` — **import via l'UI Grafana**
(il ne sont pas provisionnés) : Grafana → Dashboards → New → **Import** →
saisir l'ID :

| ID | Dashboard | Apporte |
|---|---|---|
| **1860** | Node Exporter Full | Tout l'hôte en détail : CPU par cœur, RAM, disques, réseau, load |
| **14282** | cAdvisor / Docker | Tous les conteneurs : CPU, RAM, réseau, restarts |

> ⚠️ Vérifiez que la datasource Prometheus (et pour 1860, node-exporter
> comme job) est bien sélectionnée à l'import ; ces dashboards s'appuient
> sur les métriques standard des exporters déjà déployés.

---

Symptômes, diagnostic pas-à-pas : **[docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md) §9**.
Guide général : **[docs/DEPLOYMENT.md](DEPLOYMENT.md)**.
