# Orbit — image Ollama avec pré-téléchargement du modèle
# Le modèle (llama3 par défaut, ~4,7 Go) est téléchargé au premier
# démarrage puis persisté dans le volume Docker `ollama_models`.
FROM ollama/ollama:latest

# OLLAMA_MODEL est passé au entrypoint via l'environnement du compose
# (valeur par défaut : llama3 — équivalent quantifié de Llama 3 8B).
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 11434

ENTRYPOINT ["/bin/sh", "/entrypoint.sh"]
