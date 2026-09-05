# Orbit — micro-service IA (FastAPI) conteneurisé
# Image de production : Python 3.12 slim + uvicorn.
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

EXPOSE 3031

# OLLAMA_URL pointe vers le service `ollama` du docker-compose (réseau interne)
ENV OLLAMA_URL=http://ollama:11434 \
    OLLAMA_MODEL=llama3

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "3031"]
