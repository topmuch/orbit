#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Orbit — entrypoint Ollama
# 1. démarre le serveur Ollama en arrière-plan
# 2. télécharge le modèle si absent (équiv. manuel : `ollama pull llama3`)
# 3. suit les logs du serveur (le conteneur reste vivant)
# ─────────────────────────────────────────────────────────────────────────────
set -e

MODEL="${OLLAMA_MODEL:-llama3}"
echo "[orbit:ollama] démarrage du serveur sur le port 11434…"
ollama serve &

# On attend que l'API HTTP réponde (max ~60 s)
echo "[orbit:ollama] attente de l'API…"
for i in $(seq 1 60); do
  if curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Téléchargement du modèle (no-op s'il est déjà présent dans le volume)
echo "[orbit:ollama] téléchargement du modèle ${MODEL} (si nécessaire)…"
ollama pull "$MODEL"
echo "[orbit:ollama] modèle ${MODEL} prêt."

# Le conteneur vit tant que le serveur vit
wait %1
