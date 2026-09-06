#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# Orbit — backup.sh : sauvegarde manuelle / inventaire / vérification (hôte)
# ════════════════════════════════════════════════════════════════════════════
# Usage :
#   ./scripts/backup.sh               Sauvegarde immédiate (« now ») via le
#                                     conteneur backup (daily/ weekly/ monthly/
#                                     + rétention 7 j / 4 sem / 6 mois)
#   ./scripts/backup.sh --list        Inventaire du volume orbit_backups
#                                     (ls -lhR — conteneur alpine jetable,
#                                     fonctionne même stack arrêtée)
#   ./scripts/backup.sh --verify      Vérifie la dernière sauvegarde .db.gz :
#                                     non vide + gzip intègre + PRAGMA
#                                     integrity_check SQLite (détecte
#                                     automatiquement copie binaire ou dump SQL)
#   ./scripts/backup.sh --help        Cette aide
#
# Exemples :
#   ./scripts/backup.sh                       # backup manuel immédiat
#   ./scripts/backup.sh --verify              # contrôle post-cron
#   ./scripts/backup.sh --list | tail -n 40   # dernières sauvegardes
#
# Prérequis (serveur hôte Ubuntu 22.04+, dépôt /opt/orbit) :
#   - Docker + compose v2 ; docker-compose.prod.yml + .env.production présents ;
#   - modes par défaut / --verify : la stack doit tourner (docker compose ps),
#     conteneur « backup » inclus ;
#   - --list : seul le volume orbit_backups est requis (stack arrêtée acceptée).
#
# Détails techniques :
#   - La sauvegarde réelle est faite par /backup.sh DANS le conteneur backup ;
#     ce script ne fait que l'orchestrer et contrôler le résultat.
#   - Le point de montage du volume orbit_backups dans le conteneur backup est
#     auto-détecté (docker inspect) ; fallback : BACKUP_MOUNT_FALLBACK ci-dessous.
#   - Les conteneurs jetables utilisent l'image du conteneur backup (sqlite3
#     inclus) quand elle est détectable, sinon alpine:3.
#
# Codes retour (exploitables en cron) :
#   0  succès (backup créé / liste affichée / sauvegarde vérifiée saine)
#   2  arguments invalides
#   3  prérequis manquants (docker absent, compose/env introuvables, stack
#      arrêtée, conteneur backup indisponible, volume introuvable)
#   4  échec de la sauvegarde OU sauvegarde corrompue (--verify)
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Configuration locale (ajuster ici en cas d'écart, jamais dans le code) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$ROOT_DIR/docker-compose.prod.yml"
ENV_FILE="$ROOT_DIR/.env.production"
COMPOSE=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")
COMPOSE_PROJECT="orbit-prod"          # projet compose canonique (name: du YAML)
BACKUP_VOLUME_NAME="orbit_backups"    # volume des fichiers de sauvegarde
BACKUP_MOUNT_FALLBACK="/backups"      # montage du volume dans le conteneur backup
BK_VOL=""                             # nom Docker réel du volume (résolu)

# ── Sortie lisible (couleurs uniquement si terminal) ────────────────────────
if [ -t 1 ]; then
  C_G=$'\e[32m' C_R=$'\e[31m' C_Y=$'\e[33m' C_B=$'\e[1m' C_N=$'\e[0m'
else
  C_G='' C_R='' C_Y='' C_B='' C_N=''
fi
log_info() { printf '%s[info]%s %s\n'  "$C_B" "$C_N" "$*"; }
log_ok()   { printf '%s[ ok ]%s %s\n'  "$C_G" "$C_N" "$*"; }
log_warn() { printf '%s[warn]%s %s\n'  "$C_Y" "$C_N" "$*"; }
log_err()  { printf '%s[ERREUR]%s %s\n' "$C_R" "$C_N" "$*" >&2; }

usage() {
  cat <<'USAGE'
Orbit — backup.sh (exploitation serveur)

Usage :
  ./scripts/backup.sh               Sauvegarde immédiate (mode « now » du
                                    conteneur backup : daily/ weekly/ monthly/
                                    rétention 7 j / 4 sem / 6 mois)
  ./scripts/backup.sh --list        Inventaire du volume orbit_backups (ls -lhR)
  ./scripts/backup.sh --verify      Vérifie la dernière sauvegarde .db.gz
                                    (taille, gzip, intégrité SQLite)
  ./scripts/backup.sh --help        Cette aide

Codes retour :
  0 succès · 2 arguments invalides · 3 prérequis manquants (docker, fichiers,
  stack, conteneur backup, volume) · 4 sauvegarde absente/corrompue/échouée
USAGE
}

fail() { log_err "$2"; exit "$1"; }

fmt_dur() { # secondes → « 2 min 05 s » / « 8 s »
  local s="$1"
  if [ "$s" -ge 60 ]; then printf '%d min %02d s' $((s / 60)) $((s % 60))
  else printf '%d s' "$s"; fi
}
fmt_size() { numfmt --to=iec "$1" 2>/dev/null || printf '%s o' "$1"; }

# ── Prérequis ───────────────────────────────────────────────────────────────
require_docker() {
  command -v docker >/dev/null 2>&1 || fail 3 "Docker est introuvable sur ce serveur (PATH)."
}
require_files() {
  [ -f "$COMPOSE_FILE" ] || fail 3 "Fichier introuvable : $COMPOSE_FILE
  Les scripts d'exploitation supposent le déploiement production
  (docker-compose.prod.yml + .env.production, tâche 19-a) à la racine du
  dépôt : $ROOT_DIR"
  [ -f "$ENV_FILE" ] || fail 3 "Fichier introuvable : $ENV_FILE (voir tâche 19-a)."
}
require_stack() {
  local running
  running="$("${COMPOSE[@]}" ps --services 2>/dev/null | sort -u || true)"
  if [ -z "$running" ]; then
    fail 3 "Aucun service de la stack n'est en cours d'exécution (docker compose ps).
  Démarrage : ${COMPOSE[*]} up -d   (ou ./scripts/deploy.sh)"
  fi
}
require_service_running() { # service
  if ! "${COMPOSE[@]}" ps --services 2>/dev/null | grep -qx "$1"; then
    fail 3 "Le service « $1 » n'est pas en cours d'exécution.
  État de la stack : ${COMPOSE[*]} ps"
  fi
}

# ── Résolution du volume Docker (nom réel selon `name:` du compose prod) ────
# Teste le nom court (volume à `name:` explicite) puis la forme préfixée
# <projet>_<nom>. En cas d'échec : exit 3 (message affiché par le sous-shell).
resolve_volume() { # nom court → nom réel sur stdout
  local short="$1" real
  for real in "$short" "${COMPOSE_PROJECT}_${short}"; do
    if docker volume inspect "$real" >/dev/null 2>&1; then
      printf '%s\n' "$real"
      return 0
    fi
  done
  log_err "Volume Docker introuvable : $short (essayé « $short » et « ${COMPOSE_PROJECT}_${short} »).
  La stack a-t-elle déjà été démarrée ? Vérifier : docker volume ls | grep orbit"
  return 3
}

# ── Image outil pour les conteneurs jetables ────────────────────────────────
# L'image du conteneur backup (sqlite3 inclus) si détectable, sinon alpine:3.
tool_image() {
  local cid img
  cid="$("${COMPOSE[@]}" ps -aq backup 2>/dev/null | head -n 1 || true)"
  if [ -n "$cid" ]; then
    img="$(docker inspect "$cid" --format '{{.Config.Image}}' 2>/dev/null || true)"
  fi
  printf '%s\n' "${img:-alpine:3}"
}

# ── Exécution sh dans le conteneur backup (sqlite3 dispo, volume monté) ─────
# Le point de montage (auto-détecté) est exposé au shell via $BK_DIR.
# bk_exec <script-sh> [args…] : les args deviennent $1, $2… du script sh.
BK_MOUNT="$BACKUP_MOUNT_FALLBACK"
bk_exec() {
  "${COMPOSE[@]}" exec -T -e BK_DIR="$BK_MOUNT" backup sh -c "$1" orbit "${@:2}"
}
detect_backup_mount() {
  local cid detected fmt
  cid="$("${COMPOSE[@]}" ps -aq backup 2>/dev/null | head -n 1 || true)"
  [ -n "$cid" ] || return 0
  fmt="{{range .Mounts}}{{if eq .Name \"${BK_VOL:?}\"}}{{.Destination}}{{end}}{{end}}"
  detected="$(docker inspect "$cid" --format "$fmt" 2>/dev/null || true)"
  if [ -n "$detected" ]; then
    BK_MOUNT="$detected"
  else
    log_warn "Point de montage du volume $BK_VOL non détecté — fallback : $BK_MOUNT"
  fi
}

# Dernier fichier .db.gz du volume (tri par date de modification)
bk_find_latest() {
  local out rc=0
  out="$(bk_exec '
    set -- $(find "$BK_DIR" -type f -name "*.db.gz" 2>/dev/null)
    [ $# -gt 0 ] || exit 1
    ls -t "$@" | head -n 1
  ' 2>/dev/null)" || rc=$?
  [ "$rc" -eq 0 ] && printf '%s\n' "$out" || return 1
}

# ════════════════════════════════════════════════════════════════════════════
# Modes
# ════════════════════════════════════════════════════════════════════════════

cmd_now() {
  require_files
  require_stack
  require_service_running backup
  detect_backup_mount
  local t0 rc=0 latest size
  log_info "Déclenchement d'une sauvegarde immédiate (mode « now » du conteneur backup)…"
  t0="$SECONDS"
  "${COMPOSE[@]}" exec -T backup /backup.sh now || rc=$?
  if [ "$rc" -ne 0 ]; then
    log_err "La sauvegarde a échoué (code $rc renvoyé par /backup.sh)."
    echo "  Diagnostic : ${COMPOSE[*]} logs --tail 80 backup" >&2
    exit 4
  fi
  # Résultat : dernier fichier + taille + durée
  if ! latest="$(bk_find_latest)"; then
    log_warn "Aucun fichier .db.gz détecté après la sauvegarde."
    echo "  Diagnostic : ${COMPOSE[*]} logs backup" >&2
    exit 4
  fi
  size="$("${COMPOSE[@]}" exec -T backup stat -c '%s' "$BK_MOUNT/$latest" 2>/dev/null \
    | tr -dc '0-9' || true)"
  if [ -n "$size" ]; then
    log_ok "Sauvegarde créée : orbit_backups:/$latest ($(fmt_size "$size")) en $(fmt_dur "$((SECONDS - t0))")."
  else
    log_ok "Sauvegarde créée : orbit_backups:/$latest en $(fmt_dur "$((SECONDS - t0))")."
  fi
  log_info "Contrôle recommandé : ./scripts/backup.sh --verify"
}

cmd_list() {
  require_files
  local img out
  img="$(tool_image)"
  log_info "Contenu du volume orbit_backups ($BK_VOL) :"
  # --entrypoint sh : l'image backup a ENTRYPOINT /backup.sh (loop/now) — sans
  # cette option, « ls -lhR /backups » serait interprété comme un mode du
  # planificateur de sauvegarde.
  out="$(docker run --rm --entrypoint sh -v "$BK_VOL":/backups "$img" \
    -c 'ls -lhR /backups' 2>&1)" || true
  printf '%s\n' "$out"
  if ! printf '%s' "$out" | grep -qE '\.(db|tar)\.gz'; then
    log_warn "Aucune sauvegarde (*.db.gz / *.tar.gz) trouvée dans ce volume."
  fi
}

cmd_verify() {
  require_files
  require_stack
  require_service_running backup
  detect_backup_mount
  local latest rc=0 out size
  latest="$(bk_find_latest)" || fail 4 "Aucune sauvegarde .db.gz dans orbit_backups — rien à vérifier."
  log_info "Vérification de la dernière sauvegarde : orbit_backups:/$latest"
  out="$(bk_exec '
    set -e
    f="$BK_DIR/$1"
    [ -f "$f" ]              || { echo "FICHIER INTROUVABLE"; exit 31; }
    [ -s "$f" ]              || { echo "FICHIER VIDE";       exit 21; }
    gzip -t "$f" 2>/dev/null || { echo "CORRUPTION GZIP";    exit 22; }
    command -v sqlite3 >/dev/null 2>&1 || { echo "SQLITE3 ABSENT"; exit 30; }
    tmp="$(mktemp)"
    gunzip -c "$f" > "$tmp"
    if head -c 16 "$tmp" | grep -q "SQLite format 3"; then
      : # copie binaire compressée de la base → directement vérifiable
    else
      # dump SQL gzippé → le rejouer dans une base vierge avant contrôle
      mv "$tmp" "$tmp.sql"; : > "$tmp"
      sqlite3 "$tmp" < "$tmp.sql"
      rm -f "$tmp.sql"
    fi
    result="$(sqlite3 "$tmp" "PRAGMA integrity_check;" 2>&1)"
    rm -f "$tmp"
    [ "$result" = "ok" ] || { echo "INTEGRITE : $result"; exit 23; }
    stat -c %s "$f"
  ' "$latest" 2>&1)" || rc=$?
  case "$rc" in
    0)
      size="$(printf '%s' "$out" | tail -n 1 | tr -dc '0-9')"
      log_ok "Sauvegarde saine ($(fmt_size "${size:-?}")) : gzip intègre, PRAGMA integrity_check = ok."
      ;;
    21) fail 4 "Sauvegarde VIDE : $latest" ;;
    22) fail 4 "Sauvegarde gzip corrompue : $latest (gunzip refuse le fichier)" ;;
    23) fail 4 "Base SQLite corrompue : $latest
$(printf '%s' "$out" | sed '$d')" ;;
    31) fail 4 "Fichier introuvable dans le volume : $latest" ;;
    30) fail 3 "sqlite3 est absent du conteneur backup (image inattendue) — vérification SQLite impossible" ;;
    *)  fail 4 "Échec inattendu de la vérification (code $rc) :
$out" ;;
  esac
  log_info "Rotation/rétention gérées par le conteneur backup (7 j / 4 sem / 6 mois)."
}

# ════════════════════════════════════════════════════════════════════════════
# Point d'entrée
# ════════════════════════════════════════════════════════════════════════════
main() {
  local mode="${1:-now}"
  case "$mode" in
    --help|-h) usage; exit 0 ;;
    --list)    [ "$#" -le 1 ] || fail 2 "L'option --list n'accepte aucun argument." ;;
    --verify)  [ "$#" -le 1 ] || fail 2 "L'option --verify n'accepte aucun argument." ;;
    now)       [ "$#" -le 1 ] || fail 2 "Argument inattendu : $2 (essayez --help)." ;;
    *)         fail 2 "Argument inconnu : $mode (essayez --help)." ;;
  esac
  require_docker
  BK_VOL="$(resolve_volume "$BACKUP_VOLUME_NAME")"
  case "$mode" in
    now)      cmd_now ;;
    --list)   cmd_list ;;
    --verify) cmd_verify ;;
  esac
}

main "$@"
