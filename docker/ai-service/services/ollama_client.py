"""Orbit — client Ollama (toute l'inférence est 100 % locale).

Équivalent Python de src/services/llm.ts du mini-service bun : Ollama UNIQUEMENT
(objectif de confidentialité — aucune donnée ne quitte la machine, aucun
fallback cloud en production).
"""

import json
import os
from typing import AsyncIterator, Optional

import httpx


class OllamaClient:
    """Client asynchrone pour l'API HTTP d'Ollama (/api/generate, /api/tags)."""

    def __init__(self, base_url: str, model: str, timeout: float = 90.0):
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.timeout = timeout  # secondes — garde-fou anti-blocage (60-90 s)

    # ── Complétion simple (mode JSON optionnel) ────────────────────────────

    async def generate(
        self,
        prompt: str,
        system: Optional[str] = None,
        *,
        json_mode: bool = False,
    ) -> Optional[dict]:
        """POST /api/generate — retourne le JSON de réponse d'Ollama
        (contient la clé « response »), ou None si indisponible/erreur."""
        payload: dict = {
            "model": self.model,
            "prompt": prompt,
            "stream": False,
            "options": {"temperature": 0.2},
        }
        if system:
            payload["system"] = system
        if json_mode:
            payload["format"] = "json"  # Ollama force une sortie JSON valide
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                res = await client.post(f"{self.base_url}/api/generate", json=payload)
                if res.status_code != 200:
                    return None
                return res.json()
        except httpx.HTTPError:
            # Ollama éteint, timeout, modèle absent… → indisponible.
            return None

    # ── Streaming (chat) ─────────────────────────────────────────────────────

    async def stream_tokens(
        self, prompt: str, system: Optional[str] = None
    ) -> Optional[AsyncIterator[str]]:
        """Flux NDJSON d'Ollama ({"response": "token"} par ligne) → générateur
        de tokens texte. None si Ollama est indisponible. La réponse HTTP et
        le client httpx sont refermés à l'épuisement du générateur."""
        payload: dict = {
            "model": self.model,
            "prompt": prompt,
            "stream": True,
            "options": {"temperature": 0.2},
        }
        if system:
            payload["system"] = system
        try:
            http = httpx.AsyncClient(timeout=self.timeout)
            req = http.build_request("POST", f"{self.base_url}/api/generate", json=payload)
            res = await http.send(req, stream=True)
            if res.status_code != 200:
                await res.aclose()
                await http.aclose()
                return None

            async def tokens() -> AsyncIterator[str]:
                try:
                    async for line in res.aiter_lines():
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            data = json.loads(line)
                            token = data.get("response")
                            if token:
                                yield token
                        except json.JSONDecodeError:
                            continue  # ligne NDJSON incomplète — ignorée
                finally:
                    await res.aclose()
                    await http.aclose()

            return tokens()
        except httpx.HTTPError:
            return None

    # ── Santé ────────────────────────────────────────────────────────────────

    async def is_healthy(self) -> bool:
        """GET /api/tags — true si Ollama répond (health-check)."""
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                res = await client.get(f"{self.base_url}/api/tags")
                return res.status_code == 200
        except httpx.HTTPError:
            return False


def default_client() -> OllamaClient:
    """Client construit depuis les variables d'environnement (sans état partagé :
    chaque routeur instancie le sien, aucune connexion n'est conservée)."""
    return OllamaClient(
        base_url=os.getenv("OLLAMA_URL", "http://localhost:11434").rstrip("/"),
        model=os.getenv("OLLAMA_MODEL", "llama3.1:8b"),
        timeout=float(os.getenv("OLLAMA_TIMEOUT_MS", "90000")) / 1000.0,
    )
