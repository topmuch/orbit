"""Orbit — routeur POST /summarize (synthèse de contenu long).

Parité avec le mini-service bun (src/routers/summarize.ts) : styles
bullet_points | paragraph | key_points, longueur bornée en mots, cache 10 min,
repli « prose = résumé » si le JSON n'est pas exploitable.
"""

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from models.schemas import SummarizeRequest
from services.cache import cache_get, cache_set
from services.ollama_client import default_client
from services.prompts import STYLE_DESCRIPTIONS, TEMPLATES, render
from services.utils import (
    LIMITS,
    count_words,
    fnv1a_hex,
    format_fr_long,
    hour_bucket,
    parse_json_loose,
    parse_now,
    sanitize,
)

router = APIRouter()

_MIN_CONTENT_CHARS = 200


@router.post("/summarize")
async def summarize(req: SummarizeRequest) -> JSONResponse:
    content = sanitize(req.content, LIMITS["summarizeContent"])
    if len(content) < _MIN_CONTENT_CHARS:
        return JSONResponse(
            {"error": f"Contenu trop court pour une synthèse ({_MIN_CONTENT_CHARS} caractères minimum)"},
            status_code=400,
        )

    style = req.style if req.style in STYLE_DESCRIPTIONS else "bullet_points"
    max_length = req.maxLength
    now = parse_now(req.now)

    # ── Cache (contenu + style + longueur + heure courante) ──────────────────
    cache_key = "summarize:" + fnv1a_hex(
        f"{fnv1a_hex(content)}|{style}|{max_length}|{hour_bucket(now)}"
    )
    cached = cache_get(cache_key)
    if cached is not None:
        return JSONResponse({**cached, "cached": True})

    # ── Prompt système + contenu à synthétiser ───────────────────────────────
    system = render(
        TEMPLATES["summarization"],
        STYLE_DESCRIPTION=STYLE_DESCRIPTIONS[style],
        MAX_WORDS=str(max_length),
    )
    user = f"Date et heure actuelles : {format_fr_long(now)}.\n\nContenu à synthétiser :\n{content}"

    # ── Inférence : Ollama en mode JSON forcé ────────────────────────────────
    client = default_client()
    data = await client.generate(user, system, json_mode=True)
    if data is None:
        return JSONResponse(
            {
                "error": f"Ollama indisponible ({client.base_url}) — vérifiez que le modèle "
                f"{client.model} est téléchargé (ollama pull {client.model})"
            },
            status_code=502,
        )

    raw = data.get("response", "")
    parsed = parse_json_loose(raw)
    summary_from_json = parsed.get("summary", "").strip() if parsed else ""
    if not isinstance(summary_from_json, str):
        summary_from_json = ""
    # Repli tolérant : si le LLM répond en prose, le texte EST déjà la synthèse.
    summary = (summary_from_json or raw.strip()).strip("`\n")[: max_length * 8]

    if not summary:
        return JSONResponse(
            {
                "result": None,
                "provider": "ollama",
                "message": "Synthèse non exploitable",
                "rawResponse": raw[: LIMITS["rawResponse"]],
            }
        )

    result = {
        "summary": summary,
        "originalLength": count_words(content),
        "summaryLength": count_words(summary),
        "style": style,
    }
    payload = {"result": result, "provider": "ollama"}
    cache_set(cache_key, payload)
    return JSONResponse(payload)
