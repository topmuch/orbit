#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
# Orbit — script de sauvegarde (exécuté dans le conteneur `backup`)
# ───────────────────────────────────────────────────────────────────────────
# Modes :
#   /backup.sh          (ou /backup.sh loop)  boucle planifiée, mode service
#   /backup.sh now      un backup immédiat puis sortie (mode manuel :
#                       docker compose -f docker-compose.prod.yml exec
#                       backup /backup.sh now)
#
# Ce que fait un passage :
#   1. snapshot SQL COHÉRENT de la base SQLite via l'API ".backup" de
#      sqlite3 — équivalent d'un pg_dump mais pour SQLite : verrouillage
#      propre par sqlite3 lui-même, sûr même si le web écrit pendant la
#      copie. ON NE COPIE JAMAIS LE FICHIER .db À MAINS NUES (base vivante,
#      journal/WAL potentiellement non répercuté).
#      → /backups/daily/orbit-<AAAAMMJJ-HHMMSS>.db.gz
#   2. archive des pièces jointes emails (volume orbit_storage) :
#      tar czf → /backups/daily/attachments-<TS>.tar.gz
#   3. si le jour de la semaine est dimanche → copie en weekly/ ;
#      si le jour du mois est le 1er    → copie en monthly/.
#   4. purge par âge (find -mtime, rétention) :
#        daily/   > 7 jours détruits
#        weekly/  > 4 semaines (28 jours) détruits
#        monthly/ > 6 mois (180 jours) détruits
#
# Volumes (montés par docker-compose.prod.yml, en lecture seule sauf
# /backups) : /data = orbit_db, /storage = orbit_storage, /backups =
# orbit_backups. Fuseau horaire via TZ (tzdata installé dans l'image).
#
# Remarque planification : la boucle dort BACKUP_INTERVAL_SECONDS (24 h par
# défaut) — une légère dérive peut faire « sauter » un dimanche ; la copie
# hebdomadaire est alors faite au premier dimanche réellement échantillonné.
# ═══════════════════════════════════════════════════════════════════════════
set -eu

DB_PATH="${DB_PATH:-/data/custom.db}"
STORAGE_DIR="${STORAGE_DIR:-/storage}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"

DAILY="$BACKUP_DIR/daily"
WEEKLY="$BACKUP_DIR/weekly"
MONTHLY="$BACKUP_DIR/monthly"

# Journal lisible, préfixé comme tous les services Orbit.
log() {
  echo "[orbit:backup] $(date '+%Y-%m-%d %H:%M:%S') $*"
}

# ── Un passage de sauvegarde ───────────────────────────────────────────────
# Retourne 0 si OK, 1 si échec (la boucle n'interrompt JAMAIS le service sur
# une erreur : elle retente au cycle suivant).
run_backup() {
  ts="$(date +%Y%m%d-%H%M%S)"
  dom="$(date +%d)"   # jour du mois (01-31) → déclencheur mensuel
  dow="$(date +%u)"   # jour de la semaine (1=lundi … 7=dimanche) → hebdo

  mkdir -p "$DAILY" "$WEEKLY" "$MONTHLY"

  # La base doit exister (le service web a-t-il démarré ? le volume est-il
  # monté au bon endroit ?).
  if [ ! -f "$DB_PATH" ]; then
    log "ERREUR : base $DB_PATH introuvable — le service web est-il démarré ?"
    return 1
  fi

  # 1) Snapshot SQLite — API .backup de sqlite3 (cohérence garantie).
  db_out="$DAILY/orbit-$ts.db"
  if ! sqlite3 "$DB_PATH" ".backup '$db_out'"; then
    log "ERREUR : échec du snapshot sqlite3 (.backup) sur $DB_PATH"
    rm -f "$db_out"
    return 1
  fi
  # -f : idempotent si deux passages tombent sur la même seconde
  # (backup manuel juste après le cycle planifié, par exemple).
  gzip -9 -f "$db_out"
  log "base sauvegardée → $db_out.gz ($(du -h "$db_out.gz" | cut -f1))"

  # 2) Copies de rétention longues (même archive, dossiers différents).
  if [ "$dow" = "7" ]; then
    cp -p "$db_out.gz" "$WEEKLY/"
    log "copie hebdomadaire (dimanche) → $WEEKLY/orbit-$ts.db.gz"
  fi
  if [ "$dom" = "01" ]; then
    cp -p "$db_out.gz" "$MONTHLY/"
    log "copie mensuelle (1er du mois) → $MONTHLY/orbit-$ts.db.gz"
  fi

  # 3) Pièces jointes emails (tar du contenu de /storage, fichiers cachés
  #    compris via « . »). Archive vide si /storage est vide.
  if [ -d "$STORAGE_DIR" ] && [ -n "$(ls -A "$STORAGE_DIR" 2>/dev/null)" ]; then
    att_out="$DAILY/attachments-$ts.tar.gz"
    if tar czf "$att_out" -C "$STORAGE_DIR" .; then
      log "pièces jointes archivées → $att_out ($(du -h "$att_out" | cut -f1))"
    else
      log "AVERTISSEMENT : échec de l'archive des pièces jointes (suite du cycle)"
      rm -f "$att_out"
    fi
  else
    log "aucune pièce jointe à archiver (/storage vide ou absent)"
  fi

  # 4) Purge par ancienneté (rétention 7 j / 28 j / 180 j).
  n_daily="$(find "$DAILY" -type f -mtime +7 -print -delete | wc -l)"
  n_weekly="$(find "$WEEKLY" -type f -mtime +28 -print -delete | wc -l)"
  n_monthly="$(find "$MONTHLY" -type f -mtime +180 -print -delete | wc -l)"
  log "purge : $n_daily quotidienne(s), $n_weekly hebdomadaire(s), $n_monthly mensuelle(s) supprimée(s)"

  return 0
}

# ── Point d'entrée : now | loop ────────────────────────────────────────────
case "${1:-loop}" in
  now)
    # Mode manuel (docker compose exec / run) : un seul passage, le code de
    # sortie remonte à l'appelant (utile en cron externe ou en diagnostic).
    log "backup manuel demandé"
    run_backup
    log "backup manuel terminé"
    ;;
  loop)
    # Mode service : premier passage immédiat, puis un passage par intervalle.
    log "démarrage du planificateur — intervalle ${INTERVAL}s (TZ=${TZ:-non défini})"
    if ! run_backup; then
      log "AVERTISSEMENT : premier passage échoué — nouvel essai au prochain cycle"
    fi
    while :; do
      sleep "$INTERVAL"
      if ! run_backup; then
        log "AVERTISSEMENT : passage de sauvegarde échoué — nouvel essai au prochain cycle"
      fi
    done
    ;;
  *)
    echo "Usage : $0 [now|loop]   (now = un backup immédiat, loop = service planifié)" >&2
    exit 1
    ;;
esac
