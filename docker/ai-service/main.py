# ═══════════════════════════════════════════════════════════════════════════
# Orbit — Micro-service IA (FastAPI, production)
# ───────────────────────────────────────────────────────────────────────────
# Expose le MÊME contrat REST que le mini-service bun de développement
# (mini-services/ai-service/index.ts) :
#
#   GET  /health        → { ok, provider, model, ollamaReachable, uptimeSec }
#   POST /analyze-email → extraction d'événement depuis un email (JSON)
#   POST /chat          → assistant en streaming (text/plain)
#
# Toute l'inférence est 100 % LOCALE via Ollama (http://ollama:11434 en
# docker compose, http://localhost:11434 en direct) : aucune donnée ne
# quitte la machine. Le fallback z-ai-web-dev-sdk de la sandbox est
# volontairement ABSENT ici (confidentialité stricte).
#
# Démarrage manuel (hors Docker) :
#   pip install -r requirements.txt
#   OLLAMA_URL=http://localhost:11434 OLLAMA_MODEL=llama3 \
#     uvicorn main:app --host 0.0.0.0 --port 3031
#
# Téléchargement du modèle :
#   ollama pull llama3
# ═══════════════════════════════════════════════════════════════════════════

import json
import re
import time
from datetime import datetime, timezone as dt_timezone
from typing import AsyncIterator, Optional

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

OLLAMA_URL = (os_url := __import__("os").getenv("OLLAMA_URL", "http://localhost:11434")).rstrip("/")
OLLAMA_MODEL = __import__("os").getenv("OLLAMA_MODEL", "llama3")
OLLAMA_TIMEOUT_MS = int(__import__("os").getenv("OLLAMA_TIMEOUT_MS", "90000"))

app = FastAPI(title="Orbit AI Service", version="1.0.0")
STARTED_AT = time.time()

# CORS permissif : appelé côté serveur par Next.js, diagnostic navigateur possible.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# ── Schémas Pydantic ────────────────────────────────────────────────────────


class AnalyzeEmailRequest(BaseModel):
    subject: str = ""
    from_: str = Field(default="", alias="from")
    bodyText: str = ""
    now: Optional[str] = None  # ISO — fourni par Next.js
    timezone: str = "Africa/Dakar"

    model_config = {"populate_by_name": True}


class ChatMessage(BaseModel):
    role: str = "user"
    content: str


class ChatRequest(BaseModel):
    system: str = (
        "Tu es Orbit, l'assistant personnel intelligent. "
        "Réponds en français, de façon concise et actionnable."
    )
    messages: list[ChatMessage]


# ── Utilitaires ─────────────────────────────────────────────────────────────

JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
MOIS = [
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre",
]


def format_fr_long(d: datetime) -> str:
    """Date/heure lisible en français (équivalent date-fns locale fr)."""
    return (
        f"{JOURS[d.weekday()]} {d.day} {MOIS[d.month - 1]} {d.year}, "
        f"{d.hour:02d}:{d.minute:02d}"
    )


def parse_json_loose(raw: str) -> Optional[dict]:
    """Extraction tolérante d'un JSON dans une réponse LLM
    (fencing markdown, texte autour…). Équivalent de parseJsonLoose côté bun."""
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        parsed = json.loads(raw[start : end + 1])
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        return None


def extraction_system_prompt(now: datetime, tz_name: str) -> str:
    # ⚠️ Duplicata synchronisé de src/lib/ai-prompts.ts et
    # mini-services/ai-service/index.ts — garder les trois en phase.
    return "\n".join(
        [
            "Tu es le moteur d'extraction d'Orbit : tu analyses des emails pour y détecter des rendez-vous, événements, échéances ou réservations.",
            "Réponds STRICTEMENT en JSON valide, sans aucun texte autour, au format :",
            '{"isEvent": true|false, "title": "titre court", "description": "résumé 1-2 phrases", "startTime": "ISO 8601", "endTime": "ISO 8601", "durationMinutes": 60, "confidence": 0.9}',
            "Règles :",
            "- isEvent = true uniquement si l'email mentionne une date/heure concrète d'un événement à mettre à l'agenda.",
            "- startTime/endTime en ISO 8601 avec décalage horaire, résolus à partir de la date actuelle fournie.",
            "- Si l'heure n'est pas précisée, utilise 09:00.",
            "- confidence entre 0 et 1 selon ta certitude.",
            f"- Date et heure actuelles : {format_fr_long(now)} (ISO : {now.isoformat()}). Fuseau de l'utilisateur : {tz_name} (UTC+0).",
        ]
    )


async def ollama_generate(
    system: str, prompt: str, *, json_mode: bool = False, stream: bool = False
) -> Optional[httpx.Response]:
    """Appelle POST {OLLAMA_URL}/api/generate. Retourne None si Ollama
    est indisponible (erreur réseau, timeout, modèle absent)."""
    payload: dict = {
        "model": OLLAMA_MODEL,
        "system": system,
        "prompt": prompt,
        "stream": stream,
        "options": {"temperature": 0.2},
    }
    if json_mode:
        payload["format"] = "json"  # Ollama force une sortie JSON valide
    try:
        async with httpx.AsyncClient() as client:
            return await client.post(
                f"{OLLAMA_URL}/api/generate",
                json=payload,
                timeout=OLLAMA_TIMEOUT_MS / 1000,
            )
    except httpx.HTTPError:
        return None


async def ollama_reachable() -> bool:
    try:
        async with httpx.AsyncClient() as client:
            res = await client.get(f"{OLLAMA_URL}/api/tags", timeout=2.0)
            return res.status_code == 200
    except httpx.HTTPError:
        return False


# ── GET /health ─────────────────────────────────────────────────────────────


@app.get("/health")
async def health():
    reachable = await ollama_reachable()
    return {
        "ok": True,
        "service": "orbit-ai-service",
        "provider": "ollama" if reachable else "unavailable",
        "model": OLLAMA_MODEL,
        "ollamaConfigured": True,
        "ollamaReachable": reachable,
        "uptimeSec": round(time.time() - STARTED_AT),
    }


# ── POST /analyze-email ─────────────────────────────────────────────────────


@app.post("/analyze-email")
async def analyze_email(req: AnalyzeEmailRequest) -> JSONResponse:
    if not req.subject and not req.bodyText:
        return JSONResponse({"error": "subject ou bodyText requis"}, status_code=400)

    now = (
        datetime.fromisoformat(req.now.replace("Z", "+00:00"))
        if req.now
        else datetime.now(dt_timezone.utc)
    )

    system = extraction_system_prompt(now, req.timezone)
    user = "\n".join(
        [
            f"Objet : {req.subject}",
            f"De : {req.from_}",
            "",
            "Corps de l'email :",
            req.bodyText[:4000],
        ]
    )

    res = await ollama_generate(system, user, json_mode=True)
    if res is None or res.status_code != 200:
        # En production locale : pas de fallback cloud — confidentialité stricte.
        return JSONResponse(
            {"error": f"Ollama indisponible ({OLLAMA_URL}) — vérifiez que le modèle {OLLAMA_MODEL} est téléchargé (ollama pull {OLLAMA_MODEL})"},
            status_code=502,
        )

    content = res.json().get("response", "")
    parsed = parse_json_loose(content)
    if parsed is None:
        return JSONResponse({"result": None, "provider": "ollama", "message": "Réponse non exploitable"})

    # Normalisation douce (les bornes métier restent côté Next.js)
    result = {
        "isEvent": parsed.get("isEvent") is not False,
        "title": str(parsed.get("title", "")).strip()[:120],
        "description": str(parsed.get("description", ""))[:500],
        "startTime": str(parsed.get("startTime", "")),
        "endTime": str(parsed.get("endTime", "")),
        "durationMinutes": parsed.get("durationMinutes") or 60,
        "confidence": parsed.get("confidence") or 0.5,
    }
    return JSONResponse({"result": result, "provider": "ollama"})


# ── POST /chat (streaming text/plain) ───────────────────────────────────────


@app.post("/chat")
async def chat(req: ChatRequest) -> StreamingResponse:
    if not req.messages:
        return JSONResponse({"error": "messages requis"}, status_code=400)

    # Ollama attend un prompt unique : on concatène l'historique.
    prompt = "\n\n".join(m.content for m in req.messages[-12:])
    res = await ollama_generate(req.system, prompt, stream=True)
    if res is None or res.status_code != 200:
        return JSONResponse(
            {"error": f"Ollama indisponible ({OLLAMA_URL})"},
            status_code=502,
        )

    async def token_stream() -> AsyncIterator[bytes]:
        """Transforme le flux NDJSON d'Ollama ({"response": "token"} par
        ligne) en flux texte brut — même format que le mini-service bun."""
        async for line in res.aiter_lines():
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
                token = data.get("response")
                if token:
                    yield token.encode("utf-8")
            except json.JSONDecodeError:
                continue  # ligne NDJSON incomplète

    return StreamingResponse(
        token_stream(),
        media_type="text/plain; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "X-Orbit-Provider": "ollama",
        },
    )
