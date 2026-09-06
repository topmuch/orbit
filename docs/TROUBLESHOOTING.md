# Orbit — Dépannage production

> Diagnostic **par symptôme**, avec les commandes réelles. Abréviations :
> `CP` = `docker compose -f docker-compose.prod.yml --env-file .env.production`
> (à taper depuis `/opt/orbit`). Log de référence : §12.

## 📇 Sommaire des symptômes

| § | Symptôme |
|---|---|
| 1 | Le site est inaccessible |
| 2 | Erreur **502 Bad Gateway** |
| 3 | Base SQLite : « disk I/O error » / « database is locked » |
| 4 | IA lente, timeouts, conteneur ollama tué (OOM) |
| 5 | Synchronisation IMAP en échec |
| 6 | Notifications push en échec |
| 7 | Sauvegardes en échec |
| 8 | Restauration partielle / incomplète |
| 9 | Grafana/Prometheus vides |
| 10 | Premier démarrage très lent |
| 11 | ARM vs AMD64 |
| 12 | Logs par service + escalation |

## 1️⃣ Le site est inaccessible

```bash
# DNS : le domaine pointe-t-il vers le serveur ?
dig +short orbit.exemple.fr          # → l'IP publique du serveur

# Caddy écoute-t-il ? Certificat obtenu ?
sudo ss -tlnp | grep -E ':80|:443'   # caddy doit y figurer
$CP logs caddy --tail=50
```

- **`connection refused`** : caddy down → `$CP up -d caddy`, puis logs.
- **Certificat non délivré** : chercher `acme` dans les logs caddy. Causes
  classiques : DNS pas propagé, port 80 fermé (UFW), **rate limit Let's
  Encrypt** (trop de demandes répétées). En cas de rate limit : patientez
  1 h, corrigez la cause racine, et pour tester utilisez le **staging ACME**
  (`acme_ca` vers l'URL staging de Let's Encrypt dans le Caddyfile —
  remettre l'URL réelle ensuite).
- **HTTP mais pas HTTPS** : vérifier le port 443 ouvert dans UFW (`sudo ufw status`).

## 2️⃣ Erreur 502 Bad Gateway

Caddy répond mais le conteneur `web` est down ou démarre encore.

```bash
$CP ps                     # web doit être "Up" (sinon : Restarting/Exited ?)
$CP logs web --tail=80     # erreurs au boot (env manquant, DB absente)
curl -s http://localhost:3000/api/health 2>/dev/null | jq   # depuis l'hôte si port ouvert
$CP exec web wget -qO- http://localhost:3000/api/health     # depuis le conteneur
```

- **Env** : `.env.production` complet ? (`AUTH_SECRET`, `DATABASE_URL`,
  `VAPID_*`… cf `.env.production.example`).
- **Base absente au premier boot** : vérifier que `web-migrate` s'est exécuté
  (Exited 0) avant web.
- Si web plante en boucle : `$CP up -d web --force-recreate` ; en dernier
  recours rollback (DEPLOYMENT.md §7).

## 3️⃣ SQLite : « database is disk I/O error » / « database is locked »

```bash
# 1) Espace disque — cause n°1
df -h /var/lib/docker

# 2) Le volume existe et contient la base
docker volume inspect orbit-prod_orbit_db
sudo ls -la /var/lib/docker/volumes/orbit-prod_orbit_db/_data

# 3) Permissions : le conteneur web tourne NON-ROOT (uid 1001)
#    le répertoire /app/db doit lui appartenir
sudo stat -c '%u:%g %n' /var/lib/docker/volumes/orbit-prod_orbit_db/_data
# → si root:root : sudo chown -R 1001:1001 /var/lib/docker/volumes/orbit-prod_orbit_db/_data
#    (idempotent, sans risque pour un volume SQLite)

# 4) Base verrouillée par un process orphelin ?
$CP stop web reminder && $CP up -d    # redémarrage propre des écrivains
```

> ⚠️ `disk I/O error` après un `df` plein = possible base corrompue :
> NE PAS écrire dessus. Restaurer le dernier snapshot sain
> (docs/BACKUP.md §3). Vérification : `./scripts/backup.sh --verify`.

## 4️⃣ IA lente, timeouts, ollama tué (OOM)

```bash
$CP logs ollama --tail=50           # « killed » / oom ? erreurs CUDA ?
$CP logs ai-api --tail=50           # 502 « modèle téléchargé ? » → pull
docker stats --no-stream            # RAM réellement consommée par ollama
free -h                             # RAM/swap de l'hôte
$CP exec ollama ollama list         # le modèle est-il présent ?
```

Par ordre de coût (croissant) :

1. **Réduire le contexte** : analyser des emails plus courts, synthèses plus
   petites (bornes déjà appliquées côté API) ;
2. **Modèle plus léger** : `OLLAMA_MODEL=mistral:7b` dans `.env.production`
   puis `$CP up -d ollama ai-api` (~4,1 Go, nettement plus rapide sur CPU) ;
3. **Swap** : ajouter 8 Go de swap sur l'hôte pour absorber les pics de
   llama3.1:8b :
   ```bash
   sudo fallocate -l 8G /swapfile && sudo chmod 600 /swapfile
   sudo mkswap /swapfile && sudo swapon /swapfile
   echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
   ```
4. **GPU NVIDIA** : l'ajouter au service ollama du compose prod (section
   `deploy.resources` — exemple commenté dans le `docker-compose.yml` de
   dev) puis redémarrer (accélération ~10×).

Timeouts applicatifs : `OLLAMA_TIMEOUT_MS` (90 s par défaut) et
`AI_SERVICE_TIMEOUT_MS` (120 s) — ne les montez qu'en dernier recours.

## 5️⃣ Synchronisation IMAP en échec

Les messages d'erreur de l'app sont **déjà actionnables en FR** — cherchez-les :

```bash
$CP logs reminder --tail=100 | grep -i email     # cycles email-sync
$CP logs web --tail=200 | grep -i -E "imap|sync"
```

Causes classiques :

- **Mot de passe** : Gmail/Outlook… exigent un **mot de passe d'application**
  (2FA activée) — le mot de passe du compte est refusé ;
- **Certificat du serveur IMAP auto-signé** (serveur privé) : cocher
  « Certificat auto-signé » (`allowSelfSigned`) dans le dialog compte — ou
  corriger le certificat côté serveur mail ;
- **Hôte/port/STARTTLS** : vérifier avec « Tester la connexion »
  (Réglages → comptes emails) avant d'enregistrer ;
- **Rate limit / quota** côté fournisseur : espacer les syncs (intervalle du
  compte) ;
- Test direct du port depuis le serveur : `nc -vz imap.gmail.com 993`.

## 6️⃣ Notifications push en échec

```bash
$CP logs web --tail=100 | grep -i -E "push|web-push|40[34]"
$CP logs reminder --tail=50          # « reminders » : failed>0 ?
```

- **Clés VAPID régénérées** (le piège n°1) : tout abonnement enregistré avec
  l'ancienne paire devient **invalide** (erreurs 403/404 côté service push,
  purgées automatiquement). Les utilisateurs doivent **se réabonner** :
  Réglages → Notifications → réactiver (la purge nettoie les morts en
  arrière-plan). Ne régénérez les clés qu'en dernier recours.
- **Endpoint push unreachable** (navigateur/OS) : transitoire — la purge
  404/410 fait le ménage, rien à faire.
- **Rappels absents** : vérifier reminder (`/health` du service dans les
  logs) et que `REMINDER_SERVICE_SECRET` est identique dans l'env de web et
  de reminder (sinon 401 silencieux dans les logs web).

## 7️⃣ Sauvegardes en échec

```bash
$CP logs backup --tail=100
./scripts/backup.sh --list           # quoi, quand, quelles tailles ?
./scripts/backup.sh --verify         # intégrité du dernier snapshot
df -h /var/lib/docker                # place pour écrire ?
```

- **Aucune sauvegarde depuis > 24 h** : d'abord l'espace disque, puis les
  logs backup ; déclencher `./scripts/backup.sh` pour voir l'erreur en direct.
- **Snapshot HS** (`--verify` KO) : vérifier l'espace, relancer ; si la base
  elle-même est en cause → §3.

## 8️⃣ Restauration partielle / incomplète

```bash
# État actuel des volumes
docker volume ls | grep orbit-prod
$CP ps                               # web/reminder doivent être STOPPÉS
./scripts/backup.sh --list           # l'archive attendue existe-t-elle ?
```

- **Base restaurée mais pas les pièces jointes** : elles se restaurent
  séparément (2e argument de `restore.sh`, volume `orbit_storage`) —
  docs/BACKUP.md §3 ;
- **Données « trop récentes » après restauration** : un écrivain tournait
  pendant l'opération (web ou reminder) → refaire proprement avec `--force`
  ou en stoppant les écrivains ;
- **.bak conservé** par `restore.sh` : l'état d'avant-restauration reste
  récupérable — ne le supprimez qu'après validation complète.

## 9️⃣ Grafana / Prometheus vides

```bash
docker compose -f docker-compose.monitoring.yml --env-file .env.production ps
# → https://prometheus.orbit.exemple.fr → Status → Targets : tout doit être UP
docker compose -f docker-compose.monitoring.yml --env-file .env.production logs prometheus --tail=50
```

- **« network orbit_network … not found »** au démarrage : la prod n'était
  pas up — démarrer la prod, puis le monitoring ;
- **Cible web DOWN** : si `METRICS_SECRET` est défini, vérifier qu'il est
  identique dans `.env.production` et connu de Prometheus (config
  `monitoring/prometheus.yml`) ;
- **Dashboard sans graphes** : datasource mal mappée à l'import → vérifier
  dans Grafana (Connections → Data sources) que Prometheus/Loki pointent
  sur les bons services ;
- **Aucun log dans Loki** : `… logs promtail --tail=50` (vérifier l'accès
  au socket Docker — monté automatiquement par le compose) ;

## 🔟 Premier démarrage très lent

C'est presque toujours le **téléchargement du modèle Ollama (~4,9 Go)**,
lancé automatiquement au premier `up -d ollama` :

```bash
$CP logs ollama -f                   # suivre la progression du pull
$CP ps                               # ollama « health: starting » = normal
```

Le healthcheck d'ollama prévoit une marge longue (`start_period`), et
`ai-api` attend le modèle : **patienter**, c'est prévu. Accélérer :
`$CP exec ollama ollama pull llama3.1:8b` relance/affiche le même
téléchargement. Après ce premier pull, tout est dans le volume
`ollama_models` et les démarrages sont rapides.

## 1️⃣1️⃣ ARM vs AMD64

- Les images d'Orbit sont construites pour **linux/amd64** ; sur un serveur
  ARM (Raspberry Pi 5, VPS Graviton…), Docker les exécute via **QEMU** :
  l'app fonctionne mais **nettement plus lentement**, et surtout
  **Ollama/QEMU est inadapté** (pas de GPU, inférence très lente) ;
- Vérifier : `uname -m` (`x86_64` = AMD64 ; `aarch64` = ARM) ;
- Sur ARM : privilégier les images natives quand elles existent, réduire
  `OLLAMA_MODEL` à `mistral:7b` (voire désactiver l'IA), et surveiller
  l'alerte `HostMemoryHigh`.

## 1️⃣2️⃣ Logs par service — table de référence

| Pour voir… | Commande |
|---|---|
| Application (API, IMAP/SMTP, push) | `$CP logs web -f` |
| Cycle des rappels + sync emails | `$CP logs reminder -f` |
| Inférence IA / Ollama | `$CP logs ai-api -f` · `$CP logs ollama -f` |
| TLS, reverse proxy, ACME | `$CP logs caddy -f` |
| Sauvegardes | `$CP logs backup -f` |
| Migrations Prisma (one-shot) | `$CP logs web-migrate` |
| Stack monitoring | `docker compose -f docker-compose.monitoring.yml --env-file .env.production logs <service> -f` |
| Logs centralisés (tous) | Grafana → Explore → Loki (docs/MONITORING.md §6) |

Autres réflexes : `$CP ps` · `docker stats` · `curl -s
https://orbit.exemple.fr/api/health | jq` · `./scripts/health-check.sh`.

## 🆘 Escalation

Rien ne marche après ce guide :

1. Rassembler : sortie de `$CP ps`, `docker stats`, `/api/health` (JSON
   complet), logs du service en cause (`-f` quelques minutes), version
   déployée (`git log -1`, `IMAGE_TAG`) ;
2. Ouvrir une **issue GitHub** sur le dépôt du projet avec ces éléments
   (jamais vos `.env`, mots de passe ou tokens — masquez tout) ;
3. Incident données (base corrompue/disparue) : **arrêter toute écriture**
   (stop web+reminder), faire une image du volume, puis restaurer la
   dernière sauvegarde vérifiée (docs/BACKUP.md §3).

---

Guides liés : [DEPLOYMENT](DEPLOYMENT.md) · [BACKUP](BACKUP.md) ·
[MONITORING](MONITORING.md) · [AI](ai-guide.md) · [Push](push-guide.md).
