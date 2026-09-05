#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Orbit — entrypoint Ollama
# 1. démarre le serveur Ollama en arrière-plan
# 2. télécharge le(s) modèle(s) si absent(s) — équiv. manuel : `ollama pull llama3.1:8b`
# 3. suit les logs du serveur (le conteneur reste vivant)
#
# OLLAMA_MODELS : liste séparée par des espaces (défaut : llama3.1:8b).
# Exemples (docker-compose / -e) :
#   OLLAMA_MODELS="llama3.1:8b"                       → généraliste seul (~4,9 Go)
#   OLLAMA_MODELS="llama3.1:8b nomic-embed-text"     → + embeddings (~274 Mo)
#   OLLAMA_MODELS="llama3.1:8b mistral:7b nomic-embed-text" → spec complète
# ─────────────────────────────────────────────────────────────────────────────
set -e

MODELS="${OLLAMA_MODELS:-${OLLAMA_MODEL:-llama3.1:8b}}"

echo "[orbit:ollama] démarrage du serveur sur le port 11434…"
ollama serve &

# On attend que l'API HTTP réponde (max ~60 s)
echo "[orbit:ollama] attente de l'API…"
i=0
until curl -sf http://localhost:11434/api/tags > /dev/null 2>&1 || [ "$i" -ge 60 ]; do
  i=$((i + 1))
  sleep 1
done

# Téléchargement des modèles (no-op s'ils sont déjà dans le volume)
for MODEL in $MODELS; do
  echo "[orbit:ollama] téléchargement du modèle ${MODEL} (si nécessaire)…"
  ollama pull "$MODEL"
  echo "[orbit:ollama] modèle ${MODEL} prêt."
done

# Le conteneur vit tant que le serveur vit
wait %1
