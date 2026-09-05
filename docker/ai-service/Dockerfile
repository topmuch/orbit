# Orbit — micro-service IA (FastAPI) conteneurisé
# Image de production : Python 3.12 slim + uvicorn.
FROM python:3.12-slim

WORKDIR /app

# Dépendances d'abord (cache Docker)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Application (structure routers/services/models/prompts)
COPY main.py .
COPY routers/ routers/
COPY services/ services/
COPY models/ models/
COPY prompts/ prompts/

EXPOSE 3031

# OLLAMA_URL pointe vers le service `ollama` du docker-compose (réseau interne).
# Modèle par défaut : llama3.1:8b (~4,9 Go quantifié) — généraliste, bon pour
# le chat et l'extraction structurée. Alternative plus rapide : mistral:7b.
ENV OLLAMA_URL=http://ollama:11434 \
    OLLAMA_MODEL=llama3.1:8b \
    OLLAMA_TIMEOUT_MS=90000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3031"]
