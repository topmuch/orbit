"""Orbit — chargement des prompts (prompts/*.txt) + interpolation.

Les prompts système vivent dans des fichiers .txt éditables sans toucher au
code — CONTENUS IDENTIQUES au mini-service bun (mini-services/ai-service/prompts).
Placeholders {{CLE}} interpolés par render().
"""

import re
from pathlib import Path

PROMPTS_DIR = Path(__file__).resolve().parent.parent / "prompts"

# Repli interne si un fichier manque (le service reste opérationnel).
_FALLBACKS = {
    "email_analysis.txt": "Tu es le moteur d'extraction d'Orbit. Réponds STRICTEMENT en JSON : "
    '{"isEvent": false, "title": "", "description": "", "startTime": null, "endTime": null, '
    '"durationMinutes": null, "location": null, "attendees": [], "confidence": 0}',
    "priority_suggestion.txt": "Tu es l'assistant de priorisation d'Orbit. Réponds STRICTEMENT en JSON : "
    '{"suggestedPriority": "LOW|MEDIUM|HIGH|URGENT", "confidence": 0.8, "reasoning": "courte explication"}',
    "summarization.txt": "Tu es le moteur de synthèse d'Orbit. Réponds STRICTEMENT en JSON : "
    '{"summary": "texte du résumé"}',
    "chat.txt": (
        "Tu es Orbit, l'assistant personnel intelligent. "
        "Réponds en français, de façon concise et actionnable."
    ),
}


def load_template(name: str) -> str:
    try:
        raw = (PROMPTS_DIR / name).read_text(encoding="utf-8")
        if raw.strip():
            return raw
    except OSError:
        pass
    return _FALLBACKS.get(name, "")


def render(template: str, **variables: str) -> str:
    """Interpolation {{CLE}} → valeur. Les clés absentes sont supprimées."""

    def _replace(match: "re.Match[str]") -> str:
        return variables.get(match.group(1), "")

    return re.sub(r"\{\{([A-Z0-9_]+)\}\}", _replace, template)


# Templates chargés une fois au démarrage du process.
TEMPLATES = {
    "email_analysis": load_template("email_analysis.txt"),
    "priority_suggestion": load_template("priority_suggestion.txt"),
    "summarization": load_template("summarization.txt"),
    "chat": load_template("chat.txt"),
}

# Descriptions de style (mêmes libellés que le mini-service bun).
STYLE_DESCRIPTIONS = {
    "bullet_points": "liste à puces de 3 à 7 points, chaque puce sur sa propre ligne commençant par « • »",
    "paragraph": "un paragraphe compact et fluide, sans liste",
    "key_points": "3 à 5 points clés séparés par des sauts de ligne, chacun préfixé par « — »",
}

SUMMARY_MAX_WORDS_DEFAULT = 150
SUMMARY_MAX_WORDS_MIN = 30
SUMMARY_MAX_WORDS_MAX = 600
