# Orbit — Sauvegardes & restauration

> Les données d'Orbit (SQLite + pièces jointes) sont sauvegardées
> **automatiquement** par le conteneur `backup`, dans le volume
> `orbit_backups`, avec une méthode **sûre pour une base vivante**.
> Ce guide décrit le fonctionnement, les manipulations manuelles et la
> restauration — à lire AU MOINS UNE FOIS avant d'en avoir besoin.

## 💡 1. Fonctionnement

```
conteneur backup (alpine + sqlite, planification interne)
   │  toutes les BACKUP_INTERVAL_SECONDS (24 h par défaut)
   ├─► snapshot SQLite via l'API .backup   ← méthode OFFICIELLE SQLite,
   │   (copie cohérente, base OUVERTE)        jamais une copie brute de fichier
   └─► tar des pièces jointes (volume orbit_storage)
   │
   └─► rotation : 7 quotidiennes · 4 hebdomadaires · 6 mensuelles
        (les plus anciennes sont purgées automatiquement)
```

- **Snapshot `.backup`** : l'outil `sqlite3` est utilisé avec la commande
  `.backup` (Online Backup API) — la copie est transactionnellement
  cohérente **pendant que l'application tourne et écrit**, contrairement à
  un `cp` qui peut capturer un état à moitié écrit.
- **Pièces jointes** : archivées en `tar` séparé (elles sont des fichiers
  immuables, une copie simple suffit).
- **Rétention** : 7 snapshots quotidiens, 4 hebdomadaires, 6 mensuels —
  environ 17 points de restauration glissants, sans intervention.
- Tout vit dans le volume Docker `orbit_backups` (`orbit-prod_orbit_backups`).

## 🖐️ 2. Sauvegardes manuelles

Les scripts s'exécutent depuis la racine du projet (`/opt/orbit`) :

```bash
# Déclencher une sauvegarde immédiate (utile avant une manipulation risquée)
./scripts/backup.sh

# Lister les sauvegardes présentes (dates, tailles, type journalier/hebdo/mensuel)
./scripts/backup.sh --list

# Vérifier l'intégrité du dernier snapshot (PRAGMA integrity_check)
./scripts/backup.sh --verify
```

> 💡 Réflexe avant mise à jour majeure ou restauration :
> `./scripts/backup.sh && ./scripts/backup.sh --verify`.

Les logs du conteneur : `docker compose -f docker-compose.prod.yml
--env-file .env.production logs backup`.

## ♻️ 3. Restauration — PAS À PAS

> ⚠️ **Jamais une restauration sur une stack démarrée** : les écrivains
> (`web` et `reminder`) tiennent la base ouverte — restaurer pendant qu'ils
> tournent revient à écraser un fichier sous les pieds de ses lecteurs.
> Utilisez `--force` (redémarre lui-même) ou suivez le pas-à-pas ci-dessous.

```bash
cd /opt/orbit

# 0) (Refaire si besoin une sauvegarde fraîche de l'état actuel)
./scripts/backup.sh

# 1) Arrêter TOUS les écrivains (web écrit en continu, reminder via /api/notify)
docker compose -f docker-compose.prod.yml --env-file .env.production stop web reminder

# 2) Restaurer la base — le script liste les sauvegardes et vous guide :
./scripts/restore.sh
#    (un .bak de la base actuelle est conservé avant écrasement — filet de
#     sécurité si la restauration elle-même était une erreur)

# 3) Pièces jointes (volume orbit_storage) — en 2e argument du même script :
./scripts/restore.sh <snapshot> <archive-pieces-jointes>
#    ou uniquement les pièces jointes selon ce que propose le script

# 4) Redémarrer et vérifier
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
curl -s https://orbit.exemple.fr/api/health | jq    # → "healthy"
```

Variante express (le script gère l'arrêt/redémarrage lui-même) :

```bash
./scripts/restore.sh --force
```

> ⚠️ **Test de restauration OBLIGATOIRE (recommandé)** : au moins une fois,
> restaurez une sauvegarde sur un environnement séparé (autre serveur,
> autre dossier compose avec `name` différent) et connectez-vous. Une
> sauvegarde jamais restaurée n'est pas une sauvegarde, c'est un espoir.

## 📦 4. Copie offsite (rclone / rsync)

Les sauvegardes restent sur le même disque que la base — un incident
matériel les emporterait. Poussez le volume `orbit_backups` ailleurs :

```bash
# ── rclone vers un stockage distant (S3, Backblaze, NAS…) ────────────────
rclone config                       # configurer le remote "distant"
rclone sync /var/lib/docker/volumes/orbit-prod_orbit_backups/_data \
          distant:orbit-backups --transfers 4

# ── variante chiffrée de bout en bout (recommandé — données personnelles) ─
rclone config                       # remote de type "crypt" au-dessus du premier
rclone sync /var/lib/docker/volumes/orbit-prod_orbit_backups/_data \
          orbit-crypt:backups

# ── ou simple rsync vers un NAS ──────────────────────────────────────────
rsync -a --delete /var/lib/docker/volumes/orbit-prod_orbit_backups/_data/ \
      sauvegarde@nas.local::orbit/
```

Automatisation par cron sur l'hôte (ex. `/etc/cron.d/orbit-backup`) :

```cron
# Copie offsite chaque nuit à 03h30, journal dans syslog
30 3 * * * root rclone sync /var/lib/docker/volumes/orbit-prod_orbit_backups/_data orbit-crypt:backups --syslog
```

## ⚠️ 5. Pièges classiques

| Piège | Conséquence | Règle d'or |
|---|---|---|
| Copier/coller le fichier `custom.db` à chaud (hors `.backup`) | Base corrompue/illisible — WAL non synchronisé, écriture partielle | **Toujours** passer par le snapshot `.backup` (le conteneur/les scripts le font) |
| Restaurer pendant que `web`/`reminder` tournent | Écrasement concurrent, erreurs `database is locked` | Stopper les écrivains d'abord (ou `--force`) |
| Disque plein (`df -h`) | Sauvegardes silencieusement en échec, base figée | Surveiller l'alerte `HostDiskAlmostFull` (monitoring) ; nettoyer les vieux snapshots |
| Sauvegarde uniquement de la base | Pièces jointes perdues | Elles sont dans `orbit_storage` — le conteneur backup les inclut |
| Confiance aveugle | Découverte trop tard d'une sauvegarde HS | `--verify` après chaque sauvegarde manuelle, test de restauration périodique |

Où trouver les fichiers : tout est dans le volume
`orbit-prod_orbit_backups` (`docker volume inspect orbit-prod_orbit_backups`
pour le chemin exact sur l'hôte).

---

Problème de sauvegarde/restauration : **[docs/TROUBLESHOOTING.md](TROUBLESHOOTING.md) §7-8**.
Guide général : **[docs/DEPLOYMENT.md](DEPLOYMENT.md)**.
