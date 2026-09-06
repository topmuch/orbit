#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# Orbit — restore.sh : restauration de la base SQLite (+ pièces jointes option)
# ════════════════════════════════════════════════════════════════════════════
# Usage :
#   ./scripts/restore.sh <sauvegarde.db.gz> [pieces-jointes.tar.gz] [--force]
#
#   <sauvegarde.db.gz>      chemin DANS le volume orbit_backups
#                           (ex. : backups/daily/orbit-20240115-120000.db.gz
#                            ou   daily/orbit-20240115-120000.db.gz)
#                           OU chemin d'un fichier présent sur l'hôte
#                           (copié d'abord dans orbit_backups/_import/).
#                           Inventaire : ./scripts/backup.sh --list
#   [pieces-jointes.tar.gz] OPTIONAL : archive .tar.gz du volume orbit_storage
#                           (contenu du volume, ex. attachments/…). Passée en
#                           2e argument, elle remplace le stockage actuel.
#   --force                 bypass la confirmation interactive (restauration
#                           scriptée / cron). Équivalent à « yes ».
#
# Exemples :
#   ./scripts/restore.sh backups/daily/orbit-20240115-120000.db.gz
#   ./scripts/restore.sh daily/orbit-20240115-120000.db.gz \
#                        daily/orbit-20240115-120000.tar.gz
#   ./scripts/restore.sh /tmp/orbit-secours.db.gz --force
#
# Déroulement (tout est vérifié AVANT d'arrêter les services) :
#   0. validation du/des fichiers (existence, gzip, signature SQLite, tar)
#   1. confirmation interactive (« yes ») — bypass par --force
#   2. arrêt des écrivains de la base : web, reminder, web-migrate
#   3. ancienne base préservée : orbit_db:/custom.db.bak-<horodatage>
#      puis décompression → orbit_db:/custom.db, chown 1001:1001 (uid
#      applicatif orbit), intégrité SQLite (best effort)
#   4. pièces jointes éventuelles : ancien stockage archivé dans
#      orbit_backups/_import/storage-avant-restore-<horodatage>.tar.gz, puis
#      extraction + chown -R 1001:1001
#   5. redémarrage : web-migrate (migrations rejouées sur la base restaurée)
#      puis web + reminder ; health-check final avec réessais
#
# Codes retour (exploitables en cron) :
#   0  restauration terminée, application saine
#   1  échec pendant la restauration (stack possiblement arrêtée — suivre
#      l'aide affichée ; l'ancienne base .bak est conservée)
#   2  arguments invalides / confirmation refusée (rien n'a été modifié)
#   3  prérequis manquants (docker, compose/env, volumes)
#   4  restauration effectuée mais health-check final KO
#
# ⚠ RESTAURER = ÉCRASER : les données saisies après la sauvegarde seront
#   perdues. L'ancienne base est toujours conservée en .bak (chemin affiché).
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Configuration locale (ajuster ici en cas d'écart, jamais dans le code) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$ROOT_DIR/docker-compose.prod.yml"
ENV_FILE="$ROOT_DIR/.env.production"
COMPOSE=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")
COMPOSE_PROJECT="orbit-prod"          # projet compose canonique (name: du YAML)
DB_VOLUME_NAME="orbit_db"             # contient custom.db (SQLite)
STORAGE_VOLUME_NAME="orbit_storage"   # pièces jointes (/app/storage)
BACKUP_VOLUME_NAME="orbit_backups"    # fichiers de sauvegarde
APP_UID="1001"                        # uid/gid de l'utilisateur conteneur orbit
HEALTH_WAIT_ATTEMPTS=12               # réessais post-restauration (~2 min)
HEALTH_INTERVAL=10                    # secondes entre les réessais

# ── Sortie lisible (couleurs uniquement si terminal) ────────────────────────
if [ -t 1 ]; then
  C_G=$'\e[32m' C_R=$'\e[31m' C_Y=$'\e[33m' C_B=$'\e[1m' C_N=$'\e[0m'
else
  C_G='' C_R='' C_Y='' C_B='' C_N=''
fi
log_info() { printf '%s[info]%s %s\n'  "$C_B" "$C_N" "$*"; }
log_ok()   { printf '%s[ ok ]%s %s\n'  "$C_G" "$C_N" "$*"; }
log_step() { printf '%s[  %s ]%s %s\n' "$C_B" "$1" "$C_N" "${2:-}" >&2; }
log_warn() { printf '%s[warn]%s %s\n'  "$C_Y" "$C_N" "$*"; }
log_err()  { printf '%s[ERREUR]%s %s\n' "$C_R" "$C_N" "$*" >&2; }

usage() {
  cat <<'USAGE'
Orbit — restore.sh (exploitation serveur)

Usage :
  ./scripts/restore.sh <sauvegarde.db.gz> [pieces-jointes.tar.gz] [--force]

  <sauvegarde.db.gz>       chemin dans le volume orbit_backups
                           (backups/daily/orbit-….db.gz) ou fichier hôte
                           (copié dans orbit_backups/_import/)
  [pieces-jointes.tar.gz]  optionnel : archive du volume orbit_storage
  --force                  bypass de la confirmation (« yes » implicite)

Codes retour :
  0 succès · 1 échec (stack possiblement arrêtée, base .bak conservée) ·
  2 arguments/confirmation refusée (rien modifié) · 3 prérequis manquants ·
  4 restauré mais health-check final KO

⚠ Les données postérieures à la sauvegarde seront perdues ; l'ancienne base
  est conservée en orbit_db:/custom.db.bak-<horodatage> (chemin affiché).
USAGE
}

STACK_STOPPED=0   # 1 une fois web/reminder/web-migrate arrêtés
DB_VOL=""; BK_VOL=""; ST_VOL=""
DB_REL=""         # chemin de la sauvegarde .db.gz DANS orbit_backups
ST_REL=""         # chemin de l'archive .tar.gz DANS orbit_backups (optionnel)
STAMP=""          # horodatage de la restauration

fail() { # fail <code> <message>
  log_err "$2"
  if [ "$STACK_STOPPED" -eq 1 ]; then
    echo "  ⚠ La stack est ARRÊTÉE (web, reminder, web-migrate) — redémarrage :" >&2
    echo "    cd $ROOT_DIR && ${COMPOSE[*]} up -d" >&2
  fi
  exit "$1"
}
fmt_size() { numfmt --to=iec "$1" 2>/dev/null || printf '%s o' "$1"; }

# ── Prérequis ───────────────────────────────────────────────────────────────
require_docker() {
  command -v docker >/dev/null 2>&1 || fail 3 "Docker est introuvable sur ce serveur (PATH)."
}
require_files() {
  [ -f "$COMPOSE_FILE" ] || fail 3 "Fichier introuvable : $COMPOSE_FILE (déploiement 19-a)."
  [ -f "$ENV_FILE" ]     || fail 3 "Fichier introuvable : $ENV_FILE (déploiement 19-a)."
}
resolve_volume() { # nom court → nom réel Docker (name: explicite ou préfixé projet)
  local short="$1" real
  for real in "$short" "${COMPOSE_PROJECT}_${short}"; do
    if docker volume inspect "$real" >/dev/null 2>&1; then
      printf '%s\n' "$real"; return 0
    fi
  done
  log_err "Volume Docker introuvable : $short (essayé « $short » et « ${COMPOSE_PROJECT}_${short} »)."
  return 3
}
tool_image() { # image des conteneurs jetables (image du conteneur backup sinon alpine:3)
  local cid img
  cid="$("${COMPOSE[@]}" ps -aq backup 2>/dev/null | head -n 1 || true)"
  if [ -n "$cid" ]; then
    img="$(docker inspect "$cid" --format '{{.Config.Image}}' 2>/dev/null || true)"
  fi
  printf '%s\n' "${img:-alpine:3}"
}

# Conteneur jetable : sh direct + image outil. --entrypoint sh est
# OBLIGATOIRE : l'image du conteneur backup a ENTRYPOINT /backup.sh (mode
# loop/now) qui avalerait nos commandes. Les montages sont passés en 1er
# argument (chemins contrôlés — validation faite en amont).
# Usage : run_tool "-v vol1:/a -v vol2:/b" <script-sh> [args…] → $1, $2… du sh
run_tool() {
  local mounts="$1"; shift
  docker run --rm --entrypoint sh $mounts "$(tool_image)" -c "$1" orbit "${@:2}"
}
health_url() { # URL de santé par défaut : DOMAIN_NAME du .env.production
  local domain=""
  if [ -f "$ENV_FILE" ]; then
    domain="$(grep -E '^[[:space:]]*DOMAIN_NAME[[:space:]]*=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
    domain="${domain#\"}"; domain="${domain%\"}"
    domain="${domain#\'}"; domain="${domain%\'}"
    domain="$(printf '%s' "$domain" | tr -d '[:space:]')"
  fi
  if [ -n "$domain" ]; then printf 'https://%s/api/health\n' "$domain"
  else printf 'http://localhost/api/health\n'; fi
}

# ── Validation d'un argument « chemin » (sécurité : pas d'injection sh -c) ──
validate_path_arg() { # chemin
  local p="$1"
  case "$p" in
    *..*) fail 2 "Chemin refusé (séquence « .. » interdite) : $p" ;;
  esac
  if ! printf '%s' "$p" | grep -qE '^[A-Za-z0-9._/-]+$'; then
    fail 2 "Chemin refusé (espaces ou caractères spéciaux interdits —
  renommez/déplacez le fichier) : $p"
  fi
}

# ── Localisation : fichier hôte → copie dans le volume, sinon chemin volume ─
to_volume_path() { # argument → chemin relatif DANS orbit_backups (stdout)
  local arg="$1" rel=""
  if [ -f "$arg" ]; then
    local base dir out rc=0
    dir="$(cd "$(dirname "$arg")" && pwd)"; base="$(basename "$arg")"
    validate_path_arg "$dir"; validate_path_arg "$base"
    log_step "i" "Copie du fichier hôte $arg vers orbit_backups/_import/…"
    out="$(run_tool "-v $dir:/src:ro -v $BK_VOL:/backups" '
      set -e
      mkdir -p /backups/_import
      cp "/src/$1" "/backups/_import/$1"
      echo "_import/$1"' "$base" 2>&1)" || rc=$?
    [ "$rc" -eq 0 ] || fail 3 "Copie impossible vers le volume orbit_backups :
$out"
    rel="$(printf '%s' "$out" | tail -n 1)"
  else
    rel="${arg#/}"; rel="${rel#backups/}"; rel="${rel#/}"
  fi
  printf '%s' "$rel"
}

# ── Contrôles préalables d'un fichier du volume (rien n'est modifié) ────────
check_db_in_volume() { # chemin relatif → infos stdout ; exit 2/3 si invalide
  local rel="$1" rc=0 out
  out="$(run_tool "-v $BK_VOL:/backups" '
    set -e
    f="/backups/$1"
    [ -f "$f" ]                || { echo "INTROUVABLE";   exit 31; }
    gzip -t "$f" 2>/dev/null   || { echo "GZIP_CORROMPU"; exit 32; }
    gunzip -c "$f" 2>/dev/null | head -c 16 | grep -q "SQLite format 3" \
                                || { echo "PAS_SQLITE";    exit 33; }
    echo "SIZE=$(stat -c %s "$f")"
    echo "MTIME=$(date -r "$f" "+%d/%m/%Y %H:%M:%S" 2>/dev/null || stat -c %y "$f")"
  ' "$rel" 2>&1)" || rc=$?
  case "$rc" in
    0) printf '%s\n' "$out" ;;
    31) fail 2 "Fichier introuvable dans orbit_backups : $rel
  Inventaire : ./scripts/backup.sh --list" ;;
    32) fail 2 "Sauvegarde gzip corrompue : $rel (gunzip refuse le fichier)" ;;
    33) fail 2 "Le fichier ne contient pas une base SQLite (signature absente) : $rel
  Une sauvegarde .db.gz est attendue (copie binaire compressée)." ;;
    *)  fail 3 "Contrôle impossible du fichier $rel (docker) :
$out" ;;
  esac
}
check_storage_in_volume() { # chemin relatif → infos stdout ; exit 2/3 si invalide
  local rel="$1" rc=0 out
  out="$(run_tool "-v $BK_VOL:/backups" '
    set -e
    f="/backups/$1"
    [ -f "$f" ]              || { echo "INTROUVABLE";   exit 31; }
    gzip -t "$f" 2>/dev/null || { echo "GZIP_CORROMPU"; exit 32; }
    tar -tzf "$f" >/dev/null 2>&1 || { echo "TAR_INVALIDE"; exit 34; }
    echo "SIZE=$(stat -c %s "$f")"
  ' "$rel" 2>&1)" || rc=$?
  case "$rc" in
    0) printf '%s\n' "$out" ;;
    31) fail 2 "Archive introuvable dans orbit_backups : $rel" ;;
    32) fail 2 "Archive gzip corrompue : $rel" ;;
    34) fail 2 "Archive tar invalide : $rel" ;;
    *)  fail 3 "Contrôle impossible de l'archive $rel (docker) :
$out" ;;
  esac
}

# Archive de pièces jointes « correspondante » ? Les sauvegardes partagent le
# même horodatage (ex. orbit-20240115-120000.db.gz ↔
# attachments-20240115-120000.tar.gz) → on cherche le TS du snapshot .db.gz
# parmi les .tar.gz du volume.
suggest_storage_archive() { # horodatage AAAAMMJJ-HHMMSS → chemin trouvé ou vide
  local ts="$1" found
  found="$(run_tool "-v $BK_VOL:/backups" '
    find /backups -type f -name "*.tar.gz" 2>/dev/null | grep -F "$1" | head -n 1
  ' "$ts" 2>/dev/null || true)"
  printf '%s' "$found"
}

# État de la base actuelle (taille + date) pour le récapitulatif
current_db_info() {
  run_tool "-v $DB_VOL:/data" '
    if [ -f /data/custom.db ]; then
      echo "SIZE=$(stat -c %s /data/custom.db)"
      echo "MTIME=$(date -r /data/custom.db "+%d/%m/%Y %H:%M:%S" 2>/dev/null || stat -c %y /data/custom.db)"
    else
      echo "ABSENTE"
    fi
  ' 2>/dev/null || true
}

# ════════════════════════════════════════════════════════════════════════════
# Étapes de restauration
# ════════════════════════════════════════════════════════════════════════════

# Services compose réellement déclarés (robustesse si un nom manque)
existing_services() { # → stdout : services du compose, un par ligne
  "${COMPOSE[@]}" config --services 2>/dev/null || true
}
filter_services() { # args: services attendus → stdout : ceux qui existent
  local svc want
  svc="$(existing_services)"
  [ -n "$svc" ] || return 0
  for want in "$@"; do
    if printf '%s\n' "$svc" | grep -qx "$want"; then
      printf '%s\n' "$want"
    else
      log_warn "Service « $want » absent du docker-compose.prod.yml (ignoré)."
    fi
  done
}

stop_writers() {
  log_step "1" "Arrêt des écrivains de la base (web, reminder, web-migrate)…"
  local rc=0 targets
  targets="$(filter_services web reminder web-migrate)"
  if [ -z "$targets" ]; then
    fail 3 "Aucun des services web/reminder/web-migrate n'est déclaré dans
  $COMPOSE_FILE — composition inattendue (voir 19-a)."
  fi
  "${COMPOSE[@]}" stop $targets || rc=$?
  if [ "$rc" -ne 0 ]; then
    fail 1 "Impossible d'arrêter proprement les services (code $rc) — ABANDON :
  rien n'a été modifié, la base actuelle est intacte.
  État : ${COMPOSE[*]} ps"
  fi
  STACK_STOPPED=1
}

restore_db() { # → stdout : ANCIEN_BASE=… / INTEGRITE=… / TAILLE=…
  log_step "2" "Restauration de la base (l'ancienne est préservée en .bak)…"
  local out rc=0
  out="$(run_tool "-v $DB_VOL:/data -v $BK_VOL:/backups" '
    set -e
    src="$1"; stamp="$2"; uid="$3"
    # Décompression hors volume : l'"'"'ancienne base reste intacte si le
    # contenu se révèle invalide.
    tmp="/tmp/restore-$stamp.db"
    gunzip -c "/backups/$src" > "$tmp" 2>/dev/null || { echo "GUNZIP_KO"; exit 41; }
    head -c 16 "$tmp" | grep -q "SQLite format 3" || { echo "PAS_SQLITE"; rm -f "$tmp"; exit 40; }
    if [ -f /data/custom.db ]; then
      mv /data/custom.db "/data/custom.db.bak-$stamp"
      chown "$uid":"$uid" "/data/custom.db.bak-$stamp" 2>/dev/null || true
      echo "ANCIENNE_BASE=/data/custom.db.bak-$stamp"
    else
      echo "ANCIENNE_BASE=ABSENTE"
    fi
    mv "$tmp" /data/custom.db
    chown "$uid":"$uid" /data/custom.db
    chmod 644 /data/custom.db
    if command -v sqlite3 >/dev/null 2>&1; then
      result="$(sqlite3 /data/custom.db "PRAGMA integrity_check;" 2>&1 || echo erreur)"
      echo "INTEGRITE=$result"
    else
      echo "INTEGRITE=NON_VERIFIEE"
    fi
    echo "TAILLE=$(stat -c %s /data/custom.db)"
  ' "$DB_REL" "$STAMP" "$APP_UID" 2>&1)" || rc=$?
  [ "$rc" -eq 0 ] || fail 1 "Échec de la restauration de la base (code $rc) :
$(printf '%s' "$out" | head -n 5)
  L'ancienne base est conservée dans le volume orbit_db (voir .bak ci-dessus
  si déjà créé) ; la stack est arrêtée — redémarrez après diagnostic."
  printf '%s\n' "$out"
}

restore_storage() { # → stdout : ANCIEN_STORAGE=… / FICHIERS=…
  log_step "3" "Restauration des pièces jointes (ancien stockage archivé d'abord)…"
  local out rc=0
  out="$(run_tool "-v $ST_VOL:/storage -v $BK_VOL:/backups" '
    set -e
    src="$1"; stamp="$2"; uid="$3"
    if [ -n "$(ls -A /storage 2>/dev/null)" ]; then
      mkdir -p /backups/_import
      tar -C /storage -czf "/backups/_import/storage-avant-restore-$stamp.tar.gz" .
      echo "ANCIEN_STORAGE=/backups/_import/storage-avant-restore-$stamp.tar.gz"
    else
      echo "ANCIEN_STORAGE=ABSENT"
    fi
    ( cd /storage && rm -rf ./* ./.[!.]* ./..?* 2>/dev/null ) || true
    tar -C /storage -xzf "/backups/$src"
    chown -R "$uid":"$uid" /storage
    echo "FICHIERS=$(find /storage -type f | wc -l)"
  ' "$ST_REL" "$STAMP" "$APP_UID" 2>&1)" || rc=$?
  [ "$rc" -eq 0 ] || fail 1 "Échec de la restauration des pièces jointes (code $rc) :
$(printf '%s' "$out" | head -n 5)
  L'ancien stockage est archivé dans orbit_backups/_import/ (cf. ci-dessus)."
  printf '%s\n' "$out"
}

restart_stack() {
  log_step "4" "Redémarrage (web-migrate — migrations rejouées, puis web + reminder)…"
  local rc=0 targets
  targets="$(filter_services web-migrate web reminder)"
  if [ -z "$targets" ]; then
    fail 3 "Aucun des services web/reminder/web-migrate n'est déclaré dans
  $COMPOSE_FILE — composition inattendue (voir 19-a)."
  fi
  "${COMPOSE[@]}" up -d $targets || rc=$?
  if [ "$rc" -ne 0 ]; then
    fail 1 "Redémarrage impossible (code $rc) — la base est pourtant restaurée.
  Diagnostic : ${COMPOSE[*]} logs web-migrate"
  fi
  STACK_STOPPED=0
}

wait_http_ok() { # url tentatives intervalle — contrôle de secours
  local url="$1" tries="$2" intv="$3" i code
  for i in $(seq 1 "$tries"); do
    code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$url" 2>/dev/null || true)"
    [ "$code" = "200" ] && return 0
    sleep "$intv"
  done
  return 1
}

final_health() {
  log_step "5" "Health-check final (${HEALTH_WAIT_ATTEMPTS} tentatives espacées de ${HEALTH_INTERVAL} s)…"
  local url rc=0
  url="$(health_url)"
  if [ -x "$SCRIPT_DIR/health-check.sh" ]; then
    "$SCRIPT_DIR/health-check.sh" --wait "$HEALTH_WAIT_ATTEMPTS" || rc=$?
  else
    log_warn "scripts/health-check.sh indisponible — contrôle HTTP simple sur $url"
    wait_http_ok "$url" "$HEALTH_WAIT_ATTEMPTS" "$HEALTH_INTERVAL" || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    fail 4 "La base est restaurée mais l'application ne répond pas sainement.
  Diagnostic :
    ${COMPOSE[*]} ps
    ${COMPOSE[*]} logs --tail 80 web web-migrate"
  fi
}

# ════════════════════════════════════════════════════════════════════════════
# Point d'entrée
# ════════════════════════════════════════════════════════════════════════════
main() {
  local FORCE=0 db_arg="" st_arg=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --help|-h)  usage; exit 0 ;;
      --force|-f) FORCE=1 ;;
      -*)         fail 2 "Option inconnue : $1 (essayez --help)." ;;
      *) if [ -z "$db_arg" ]; then db_arg="$1"
         elif [ -z "$st_arg" ]; then st_arg="$1"
         else fail 2 "Trop d'arguments : $1 (au plus 2 chemins + --force)."
         fi ;;
    esac
    shift
  done
  [ -n "$db_arg" ] || { usage >&2; fail 2 "Chemin de la sauvegarde .db.gz requis."; }
  validate_path_arg "$db_arg"
  [ -z "$st_arg" ] || validate_path_arg "$st_arg"

  require_docker
  require_files
  DB_VOL="$(resolve_volume "$DB_VOLUME_NAME")"
  BK_VOL="$(resolve_volume "$BACKUP_VOLUME_NAME")"
  [ -z "$st_arg" ] || ST_VOL="$(resolve_volume "$STORAGE_VOLUME_NAME")"
  STAMP="$(date +%Y%m%d-%H%M%S)"

  # ── 0. Contrôles préalables (aucun service n'est encore arrêté) ───────────
  log_step "0" "Contrôles préalables (existence, gzip, signature SQLite)…"
  DB_REL="$(to_volume_path "$db_arg")"
  local db_info db_size="?" db_mtime="?" st_info st_size="?" st_found="" db_ts=""
  db_info="$(check_db_in_volume "$DB_REL")"
  db_size="$(printf '%s\n' "$db_info" | sed -n 's/^SIZE=//p' | head -n 1)"
  db_mtime="$(printf '%s\n' "$db_info" | sed -n 's/^MTIME=//p' | head -n 1)"
  if [ -n "$st_arg" ]; then
    ST_REL="$(to_volume_path "$st_arg")"
    st_info="$(check_storage_in_volume "$ST_REL")"
    st_size="$(printf '%s\n' "$st_info" | sed -n 's/^SIZE=//p' | head -n 1)"
  else
    db_ts="$(printf '%s' "$(basename "$DB_REL")" | sed -n 's/.*\([0-9]\{8\}-[0-9]\{6\}\).*/\1/p')"
    st_found="$(suggest_storage_archive "$db_ts")"
  fi

  # ── Récapitulatif + confirmation ──────────────────────────────────────────
  local cur_info cur_size="" cur_mtime=""
  cur_info="$(current_db_info)"
  cur_size="$(printf '%s\n' "$cur_info" | sed -n 's/^SIZE=//p' | head -n 1)"
  cur_mtime="$(printf '%s\n' "$cur_info" | sed -n 's/^MTIME=//p' | head -n 1)"
  printf '%s\n' "──────────────────────────────────────────────────────────────"
  printf '%s\n' " Orbit — restauration de la base (récapitulatif)"
  printf '%s\n' "──────────────────────────────────────────────────────────────"
  printf '  Sauvegarde source  : orbit_backups:/%s\n' "$DB_REL"
  printf '                      %s — %s\n' "$(fmt_size "${db_size:-?}")" "${db_mtime:-date inconnue}"
  if [ -n "$ST_REL" ]; then
    printf '  Pièces jointes     : orbit_backups:/%s (%s)\n' "$ST_REL" "$(fmt_size "${st_size:-?}")"
  elif [ -n "$st_found" ]; then
    printf '  Pièces jointes     : non restaurées — archive correspondante trouvée :\n'
    printf '                      orbit_backups:%s (passez-la en 2e argument)\n' "$st_found"
  else
    printf '  Pièces jointes     : non restaurées (aucune archive fournie)\n'
  fi
  if printf '%s\n' "$cur_info" | grep -q '^ABSENTE$'; then
    printf '  Base actuelle      : absente (première restauration ?)\n'
  else
    printf '  Base actuelle      : orbit_db:/custom.db — %s — %s\n' \
      "$(fmt_size "${cur_size:-?}")" "${cur_mtime:-date inconnue}"
  fi
  printf '  Ancienne base →    : orbit_db:/custom.db.bak-%s (conservée)\n' "$STAMP"
  printf '%s\n' "──────────────────────────────────────────────────────────────"
  printf '%s⚠ RESTAURER = ÉCRASER : les données postérieures au %s seront PERDUES.%s\n' \
    "$C_Y" "${db_mtime:-moment de la sauvegarde}" "$C_N"
  printf '%s\n' "──────────────────────────────────────────────────────────────"

  if [ "$FORCE" -ne 1 ]; then
    if [ ! -t 0 ]; then
      fail 2 "Confirmation impossible : stdin n'est pas un terminal.
  Pour une restauration scriptée (cron), ajoutez --force."
    fi
    local reply=""
    printf 'Restaurer ? Tapez « yes » pour confirmer : '
    IFS= read -r reply || true
    [ "$reply" = "yes" ] || fail 2 "Confirmation refusée — abandon : rien n'a été modifié."
  else
    log_info "Mode --force : confirmation interactive contournée."
  fi

  # ── 1→5. Exécution ────────────────────────────────────────────────────────
  stop_writers
  local db_result old_base integ st_result old_storage
  db_result="$(restore_db)"
  old_base="$(printf '%s\n' "$db_result" | sed -n 's/^ANCIENNE_BASE=//p' | head -n 1)"
  integ="$(printf '%s\n' "$db_result" | sed -n 's/^INTEGRITE=//p' | head -n 1)"
  case "$integ" in
    ok)             log_ok   "Intégrité de la base restaurée : integrity_check = ok" ;;
    NON_VERIFIEE)   log_warn "Intégrité non vérifiable (sqlite3 absent de l'image jetable)" ;;
    *)              log_warn "integrity_check a signalé : $integ — surveillez l'application." ;;
  esac
  st_result=""
  [ -z "$ST_REL" ] || st_result="$(restore_storage)"
  old_storage="$(printf '%s\n' "$st_result" | sed -n 's/^ANCIEN_STORAGE=//p' | head -n 1)"
  restart_stack
  final_health

  # ── Résumé final ──────────────────────────────────────────────────────────
  printf '\n'
  log_ok "Restauration terminée : orbit_backups:/$DB_REL → orbit_db:/custom.db."
  if [ "$old_base" != "ABSENTE" ] && [ -n "$old_base" ]; then
    log_info "Ancienne base conservée : orbit_db:$old_base"
    log_info "Annuler cette restauration :"
    printf '  docker run --rm -v %s:/data alpine:3 sh -c %s\n' "$DB_VOL" \
      "'mv /data/custom.db /data/custom.db.annulee-$STAMP; mv $old_base /data/custom.db; chown $APP_UID:$APP_UID /data/custom.db'"
  fi
  [ -z "$old_storage" ] || [ "$old_storage" = "ABSENT" ] || \
    log_info "Ancien stockage de pièces jointes archivé : orbit_backups:$old_storage"
  log_warn "Toute donnée saisie après le ${db_mtime:-moment de la sauvegarde} est perdue."
  log_info "Prochain contrôle qualité : ./scripts/backup.sh --verify"
}

main "$@"
