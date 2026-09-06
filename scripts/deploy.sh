#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# Orbit — deploy.sh : déploiement d'une version (avec rollback automatique)
# ════════════════════════════════════════════════════════════════════════════
# Usage :
#   ./scripts/deploy.sh [sha|latest|<tag>] [--skip-pull]
#   ./scripts/deploy.sh --rollback
#
#   sha            déploie le commit courant du dépôt git local
#                  (git rev-parse HEAD)
#   latest         déploie le dernier tag publié sur ghcr.io (défaut)
#   <tag|sha-git>  déploie ce tag d'image précis (ex. SHA complet ou court
#                  d'un commit, ex. 1f2e3d4) — un SHA est vérifié dans le
#                  dépôt git après un fetch
#   --skip-pull    ne pas faire « docker compose pull » (images supposées
#                  déjà présentes localement)
#   --rollback     retour au tag PRÉCÉDEMMENT déployé (lu dans
#                  .deployed-tag.history) ; à nouveau : on remonte d'un cran
#
# Exemples :
#   ./scripts/deploy.sh                    # dernier « latest » publié
#   ./scripts/deploy.sh sha                # le commit courant (HEAD)
#   ./scripts/deploy.sh 1f2e3d4            # un SHA précis (vérifié via git)
#   ./scripts/deploy.sh latest --skip-pull # pas de pull réseau
#   ./scripts/deploy.sh --rollback         # retour arrière manuel
#
# Déroulement :
#   1. résolution du tag cible (git fetch + vérification du SHA si applicable
#      — AVANT toute modification de la stack)
#   2. lecture de l'ancien tag (.deployed-tag ; « latest » si absent)
#   3. docker compose pull + vérification de la présence locale des images
#      ghcr.io/topmuch/orbit/{web,ai-service,reminder}:<tag>
#   4. IMAGE_TAG=<tag> docker compose up -d --remove-orphans
#   5. attente de la santé (health-check.sh --wait 30) :
#      ÉCHEC → ROLLBACK AUTOMATIQUE : relance de l'ancien tag + santé,
#      messages d'aide (logs), exit 1 — .deployed-tag reste l'ancien tag
#   6. SUCCÈS : tag écrit dans .deployed-tag (+ historique .deployed-tag.history),
#      résumé (ancien → nouveau, durée), docker image prune -f
#
# Codes retour (exploitables en cron) :
#   0  déploiement réussi et santé OK
#   1  échec (rollback automatique ou manuel effectué/tenté)
#   2  arguments invalides / SHA introuvable / images introuvables (rien modifié)
#   3  prérequis manquants (docker, compose/env introuvables)
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Configuration locale (ajuster ici en cas d'écart, jamais dans le code) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$ROOT_DIR/docker-compose.prod.yml"
ENV_FILE="$ROOT_DIR/.env.production"
COMPOSE=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")
COMPOSE_PROJECT="orbit-prod"       # projet compose canonique (name: du YAML)
DEPLOYED_FILE="$ROOT_DIR/.deployed-tag"          # tag actuellement déployé
HISTORY_FILE="$ROOT_DIR/.deployed-tag.history"   # historique (récent en tête)
GHCR_PREFIX="ghcr.io/topmuch/orbit"
GHCR_IMAGES=("$GHCR_PREFIX/web" "$GHCR_PREFIX/ai-service" "$GHCR_PREFIX/reminder")
HEALTH_WAIT=30                     # tentatives de santé post-déploiement
ROLLBACK_HEALTH_WAIT=12            # tentatives post-rollback (~2 min)
HEALTH_INTERVAL=10                 # secondes entre tentatives

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
Orbit — deploy.sh (exploitation serveur)

Usage :
  ./scripts/deploy.sh [sha|latest|<tag>] [--skip-pull]
  ./scripts/deploy.sh --rollback

  sha            commit courant du dépôt git (git rev-parse HEAD)
  latest         dernier tag publié (défaut)
  <tag|sha-git>  tag d'image précis (SHA vérifié dans le dépôt git)
  --skip-pull    pas de docker compose pull (images déjà locales)
  --rollback     retour au tag précédemment déployé (.deployed-tag.history)

Sécurité :
  - santé attendue après déploiement (health-check --wait 30) ;
  - ÉCHEC → ROLLBACK AUTOMATIQUE vers l'ancien tag (exit 1) ;
  - succès → tag consigné dans .deployed-tag (base du rollback).

Codes retour :
  0 succès · 1 échec (rollback effectué/tenté) · 2 arguments/SHA/images
  (rien modifié) · 3 prérequis manquants (docker, fichiers)
USAGE
}

fail() { log_err "$2"; exit "$1"; }
fmt_dur() {
  local s="$1"
  if [ "$s" -ge 60 ]; then printf '%d min %02d s' $((s / 60)) $((s % 60))
  else printf '%d s' "$s"; fi
}

# ── Prérequis ───────────────────────────────────────────────────────────────
require_docker() {
  command -v docker >/dev/null 2>&1 || fail 3 "Docker est introuvable sur ce serveur (PATH)."
}
require_files() {
  [ -f "$COMPOSE_FILE" ] || fail 3 "Fichier introuvable : $COMPOSE_FILE (déploiement 19-a)."
  [ -f "$ENV_FILE" ]     || fail 3 "Fichier introuvable : $ENV_FILE (déploiement 19-a)."
}
git_is_repo() { git -C "$ROOT_DIR" rev-parse --git-dir >/dev/null 2>&1; }

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

# ── Tag déployé / historique ────────────────────────────────────────────────
read_deployed_tag() {
  if [ -f "$DEPLOYED_FILE" ]; then
    head -n 1 "$DEPLOYED_FILE" | tr -d '[:space:]'
  else
    printf 'latest\n'
  fi
}
record_deployed() { # tag → .deployed-tag + historique (10 dernières entrées)
  local tag="$1" hist=""
  [ -f "$HISTORY_FILE" ] && hist="$(cat "$HISTORY_FILE")"
  { printf '%s\n%s\n' "$tag" "$hist"; } | head -n 10 > "$HISTORY_FILE.tmp"
  mv "$HISTORY_FILE.tmp" "$HISTORY_FILE"
  printf '%s\n' "$tag" > "$DEPLOYED_FILE"
}

# ── Résolution du tag cible ─────────────────────────────────────────────────
resolve_target_tag() { # argument (sha|latest|<tag>) → TARGET + KIND
  local arg="$1"
  case "$arg" in
    latest)
      TARGET="latest"; KIND="latest" ;;
    sha)
      git_is_repo || fail 2 "« sha » demandé mais $ROOT_DIR n'est pas un dépôt git."
      TARGET="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null)" \
        || fail 2 "git rev-parse HEAD a échoué (dépôt sans commit ?)."
      KIND="sha" ;;
    *)
      TARGET="$arg"
      if [[ "$TARGET" =~ ^[0-9a-f]{7,40}$ ]]; then KIND="sha"; else KIND="tag"; fi ;;
  esac
}
git_fetch_and_verify() {
  if [ "$KIND" != "sha" ]; then
    if [ "$KIND" = "tag" ]; then
      log_warn "« $TARGET » n'est ni « latest » ni un SHA git : tag d'image utilisé tel quel
  (non vérifiable côté dépôt git)."
    fi
    return 0
  fi
  git_is_repo || fail 2 "« $TARGET » ressemble à un SHA git mais $ROOT_DIR n'est pas un dépôt git."
  if git -C "$ROOT_DIR" fetch --quiet origin 2>/dev/null; then
    log_info "git fetch origin effectué."
  else
    log_warn "git fetch impossible (réseau ?) — vérification sur l'état local du dépôt."
  fi
  if ! git -C "$ROOT_DIR" rev-parse --verify --quiet "$TARGET^{commit}" >/dev/null; then
    fail 2 "SHA introuvable dans le dépôt git : $TARGET
  Derniers commits connus (origin/main) :
$(git -C "$ROOT_DIR" log --oneline -5 origin/main 2>/dev/null || true)
  (le tag doit exister côté git ET être publié sur ghcr.io par la CI)"
  fi
  log_ok "SHA vérifié dans le dépôt git : $TARGET"
}

# ── Images ──────────────────────────────────────────────────────────────────
verify_images() { # tag → return 1 (+ message) si une image attendue manque
  local tag="$1" img missing=""
  for img in "${GHCR_IMAGES[@]}"; do
    docker image inspect "$img:$tag" >/dev/null 2>&1 || missing="$missing
  - $img:$tag"
  done
  if [ -n "$missing" ]; then
    log_err "Images absentes localement :$missing
  Authentification au registre : docker login ghcr.io
  Le tag est-il publié par la CI ? ($GHCR_PREFIX/*:$tag)"
    return 1
  fi
  return 0
}
pull_images() { # tag → docker compose pull (tolérant) puis vérification locale
  local tag="$1" rc=0
  if ! IMAGE_TAG="$tag" "${COMPOSE[@]}" pull; then
    log_warn "docker compose pull a signalé un problème — vérification de la présence locale des images…"
  fi
  verify_images "$tag"
}
deploy_up() { # tag → up -d avec IMAGE_TAG exporté (shell > --env-file)
  IMAGE_TAG="$1" "${COMPOSE[@]}" up -d --remove-orphans
}

# ── Santé ───────────────────────────────────────────────────────────────────
wait_health() { # tentatives → 0 si healthy OU degraded
  local tries="$1"
  if [ -x "$SCRIPT_DIR/health-check.sh" ]; then
    log_info "Attente de la santé de l'application (jusqu'à $tries tentatives × ${HEALTH_INTERVAL} s)…"
    "$SCRIPT_DIR/health-check.sh" --wait "$tries"
  else
    log_warn "scripts/health-check.sh indisponible — contrôle HTTP de secours."
    local url i code
    url="$(health_url)"
    for i in $(seq 1 "$tries"); do
      code="$(curl -s -o /dev/null -m 10 -w '%{http_code}' "$url" 2>/dev/null || true)"
      [ "$code" = "200" ] && return 0
      sleep "$HEALTH_INTERVAL"
    done
    return 1
  fi
}

# ── Rollback ────────────────────────────────────────────────────────────────
rollback_to() { # tag raison → redéploie l'ancien tag, verdict santé, return 1
  local tag="$1" reason="$2" rc=0
  log_err "ÉCHEC du déploiement ($reason) — ROLLBACK AUTOMATIQUE vers « $tag »…"
  IMAGE_TAG="$tag" "${COMPOSE[@]}" pull >/dev/null 2>&1 || true  # best effort
  deploy_up "$tag" || rc=$?
  if [ "$rc" -ne 0 ]; then
    log_err "Le rollback lui-même a échoué (docker compose up KO) — intervention manuelle :
  ${COMPOSE[*]} ps
  ${COMPOSE[*]} logs --tail 100 web web-migrate"
    return 1
  fi
  if wait_health "$ROLLBACK_HEALTH_WAIT"; then
    log_ok "Rollback réussi : service rétabli sur « $tag » (santé OK)."
  else
    log_err "Rollback déployé mais la santé ne répond toujours pas — intervention :
  ${COMPOSE[*]} logs --tail 100 web web-migrate
  ./scripts/health-check.sh --infra"
  fi
  echo "  (le déploiement a échoué : .deployed-tag reste « $tag »)" >&2
  return 1
}
rollback_if_possible() { # raison → rollback vers OLD_TAG sauf tag identique
  local reason="$1"
  if [ "$OLD_TAG" = "$TARGET" ]; then
    log_err "ÉCHEC : $reason
  Impossible de rouler back automatiquement : l'ancien tag est identique ($OLD_TAG).
  Diagnostic : ${COMPOSE[*]} logs --tail 100 web web-migrate
  ./scripts/health-check.sh --infra"
    return 1
  fi
  rollback_to "$OLD_TAG" "$reason" || true
  return 1
}

# ════════════════════════════════════════════════════════════════════════════
# Modes
# ════════════════════════════════════════════════════════════════════════════

cmd_deploy() {
  require_docker
  require_files
  resolve_target_tag "$TARGET_ARG"
  local OLD_TAG t0
  OLD_TAG="$(read_deployed_tag)"
  log_info "Déploiement demandé : « $TARGET » — version actuellement déployée : « $OLD_TAG »."
  if [ "$TARGET" = "$OLD_TAG" ]; then
    log_warn "Le tag demandé est déjà celui enregistré comme déployé —
  redéploiement à l'identique (up -d)."
  fi

  # 1. Vérifications AVANT toute modification (git + pull + images)
  git_fetch_and_verify
  if [ "$SKIP_PULL" -ne 1 ]; then
    log_info "Téléchargement des images (docker compose pull, IMAGE_TAG=$TARGET)…"
    pull_images "$TARGET" || fail 2 "Images introuvables — ABANDON : rien n'a été modifié."
  else
    log_info "--skip-pull : pas de pull réseau (images supposées locales)."
  fi

  # 2. Mise en place
  t0="$SECONDS"
  if ! deploy_up "$TARGET"; then
    rollback_if_possible "docker compose up a échoué" || true
    exit 1
  fi

  # 3. Santé (healthy OU degraded) — sinon rollback automatique
  if ! wait_health "$HEALTH_WAIT"; then
    rollback_if_possible "health-check KO après $HEALTH_WAIT tentatives" || true
    exit 1
  fi

  # 4. Succès
  record_deployed "$TARGET"
  log_ok "Déploiement réussi : « $OLD_TAG » → « $TARGET » en $(fmt_dur "$((SECONDS - t0))") (santé OK)."
  if docker image prune -f >/dev/null 2>&1; then
    log_info "Nettoyage des images intermédiaires effectué (docker image prune -f)."
  else
    log_warn "docker image prune impossible (non bloquant)."
  fi
  log_info "Retour arrière : ./scripts/deploy.sh --rollback"
}

cmd_rollback() {
  require_docker
  require_files
  if [ ! -f "$DEPLOYED_FILE" ]; then
    fail 1 "Aucun déploiement enregistré ($DEPLOYED_FILE absent) — rien à annuler.
  Déployer d'abord : ./scripts/deploy.sh [sha|latest]"
  fi
  local current target rc=0
  current="$(read_deployed_tag)"
  target="$(awk -v cur="$current" '$0 != cur && $0 !~ /^[[:space:]]*$/ { print; exit }' \
    "$HISTORY_FILE" 2>/dev/null || true)"
  if [ -z "$target" ]; then
    fail 1 "Aucun tag précédent connu dans $HISTORY_FILE (historique vide).
  Précisez la cible : ./scripts/deploy.sh <sha|latest|tag>"
  fi
  log_info "Rollback manuel : « $current » → « $target » (tag précédent de l'historique)."
  IMAGE_TAG="$target" "${COMPOSE[@]}" pull >/dev/null 2>&1 || true  # best effort
  deploy_up "$target" || rc=$?
  if [ "$rc" -ne 0 ] || ! wait_health "$HEALTH_WAIT"; then
    log_err "Rollback vers « $target » en échec — retour au tag courant « $current »…"
    deploy_up "$current" || true
    wait_health "$ROLLBACK_HEALTH_WAIT" \
      || log_err "Santé toujours KO — intervention :
  ${COMPOSE[*]} logs --tail 100 web web-migrate
  ./scripts/health-check.sh --infra"
    exit 1
  fi
  record_deployed "$target"
  log_ok "Rollback effectué : « $current » → « $target » (santé OK)."
  log_info "Annuler encore : ./scripts/deploy.sh --rollback (remonte l'historique)"
}

# ════════════════════════════════════════════════════════════════════════════
# Point d'entrée
# ════════════════════════════════════════════════════════════════════════════
TARGET=""; KIND=""; TARGET_ARG="latest"; SKIP_PULL=0; ROLLBACK_ONLY=0
main() {
  local saw_positional=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --help|-h)   usage; exit 0 ;;
      --skip-pull) SKIP_PULL=1 ;;
      --rollback)  ROLLBACK_ONLY=1 ;;
      -*)          fail 2 "Option inconnue : $1 (essayez --help)." ;;
      *)
        [ "$saw_positional" -eq 0 ] || fail 2 "Trop d'arguments positionnels : $1"
        TARGET_ARG="$1"; saw_positional=1 ;;
    esac
    shift
  done
  if [ "$ROLLBACK_ONLY" -eq 1 ]; then
    [ "$saw_positional" -eq 0 ] || fail 2 "--rollback ne prend pas de tag en argument."
    cmd_rollback
  else
    cmd_deploy
  fi
}

main "$@"
