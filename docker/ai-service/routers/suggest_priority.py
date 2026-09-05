"""Orbit — routeur POST /suggest-priority (suggestion de priorité de tâche).

Parité avec le mini-service bun (src/routers/suggest-priority.ts) : réponses
JSON strictes via le mode format=json d'Ollama + repli tolérant sur prose.
La persistance (aiSuggestedPriority/aiConfidence) reste côté Next.js.
"""

from typing import Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from models.schemas import SuggestPriorityRequest
from services.cache import cache_get, cache_set
from services.ollama_client import default_client
from services.prompts import TEMPLATES, render
from services.utils import (
    LIMITS,
    clamp_number,
    fnv1a_hex,
    format_fr_long,
    hour_bucket,
    parse_json_loose,
    parse_now,
    sanitize,
    strip_accents_upper,
)

router = APIRouter()

_PRIORITIES = ("LOW", "MEDIUM", "HIGH", "URGENT")


def _extract_priority_from_text(raw: str) -> Optional[dict]:
    """Repli tolérant quand le LLM répond en prose au lieu du JSON demandé :
    motif « priorité : X », token entre guillemets, ou un seul niveau distinct."""
    import re

    explicit = re.search(
        r"(?:priorit(?:é|y)|recommandation|suggestion|niveau)\s*(?:à|:|=|est)?\s*[\"«']?\s*"
        r"(URGENT|HIGH|MEDIUM|LOW)\b",
        raw,
        re.IGNORECASE,
    )
    if explicit:
        return {"suggestedPriority": explicit.group(1).upper(), "confidence": 0.5, "reasoning": ""}
    quoted = re.search(r'"(URGENT|HIGH|MEDIUM|LOW)"', raw)
    if quoted:
        return {"suggestedPriority": quoted.group(1), "confidence": 0.5, "reasoning": ""}

    distinct = set(re.findall(r"\b(URGENT|HIGH|MEDIUM|LOW)\b", raw))
    if len(distinct) == 1:
        return {"suggestedPriority": next(iter(distinct)), "confidence": 0.4, "reasoning": ""}
    return None


@router.post("/suggest-priority")
async def suggest_priority(req: SuggestPriorityRequest) -> JSONResponse:
    task_title = sanitize(req.taskTitle, LIMITS["taskTitle"])
    if not task_title:
        return JSONResponse({"error": "taskTitle requis"}, status_code=400)
    task_description = sanitize(req.taskDescription, LIMITS["taskDescription"])

    now = parse_now(req.now)
    timezone = sanitize(req.timezone, 64) or "Africa/Dakar"
    ctx = req.userContext

    # ── Cache (tâche + contexte + heure courante) ────────────────────────────
    cache_key = "priority:" + fnv1a_hex(
        f"{task_title}|{task_description}|{req.dueDate}|{ctx.totalTasks}|"
        f"{ctx.urgentTasks}|{ctx.overdueTasks}|{hour_bucket(now)}"
    )
    cached = cache_get(cache_key)
    if cached is not None:
        return JSONResponse({**cached, "cached": True})

    # ── Prompt système + contexte utilisateur ────────────────────────────────
    system = render(
        TEMPLATES["priority_suggestion"],
        NOW_FR=format_fr_long(now),
        NOW_ISO=now.isoformat(),
        TIMEZONE=timezone,
    )
    user = "\n".join(
        [
            "Tâche à prioriser :",
            f"- Titre : {task_title}",
            f"- Description : {task_description or '(aucune)'}",
            f"- Échéance : {req.dueDate or 'aucune'}",
            "",
            "Contexte de travail de l'utilisateur :",
            f"- {ctx.totalTasks} tâche(s) active(s) au total",
            f"- {ctx.urgentTasks} déjà en priorité URGENT",
            f"- {ctx.overdueTasks} en retard (échéance dépassée)",
        ]
    )

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

    content = data.get("response", "")
    parsed = parse_json_loose(content)
    raw_priority = strip_accents_upper(str(parsed.get("suggestedPriority", ""))) if parsed else ""

    result = None
    if parsed and raw_priority in _PRIORITIES:
        result = {
            "suggestedPriority": raw_priority,
            "confidence": clamp_number(parsed.get("confidence"), 0, 1, 0.5),
            "reasoning": (parsed.get("reasoning") or "").strip()[: LIMITS["reasoning"]]
            if isinstance(parsed.get("reasoning"), str)
            else "",
        }
    if result is None:
        result = _extract_priority_from_text(content)

    if result is None:
        return JSONResponse(
            {
                "result": None,
                "provider": "ollama",
                "message": "Priorité non reconnue dans la réponse IA",
                "rawResponse": content[: LIMITS["rawResponse"]],
            }
        )

    payload = {"result": result, "provider": "ollama"}
    cache_set(cache_key, payload)
    return JSONResponse(payload)
