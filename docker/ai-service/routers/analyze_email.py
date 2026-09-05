"""Orbit — routeur POST /analyze-email (extraction de rendez-vous).

Parité avec le mini-service bun (src/routers/analyze-email.ts) :
- garde-fou déterministe sur les participants (uniquement les adresses
  réellement citées dans l'email source, expéditeur inclus) ;
- correction d'année (un RDV email est toujours futur) ;
- cache mémoire 10 min (clé = hash du payload, « now » tronqué à l'heure).
Les bornes métier finales restent côté Next.js (suggestionFromExtracted).
"""

import re
from typing import List, Optional

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from models.schemas import AnalyzeEmailRequest
from services.cache import cache_get, cache_set
from services.ollama_client import default_client
from services.prompts import TEMPLATES, render
from services.utils import (
    LIMITS,
    fnv1a_hex,
    format_fr_long,
    hour_bucket,
    parse_json_loose,
    parse_now,
    sanitize,
)

router = APIRouter()

_EMAIL_RE = re.compile(r"[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}")


def _result_from_json(parsed: dict, now, subject: str, from_: str, body: str) -> dict:
    # ── Participants : l'IA peut inventer des adresses — on ne conserve QUE
    # les adresses réellement présentes dans l'email source (regex + filtre).
    source_lower = f"{subject}\n{from_}\n{body}".lower()
    input_emails = list(dict.fromkeys(_EMAIL_RE.findall(source_lower)))
    ai_attendees = [
        a.strip()[:254]
        for a in (parsed.get("attendees") or [])
        if isinstance(a, str) and "@" in a and a.strip().lower() in source_lower
    ]
    attendees = list(dict.fromkeys(input_emails + ai_attendees))[:10]

    # ── Année : un rendez-vous email est TOUJOURS futur.
    start_time = parsed.get("startTime") if isinstance(parsed.get("startTime"), str) else ""
    end_time = parsed.get("endTime") if isinstance(parsed.get("endTime"), str) else ""
    year_adjusted = False
    try:
        from datetime import datetime

        start_dt = datetime.fromisoformat(start_time.replace("Z", "+00:00"))
        delta_days = (now - start_dt).total_seconds() / 86400.0
        if delta_days > 90:
            candidate = start_dt.replace(year=now.year)
            if (candidate - now).total_seconds() > -86400.0:
                shift = (candidate - start_dt).total_seconds()
                start_time = candidate.isoformat()
                try:
                    end_dt = datetime.fromisoformat(end_time.replace("Z", "+00:00"))
                    if abs((end_dt - start_dt).total_seconds()) < 48 * 3600:
                        from datetime import timedelta

                        end_time = (end_dt + timedelta(seconds=shift)).isoformat()
                except ValueError:
                    pass
                year_adjusted = True
    except ValueError:
        pass

    location = parsed.get("location") if isinstance(parsed.get("location"), str) else None
    result = {
        "isEvent": parsed.get("isEvent") is not False,
        "title": (parsed.get("title") or "").strip()[:120] if isinstance(parsed.get("title"), str) else "",
        "description": (parsed.get("description") or "")[:500]
        if isinstance(parsed.get("description"), str)
        else "",
        "startTime": start_time,
        "endTime": end_time,
        "durationMinutes": parsed.get("durationMinutes") or 60,
        "location": location.strip()[:200] if location and location.strip() else None,
        "attendees": attendees,
        "confidence": parsed.get("confidence") or 0.5,
    }
    if year_adjusted:
        result["yearAdjusted"] = True
    return result


@router.post("/analyze-email")
async def analyze_email(req: AnalyzeEmailRequest) -> JSONResponse:
    subject = sanitize(req.subject, LIMITS["subject"])
    from_ = sanitize(req.from_, 320)
    body = sanitize(req.bodyText, LIMITS["emailBody"])
    if not subject and not body:
        return JSONResponse({"error": "subject ou bodyText requis"}, status_code=400)

    now = parse_now(req.now)
    timezone = sanitize(req.timezone, 64) or "Africa/Dakar"

    # ── Cache (payload utile + heure courante) ───────────────────────────────
    cache_key = "analyze:" + fnv1a_hex(
        f"{subject}|{from_}|{body}|{hour_bucket(now)}|{timezone}"
    )
    cached = cache_get(cache_key)
    if cached is not None:
        return JSONResponse({**cached, "cached": True})

    # ── Prompt système (template + interpolation) ────────────────────────────
    system = render(
        TEMPLATES["email_analysis"],
        NOW_FR=format_fr_long(now),
        NOW_ISO=now.isoformat(),
        TIMEZONE=timezone,
    )
    user = f"Objet : {subject}\nDe : {from_}\n\nCorps de l'email :\n{body}"

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
    if parsed is None:
        return JSONResponse(
            {
                "result": None,
                "provider": "ollama",
                "message": "Réponse non exploitable",
                "rawResponse": content[: LIMITS["rawResponse"]],
            }
        )

    result = _result_from_json(parsed, now, subject, from_, body)
    payload = {
        "result": result,
        "provider": "ollama",
        # Debug côté client (tronqué) — jamais loggé côté service.
        "rawResponse": content[: LIMITS["rawResponse"]],
    }
    cache_set(cache_key, payload)
    return JSONResponse(payload)
