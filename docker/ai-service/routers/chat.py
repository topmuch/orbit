"""Orbit — routeur POST /chat (assistant en streaming text/plain).

Parité avec le mini-service bun (src/routers/chat.ts) : le prompt système
(contexte agenda + tâches de l'utilisateur) est construit côté Next.js ;
chat.txt fournit le défaut. Ollama attend un prompt unique — on concatène
l'historique. Pas de cache : chaque conversation est unique par nature.
"""

from typing import AsyncIterator

from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse

from models.schemas import ChatRequest
from services.ollama_client import default_client
from services.prompts import TEMPLATES
from services.utils import LIMITS, sanitize

router = APIRouter()

_STREAM_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
    "X-Orbit-Provider": "ollama",
}


@router.post("/chat")
async def chat(req: ChatRequest):
    system = (
        req.system.strip()[:12000]
        if req.system and req.system.strip()
        else TEMPLATES["chat"]
    )

    messages = [
        {"role": "assistant" if m.role == "assistant" else "user", "content": sanitize(m.content, LIMITS["chatMessage"])}
        for m in req.messages[-12:]
        if m.content.strip()
    ]
    if not messages:
        return JSONResponse({"error": "messages requis"}, status_code=400)

    client = default_client()
    # Ollama attend un prompt unique : on concatène l'historique.
    prompt = "\n\n".join(m["content"] for m in messages)
    tokens = await client.stream_tokens(prompt, system)
    if tokens is None:
        return JSONResponse(
            {
                "error": f"Ollama indisponible ({client.base_url}) — vérifiez que le modèle "
                f"{client.model} est téléchargé (ollama pull {client.model})"
            },
            status_code=502,
        )

    async def token_stream() -> AsyncIterator[bytes]:
        """Le générateur d'OllamaClient referme lui-même la réponse HTTP amont."""
        async for token in tokens:
            yield token.encode("utf-8")

    return StreamingResponse(
        token_stream(),
        media_type="text/plain; charset=utf-8",
        headers=_STREAM_HEADERS,
    )
