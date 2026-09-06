#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════
# Orbit — health-check.sh : contrôle de santé de l'application (hôte)
# ════════════════════════════════════════════════════════════════════════════
# Usage :
#   ./scripts/health-check.sh [--url URL] [--wait N] [--interval S] [--json]
#                             [--infra]
#
#   --url URL       Endpoint interrogé. Défaut :
#                   $ORBIT_HEALTH_URL, sinon https://<DOMAIN_NAME>/api/health
#                   (DOMAIN_NAME lu dans .env.production), sinon erreur.
#   --wait N        Nombre de tentatives (défaut 1), espacées de --interval s.
#                   Tant que l'application n'est pas saine, on réessaie ;
#                   succès (healthy ou degraded) → sortie immédiate.
#   --interval S    Secondes entre les tentatives (défaut 10).
#   --json          Sortie stdout = dernier corps JSON brut (monitoring) ;
#                   le diagnostic part sur stderr.
#   --infra         Complément : docker compose ps + alerte sur conteneurs
#                   unhealthy / services arrêtés. N'altère PAS le code retour.
#   --help          Cette aide
#
# Exemples :
#   ./scripts/health-check.sh                          # cron de supervision
#   ./scripts/health-check.sh --wait 30                # attente post-déploiement
#   ./scripts/health-check.sh --url http://localhost:3000/api/health
#   ./scripts/health-check.sh --json | jq .            # monitoring (jq opt.)
#   ./scripts/health-check.sh --infra                  # app + conteneurs
#
# Contrat /api/health (200 = healthy ou DEGRADED — services optionnels KO,
# application utilisable ; 503 = base de données KO) :
#   { "status": "healthy|degraded|unhealthy",
#     "checks": { "database": …, "aiService": …, "reminderService": … } }
#   (les valeurs des checks peuvent être des chaînes, booléens ou objets
#    {status, latencyMs, error…} — tout est affiché)
#
# Codes retour (exploitables en cron) :
#   0  application saine (healthy) ou dégradée (degraded — utilisable)
#   1  application en échec (unhealthy, ou HTTP 503 = database KO)
#   2  injoignable (DNS/réseau/timeout, ou réponse HTTP inattendue : 4xx/5xx)
#   3  configuration impossible (aucune URL déterminable, fichiers absents)
# ════════════════════════════════════════════════════════════════════════════
set -euo pipefail

# ── Configuration locale ────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
COMPOSE_FILE="$ROOT_DIR/docker-compose.prod.yml"
ENV_FILE="$ROOT_DIR/.env.production"
COMPOSE=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")
CURL_TIMEOUT=10      # secondes par tentative

# ── Options ─────────────────────────────────────────────────────────────────
URL="${ORBIT_HEALTH_URL:-}"
WAIT=1
INTERVAL=10
JSON_MODE=0
INFRA=0
TMP_BODY="$(mktemp)"; TMP_ERR="$(mktemp)"
trap 'rm -f "$TMP_BODY" "$TMP_ERR"' EXIT

usage() {
  cat <<'USAGE'
Orbit — health-check.sh (exploitation serveur)

Usage :
  ./scripts/health-check.sh [--url URL] [--wait N] [--interval S] [--json]
                            [--infra]

Options :
  --url URL       défaut : https://<DOMAIN_NAME>/api/health (depuis
                  .env.production) ou $ORBIT_HEALTH_URL
  --wait N        tentatives successives (défaut 1) jusqu'à ce que l'app
                  soit saine (healthy ou degraded)
  --interval S    secondes entre tentatives (défaut 10)
  --json          stdout = dernier corps JSON (diagnostic sur stderr)
  --infra         ajoute docker compose ps + alertes conteneurs

Codes retour :
  0 sain ou dégradé · 1 unhealthy/503 · 2 injoignable (réseau ou HTTP
  inattendu) · 3 configuration impossible
USAGE
}

# ── Sortie lisible ──────────────────────────────────────────────────────────
if [ -t 1 ]; then
  C_G=$'\e[32m' C_R=$'\e[31m' C_Y=$'\e[33m' C_B=$'\e[1m' C_N=$'\e[0m'
else
  C_G='' C_R='' C_Y='' C_B='' C_N=''
fi
_out() { if [ "$JSON_MODE" -eq 1 ]; then printf '%s\n' "$*" >&2; else printf '%s\n' "$*"; fi; }
log_info() { _out "$(printf '%s[info]%s %s' "$C_B" "$C_N" "$*")"; }
log_ok()   { _out "$(printf '%s[ ok ]%s %s' "$C_G" "$C_N" "$*")"; }
log_warn() { _out "$(printf '%s[warn]%s %s' "$C_Y" "$C_N" "$*")"; }
log_err()  { printf '%s[ERREUR]%s %s\n' "$C_R" "$C_N" "$*" >&2; }
fail() { log_err "$2"; exit "$1"; }

# ── URL par défaut : DOMAIN_NAME du .env.production ────────────────────────
resolve_default_url() {
  if [ -n "$URL" ]; then return 0; fi
  local domain=""
  if [ -f "$ENV_FILE" ]; then
    domain="$(grep -E '^[[:space:]]*DOMAIN_NAME[[:space:]]*=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
    domain="${domain#\"}"; domain="${domain%\"}"
    domain="${domain#\'}"; domain="${domain%\'}"
    domain="$(printf '%s' "$domain" | tr -d '[:space:]')"
  fi
  if [ -n "$domain" ]; then
    URL="https://${domain}/api/health"
  else
    fail 3 "Impossible de déterminer l'URL de santé :
  ni --url, ni la variable ORBIT_HEALTH_URL, ni DOMAIN_NAME dans
  $ENV_FILE. Exemple : ./scripts/health-check.sh --url https://orbit.exemple.fr/api/health"
  fi
}

# ── Analyse du JSON (python3, fallback grep si absent) ──────────────────────
# Sortie : « STATUS\t<valeur> » + « CHECK\t<nom>\t<état>\t<détail> »
parse_health() { # fichier body
  if command -v python3 >/dev/null 2>&1; then
    python3 - "$1" <<'PY'
import json, sys
try:
    with open(sys.argv[1], "rb") as fh:
        data = json.loads(fh.read().decode("utf-8", "replace"))
except Exception as exc:
    sys.stderr.write("JSON illisible : %s\n" % exc)
    sys.exit(1)
if not isinstance(data, dict):
    sys.stderr.write("Réponse inattendue (pas un objet JSON)\n")
    sys.exit(1)
status = data.get("status", "")
print("STATUS\t%s" % (status if isinstance(status, str) else status))
checks = data.get("checks")
if isinstance(checks, dict):
    for name in sorted(checks):
        val = checks[name]
        st, detail = "", ""
        if isinstance(val, dict):
            st = val.get("status", val.get("ok", val.get("state", "")))
            bits = []
            for key in ("latencyMs", "latency", "responseTimeMs", "elapsed",
                        "error", "message", "detail", "url"):
                v = val.get(key)
                if v not in (None, ""):
                    bits.append("%s=%s" % (key, v))
            detail = ", ".join(str(b) for b in bits)
        elif isinstance(val, bool):
            st = "ok" if val else "error"
        if not isinstance(st, str):
            st = str(st)
        print("CHECK\t%s\t%s\t%s" % (name, st, detail))
PY
  else
    # Fallback sans python3 : statut global uniquement (analyse limitée).
    # 1) valeur connue (healthy|degraded|unhealthy) — insensible aux clés
    #    « status » internes aux checks ; 2) sinon première occurrence.
    local st
    st="$(grep -oE '"status"[[:space:]]*:[[:space:]]*"(healthy|degraded|unhealthy)"' "$1" 2>/dev/null | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
    if [ -z "$st" ]; then
      st="$(grep -oE '"status"[[:space:]]*:[[:space:]]*"[^"]*"' "$1" 2>/dev/null | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
    fi
    [ -n "$st" ] && printf 'STATUS\t%s\n' "$st"
    return 2
  fi
}

# État FR d'un check : ok/healthy/up/true → OK, sinon KO
state_fr() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    ok|healthy|up|true|passed|"") printf 'OK' ;;
    *) printf 'KO' ;;
  esac
}

# En mode --json : le dernier corps reçu part sur stdout (monitoring)
emit_body() {
  [ "$JSON_MODE" -eq 1 ] || return 0
  [ -s "$TMP_BODY" ] || return 0
  cat "$TMP_BODY"
}

# ── Affichage du bilan complet ──────────────────────────────────────────────
print_report() { # code http / temps s / verdict
  local code="$1" time_s="$2" verdict="$3" status="" line tag name st detail
  local parsed=""
  parsed="$(parse_health "$TMP_BODY")" || true
  if [ -n "$parsed" ]; then
    while IFS=$'\t' read -r tag name st detail; do
      case "$tag" in
        STATUS) status="$name" ;;
        CHECK)  CHECKS+=("$(printf '%s\t%s\t%s' "$name" "$st" "${detail:-}")") ;;
      esac
    done <<< "$parsed"
  fi
  local ms
  ms="$(awk -v t="$time_s" 'BEGIN { printf "%.0f", t * 1000 }' 2>/dev/null || echo '?')"

  _out "──────────────────────────────────────────────────────────────"
  _out " Orbit — bilan de santé ($URL)"
  _out "──────────────────────────────────────────────────────────────"
  _out " HTTP $code en ${ms} ms — verdict : $verdict"
  if [ -n "$status" ] && [ "$status" != "$verdict" ]; then
    _out " Statut déclaré par l'application : $status"
  fi
  if [ "${#CHECKS[@]}" -gt 0 ]; then
    _out ""
    _out " $(printf '%-18s %-6s %s' 'Vérification' 'État' 'Détail')"
    _out " $(printf '%-18s %-6s %s' '------------------' '------' '--------------------')"
    for line in "${CHECKS[@]}"; do
      IFS=$'\t' read -r name st detail <<< "$line"
      _out " $(printf '%-18s %-6s %s' "$name" "$(state_fr "$st")" "${detail:-}")"
    done
  elif [ -z "$parsed" ]; then
    _out " (analyse détaillée impossible : corps non-JSON ou python3 absent — corps : )"
    _out " $(head -c 300 "$TMP_BODY" 2>/dev/null || true)"
  fi
  _out "──────────────────────────────────────────────────────────────"
  emit_body
}
CHECKS=()

# ── Complément --infra : conteneurs Docker ─────────────────────────────────
show_infra() {
  _out ""
  _out "── Infrastructure Docker (stack orbit-prod) ──"
  if ! command -v docker >/dev/null 2>&1; then
    log_warn "--infra : Docker est introuvable (PATH) — diagnostic conteneurs impossible."
    return 0
  fi
  if [ ! -f "$COMPOSE_FILE" ] || [ ! -f "$ENV_FILE" ]; then
    log_warn "--infra : docker-compose.prod.yml / .env.production introuvables —
  diagnostic conteneurs impossible."
    return 0
  fi
  local ps_raw running all_services not_running
  ps_raw="$("${COMPOSE[@]}" ps 2>/dev/null || true)"
  _out "$ps_raw"
  if printf '%s\n' "$ps_raw" | grep -qi 'unhealthy'; then
    log_err "ALERTE : au moins un conteneur est signalé UNHEALTHY par Docker."
  fi
  running="$("${COMPOSE[@]}" ps --services 2>/dev/null | sort -u || true)"
  all_services="$("${COMPOSE[@]}" ps -a --services 2>/dev/null | sort -u || true)"
  if [ -n "$all_services" ] && [ -n "$running" ]; then
    not_running="$(comm -23 <(printf '%s\n' "$all_services") <(printf '%s\n' "$running"))"
    if [ -n "$not_running" ]; then
      log_warn "Conteneurs existants mais arrêtés :$(printf ' %s' $not_running)
  (normal pour un service one-shot tel que web-migrate)"
    fi
  fi
  log_info "--infra est un complément d'information : le code retour reste piloté
  par l'API de santé."
}

# ════════════════════════════════════════════════════════════════════════════
# Point d'entrée
# ════════════════════════════════════════════════════════════════════════════
main() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --help|-h) usage; exit 0 ;;
      --url)     [ "${2:-}" != "" ] || fail 3 "--url requiert une URL." ; URL="$2"; shift 2 ;;
      --wait)    [ "${2:-}" != "" ] || fail 3 "--wait requiert un nombre." ; WAIT="$2"; shift 2 ;;
      --interval) [ "${2:-}" != "" ] || fail 3 "--interval requiert un nombre." ; INTERVAL="$2"; shift 2 ;;
      --json)    JSON_MODE=1; shift ;;
      --infra)   INFRA=1; shift ;;
      -*)        fail 2 "Option inconnue : $1 (essayez --help)." ;;
      *)         fail 2 "Argument inattendu : $1 (les options vont avant)." ;;
    esac
  done
  case "$WAIT"    in ''|*[!0-9]*) fail 2 "--wait attend un entier > 0." ;; esac
  case "$INTERVAL" in ''|*[!0-9]*) fail 2 "--interval attend un entier (secondes)." ;; esac
  [ "$WAIT" -ge 1 ]    || fail 2 "--wait attend un entier > 0."
  [ "$INTERVAL" -ge 1 ] || fail 2 "--interval attend un entier > 0."
  resolve_default_url

  local attempt=0 code="" time_s="" rc=0 code_time="" last_kind="net" reason
  # last_kind : net (injoignable) | unhealthy (503/status) | unexpected (HTTP)
  while [ "$attempt" -lt "$WAIT" ]; do
    attempt=$((attempt + 1))
    rc=0
    code_time="$(curl -sS -m "$CURL_TIMEOUT" -o "$TMP_BODY" \
      -w '%{http_code} %{time_total}' "$URL" 2>"$TMP_ERR")" || rc=$?
    if [ "$rc" -ne 0 ]; then
      reason="$(head -n 1 "$TMP_ERR")"
      last_kind="net"
      if [ "$attempt" -lt "$WAIT" ]; then
        log_info "Tentative $attempt/$WAIT — injoignable ($reason) ; nouvelle tentative dans ${INTERVAL} s…"
        sleep "$INTERVAL"
        continue
      fi
      break
    fi
    code="${code_time%% *}"
    time_s="${code_time##* }"
    case "$code" in
      200)
        # 200 = healthy ou degraded (app utilisable) → verdict immédiat
        local status=""
        status="$(parse_health "$TMP_BODY" 2>/dev/null | sed -n 's/^STATUS\t//p' | head -n 1 || true)"
        case "$(printf '%s' "$status" | tr '[:upper:]' '[:lower:]')" in
          unhealthy)
            last_kind="unhealthy"
            if [ "$attempt" -lt "$WAIT" ]; then
              log_info "Tentative $attempt/$WAIT — HTTP 200 mais status=unhealthy ; nouvelle tentative dans ${INTERVAL} s…"
              sleep "$INTERVAL"; continue
            fi
            print_report "$code" "$time_s" "UNHEALTHY (l'application se déclare en échec)"
            [ "$INFRA" -eq 1 ] && show_infra
            exit 1 ;;
          degraded)
            print_report "$code" "$time_s" "DEGRADED (services optionnels défaillants, application utilisable)"
            log_warn "État dégradé : des services OPTIONNELS sont KO (IA, rappels…)."
            [ "$INFRA" -eq 1 ] && show_infra
            exit 0 ;;
          *)
            # healthy, ou champ status absent (on fait confiance au HTTP 200)
            if [ -z "$status" ]; then
              print_report "$code" "$time_s" "HEALTHY (HTTP 200 ; champ « status » absent de la réponse)"
            else
              print_report "$code" "$time_s" "HEALTHY"
            fi
            [ "$INFRA" -eq 1 ] && show_infra
            exit 0 ;;
        esac
        ;;
      503)
        last_kind="unhealthy"
        if [ "$attempt" -lt "$WAIT" ]; then
          log_info "Tentative $attempt/$WAIT — HTTP 503 (base de données KO ?) ; nouvelle tentative dans ${INTERVAL} s…"
          sleep "$INTERVAL"; continue
        fi
        break
        ;;
      *)
        last_kind="unexpected"
        reason="HTTP $code inattendu"
        if [ "$attempt" -lt "$WAIT" ]; then
          log_info "Tentative $attempt/$WAIT — $reason ; nouvelle tentative dans ${INTERVAL} s…"
          sleep "$INTERVAL"; continue
        fi
        break
        ;;
    esac
  done

  # ── Échec après (au plus) WAIT tentatives ────────────────────────────────
  case "$last_kind" in
    net)
      log_err "Application INJOIGNABLE : $URL
  ${reason:-erreur réseau}
  Vérifications : DNS/réseau, caddy démarré (${COMPOSE[*]} ps), pare-feu."
      [ "$INFRA" -eq 1 ] && show_infra
      exit 2
      ;;
    unhealthy)
      print_report "${code:-503}" "${time_s:-0}" "UNHEALTHY (HTTP 503 = base de données KO)"
      log_err "Application en ÉCHEC (unhealthy/503). Base de données injoignable ?
  Diagnostic : ${COMPOSE[*]} logs --tail 80 web web-migrate
  Restauration éventuelle : ./scripts/restore.sh <sauvegarde.db.gz>"
      [ "$INFRA" -eq 1 ] && show_infra
      exit 1
      ;;
    unexpected)
      log_err "Réponse HTTP INATTENDUE : $code sur $URL
  Corps reçu : $(head -c 300 "$TMP_BODY" 2>/dev/null || true)
  (503 = app en échec ; 200 attendu. 4xx/5xx autres → proxy/route en cause ?)"
      emit_body
      [ "$INFRA" -eq 1 ] && show_infra
      exit 2
      ;;
  esac
}

main "$@"
