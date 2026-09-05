# ═══════════════════════════════════════════════════════════════════════════
# Orbit — Micro-service IA (FastAPI, production)
# ───────────────────────────────────────────────────────────────────────────
# Point d'entrée : application FastAPI + CORS + montage des routeurs.
#
# Contrat REST exposé — IDENTIQUE au mini-service bun de développement
# (mini-services/ai-service) :
#   GET  /health           → { ok, provider, model, ollama*, cache, uptimeSec }
#   POST /analyze-email    → extraction de rendez-vous depuis un email (JSON)
#   POST /suggest-priority → suggestion LOW/MEDIUM/HIGH/URGENT (JSON)
#   POST /summarize        → synthèse de contenu long (JSON)
#   POST /chat             → assistant conversationnel (streaming text/plain)
#
# Chaque routeur est monté DEUX fois : à la racine (compatibilité Next.js /
# AI_SERVICE_URL=http://localhost:3031) et sous /api/ai (contrat spec).
#
# Toute l'inférence est 100 % LOCALE via Ollama (http://ollama:11434 en
# docker compose, http://localhost:11434 en direct) : aucune donnée ne
# quitte la machine. Le fallback z-ai-web-dev-sdk de la sandbox est
# volontairement ABSENT ici (confidentialité stricte).
#
# Démarrage manuel (hors Docker) :
#   pip install -r requirements.txt
#   OLLAMA_URL=http://localhost:11434 OLLAMA_MODEL=llama3.1:8b \
#     uvicorn main:app --host 0.0.0.0 --port 3031
# ═══════════════════════════════════════════════════════════════════════════

import os
import time

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from routers import analyze_email, chat, summarize, suggest_priority
from services.cache import cache_stats
from services.ollama_client import OllamaClient

OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434").rstrip("/")
OLLAMA_MODEL = os.getenv("OLLAMA_MODEL", "llama3.1:8b")
OLLAMA_TIMEOUT_S = float(os.getenv("OLLAMA_TIMEOUT_MS", "90000")) / 1000.0

app = FastAPI(title="Orbit AI Service", version="1.1.0")
STARTED_AT = time.time()

# CORS permissif : appelé côté serveur par Next.js, diagnostic navigateur possible.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

client = OllamaClient(base_url=OLLAMA_URL, model=OLLAMA_MODEL, timeout=OLLAMA_TIMEOUT_S)

# Montage double : racine (contrat bun/Next.js) + /api/ai (contrat spec).
for prefix in ("", "/api/ai"):
    app.include_router(analyze_email.router, prefix=prefix)
    app.include_router(suggest_priority.router, prefix=prefix)
    app.include_router(chat.router, prefix=prefix)
    app.include_router(summarize.router, prefix=prefix)


@app.get("/health")
async def health():
    reachable = await client.is_healthy()
    return {
        "ok": True,
        "service": "orbit-ai-service",
        "provider": "ollama" if reachable else "unavailable",
        "model": OLLAMA_MODEL,
        "ollamaConfigured": True,
        "ollamaReachable": reachable,
        "cache": cache_stats(),
        "endpoints": [
            "/health",
            "/analyze-email",
            "/suggest-priority",
            "/summarize",
            "/chat",
        ],
        "uptimeSec": round(time.time() - STARTED_AT),
    }
