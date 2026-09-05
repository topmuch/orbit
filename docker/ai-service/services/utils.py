"""Orbit — utilitaires partagés (parité avec src/utils.ts du mini-service bun)."""

import re
import unicodedata
from datetime import datetime, timezone as dt_timezone
from typing import Optional

_JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]
_MOIS = [
    "janvier", "février", "mars", "avril", "mai", "juin",
    "juillet", "août", "septembre", "octobre", "novembre", "décembre",
]

# Bornes de sanitization (parité LIMITS du mini-service bun).
LIMITS = {
    "subject": 500,
    "emailBody": 4000,
    "taskTitle": 200,
    "taskDescription": 2000,
    "summarizeContent": 12000,
    "chatMessage": 8000,
    "reasoning": 200,
    "rawResponse": 800,
}

# Caractères de contrôle (sauf \t \n) remplacés par des espaces.
_CTRL_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def sanitize(raw: Optional[str], max_length: int) -> str:
    """Nettoie une entrée avant envoi à l'IA : caractères de contrôle, trim, cap."""
    if not isinstance(raw, str):
        return ""
    return _CTRL_RE.sub(" ", raw).strip()[:max_length]


def parse_json_loose(raw: str) -> Optional[dict]:
    """Extraction tolérante d'un JSON dans une réponse LLM
    (fencing markdown, texte autour…). Équivalent de parseJsonLoose côté bun."""
    start = raw.find("{")
    end = raw.rfind("}")
    if start == -1 or end <= start:
        return None
    import json

    try:
        parsed = json.loads(raw[start : end + 1])
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        return None


def format_fr_long(d: datetime) -> str:
    """Date/heure lisible en français (équivalent date-fns locale fr)."""
    return (
        f"{_JOURS[d.weekday()]} {d.day} {_MOIS[d.month - 1]} {d.year}, "
        f"{d.hour:02d}:{d.minute:02d}"
    )


def parse_now(raw_now: Optional[str]) -> datetime:
    """Instant de référence fourni par Next.js (ou heure UTC courante)."""
    if raw_now:
        try:
            return datetime.fromisoformat(raw_now.replace("Z", "+00:00"))
        except ValueError:
            pass
    return datetime.now(dt_timezone.utc)


def hour_bucket(d: datetime) -> str:
    """Tronque un instant à l'heure (clé de cache stable)."""
    return f"{d.year}-{d.month}-{d.day}-{d.hour}"


def fnv1a_hex(s: str) -> str:
    """Hash FNV-1a 32 bits → hex (clé de cache compacte)."""
    h = 0x811C9DC5
    for ch in s:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


def count_words(text: str) -> int:
    return len([w for w in text.strip().split() if w])


def clamp_number(value, lo: float, hi: float, fallback: float) -> float:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return fallback
    return max(lo, min(hi, n))


def strip_accents_upper(s: str) -> str:
    """Majuscules sans accents (comparaison tolérante de priorités)."""
    return "".join(
        c for c in unicodedata.normalize("NFD", s.upper()) if unicodedata.category(c) != "Mn"
    )
