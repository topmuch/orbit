# Orbit AI Service — micro-service IA local (FastAPI)

> **100 % local** : toute l'inférence passe par [Ollama](https://ollama.com) —
> aucune donnée ne quitte la machine. Version production Dockerisée de
> l'architecture IA d'Orbit ; en développement sandbox, l'équivalent bun est
> [`mini-services/ai-service`](../../mini-services/ai-service) (même contrat).

## Architecture

```
[ navigateur ]
   └─ /api/ai/*  (Next.js : auth cookie + contexte DB + rate limit 10/min)
        └─ ai-provider.ts  (src/lib) — SEUL point de sortie IA de l'app
             └─ POST http://localhost:3031   ← CE SERVICE (FastAPI)
                  └─ Ollama  http://ollama:11434  (llama3.1:8b)
```

```
docker/ai-service/
├── main.py                  # app FastAPI + CORS + montage des routeurs
├── routers/
│   ├── analyze_email.py     # POST /analyze-email
│   ├── suggest_priority.py  # POST /suggest-priority
│   ├── chat.py              # POST /chat (streaming text/plain)
│   └── summarize.py         # POST /summarize
├── services/
│   ├── ollama_client.py     # client httpx Ollama (generate / stream / health)
│   ├── cache.py             # cache mémoire 10 min, 200 entrées
│   ├── prompts.py           # chargeur prompts/*.txt + interpolation {{CLE}}
│   └── utils.py             # sanitize, parse JSON tolérant, dates FR…
├── models/
│   └── schemas.py           # schémas Pydantic (bornes d'entrée)
├── prompts/
│   ├── email_analysis.txt       # extraction RDV (lieu + participants + année)
│   ├── priority_suggestion.txt  # suggestion LOW/MEDIUM/HIGH/URGENT
│   ├── summarization.txt        # synthèse (styles, longueur en mots)
│   └── chat.txt                 # prompt système par défaut de l'assistant
├── requirements.txt
└── Dockerfile
```

## Contrat REST

| Méthode | Route (racine et `/api/ai/…`) | Usage |
|---|---|---|
| GET | `/health` | `{ ok, provider, model, ollamaReachable, cache, uptimeSec }` |
| POST | `/analyze-email` | Extraction de rendez-vous depuis un email (JSON strict) |
| POST | `/suggest-priority` | Suggestion de priorité pour une tâche (JSON strict) |
| POST | `/summarize` | Synthèse d'un contenu long (JSON strict) |
| POST | `/chat` | Assistant conversationnel — **streaming** `text/plain` |

Exemples d'entrée/sortie (détail complet dans `docs/ai-guide.md`) :

```bash
# Analyse d'email → { result: { isEvent, title, startTime, endTime,
# durationMinutes, location, attendees[], confidence } , provider }
curl -s localhost:3031/analyze-email -H 'Content-Type: application/json' -d '{
  "subject": "Invitation réunion Atlas",
  "from": "claire@societe.fr",
  "bodyText": "Réunion lundi 2 février à 14 h en salle Rivoli…",
  "now": "2026-01-26T09:00:00Z", "timezone": "Africa/Dakar" }'

# Suggestion de priorité → { result: { suggestedPriority, confidence, reasoning } }
curl -s localhost:3031/suggest-priority -H 'Content-Type: application/json' -d '{
  "taskTitle": "Finaliser le devis client",
  "taskDescription": "Deadline vendredi",
  "dueDate": "2026-01-29T10:00:00Z",
  "userContext": { "totalTasks": 12, "urgentTasks": 2, "overdueTasks": 1 } }'

# Synthèse → { result: { summary, originalLength, summaryLength, style } }
curl -s localhost:3031/summarize -H 'Content-Type: application/json' -d '{
  "content": "…texte long (≥ 200 caractères)…",
  "style": "bullet_points", "maxLength": 150 }'
```

## Installation

### Docker (recommandé)

```bash
# Depuis la racine du projet
docker compose up -d          # ollama + ai-api
docker compose logs -f ollama # suit le téléchargement du modèle (~4,9 Go)

# Vérification
curl -s localhost:3031/health # → {"ok": true, "provider": "ollama", …}
```

Puis côté Next.js (`.env`) :

```env
AI_SERVICE_URL="http://localhost:3031"
OLLAMA_URL="http://localhost:11434"
OLLAMA_MODEL="llama3.1:8b"
```

### Hors Docker (Ollama natif)

```bash
ollama pull llama3.1:8b
pip install -r requirements.txt
OLLAMA_URL=http://localhost:11434 uvicorn main:app --host 0.0.0.0 --port 3031
```

## Modèles

| Modèle | Taille | Usage |
|---|---|---|
| `llama3.1:8b` | ~4,9 Go | Généraliste : chat, analyse d'emails, synthèse (défaut) |
| `mistral:7b` | ~4,1 Go | Plus rapide, bon pour l'extraction structurée |
| `nomic-embed-text` | ~274 Mo | Embeddings (recherche sémantique future) |

Changer de modèle : `OLLAMA_MODEL=mistral:7b` (compose ou env), le
`healthcheck` et le micro-service s'adaptent automatiquement. Pré-télécharger
plusieurs modèles : `OLLAMA_MODELS="llama3.1:8b mistral:7b nomic-embed-text"`.

## Sécurité & performance

- **Confidentialité stricte** : pas de fallback cloud ici (contrairement à la
  sandbox) — si Ollama est down, les routes répondent 502 avec un message
  actionnable.
- **Timeouts** : 90 s par inférence (`OLLAMA_TIMEOUT_MS`), 5 s pour le health.
- **Cache mémoire** : réponses identiques servies depuis le cache (TTL 10 min,
  200 entrées, `AI_CACHE_TTL_MS`) — le chat n'est jamais caché.
- **Rate limiting** : appliqué côté Next.js (10 requêtes IA/min/utilisateur).
- **Sanitization** : bornes sur toutes les entrées (email 4 000 car., synthèse
  12 000, etc.) avant envoi au modèle.
- **JSON robuste** : mode `format: "json"` d'Ollama + parse tolérant ; les
  bornes métier finales (horizon de dates, confiance 0-1) vivent côté Next.js.
- **Logs** : on logue les statuts, JAMAIS les contenus sensibles.

## Dépannage

| Symptôme | Cause probable | Solution |
|---|---|---|
| `/health` → `ollamaReachable: false` | Ollama éteint / port 11434 fermé | `docker compose up -d ollama` puis patienter (téléchargement initial) |
| 502 « modèle téléchargé ? » | `OLLAMA_MODEL` absent du volume | `docker compose exec ollama ollama pull llama3.1:8b` |
| Réponses très lentes | CPU seul, modèle 8B | Passer à `mistral:7b`, ou activer le GPU (section `deploy` du compose) |
| `container en restarting` | RAM insuffisante (< 6 Go libres) | Plus petit modèle ou fermer d'autres applications |
| Chat figé au premier token | Buffer inverse proxy | Le service envoie déjà `X-Accel-Buffering: no` ; vérifier votre proxy |
| JSON invalide côté Next.js | Sortie LLM non conforme | Le parse tolérant + les garde-fous couvrent ce cas ; sinon réessayer (cache 10 min) |
