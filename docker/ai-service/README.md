# Orbit — IA locale (Ollama + micro-service FastAPI)

## Objectif

Toute l'inférence d'Orbit (extraction d'événements depuis les emails,
assistant conversationnel) est **100 % locale** : aucune donnée ne quitte
la machine. Llama 3 8B tourne dans Ollama, derrière un micro-service
FastAPI qui expose un contrat REST stable.

## Démarrage (Docker)

```bash
# 1. Lancer l'infrastructure IA complète
docker compose up -d

# Le premier démarrage télécharge automatiquement llama3 (~4,7 Go).
# Équivalent manuel :
ollama pull llama3

# 2. Vérifier que tout est prêt
curl http://localhost:3031/health
# → {"ok":true,"provider":"ollama","model":"llama3","ollamaReachable":true,...}

# 3. Côté Next.js (.env)
AI_SERVICE_URL=http://localhost:3031
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3
```

## Démarrage sans Docker (Ollama installé nativement)

```bash
ollama serve &              # serveur d'inférence sur :11434
ollama pull llama3          # télécharge le modèle (~4,7 Go)

cd docker/ai-service
pip install -r requirements.txt
OLLAMA_URL=http://localhost:11434 OLLAMA_MODEL=llama3 \
  uvicorn main:app --host 0.0.0.0 --port 3031
```

## Contrat REST (identique au mini-service bun de développement)

| Méthode | Route           | Corps                                        | Réponse                                   |
| ------- | --------------- | -------------------------------------------- | ----------------------------------------- |
| GET     | `/health`       | —                                            | état + provider actif                     |
| POST    | `/analyze-email`| `{subject, from, bodyText, now, timezone}`   | `{result: {isEvent, title, startTime, endTime, durationMinutes, confidence}}` |
| POST    | `/chat`         | `{system, messages: [{role, content}]}`      | flux `text/plain` (streaming)             |

Exemple :

```bash
curl -X POST http://localhost:3031/analyze-email \
  -H "Content-Type: application/json" \
  -d '{"subject":"RDV dentiste","from":"cabinet@ex.fr",
       "bodyText":"Rendez-vous confirmé jeudi à 14h30, durée 45 min."}'
```

## Autres modèles (matériel plus modeste)

```bash
ollama pull llama3:8b-instruct-q4_K_M   # quantisation Q4 (~4,7 Go)
ollama pull mistral:7b                  # alternative Mistral 7B
# puis : OLLAMA_MODEL=mistral docker compose up -d
```

## Architecture

```
[Next.js /api/ai/*]  →  [ai-api FastAPI :3031]  →  [Ollama :11434 / llama3]
   auth + contexte DB      contrat REST stable        inférence locale
```

Le mini-service bun `mini-services/ai-service` joue ce même rôle dans la
sandbox de développement (avec fallback z-ai-web-dev-sdk absent ici, pour
garantir la confidentialité stricte en production).
