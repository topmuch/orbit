"""Orbit — schémas Pydantic (contrat d'entrée du micro-service IA).

Mêmes champs et bornes que les interfaces du mini-service bun
(src/models/schemas.ts) : la validation stricte côté navigateur vit dans
Next.js (Zod) ; ici on borne tout ce qui part vers l'IA.
"""

from typing import List, Optional

from pydantic import BaseModel, ConfigDict, Field

from services.prompts import (
    SUMMARY_MAX_WORDS_DEFAULT,
    SUMMARY_MAX_WORDS_MAX,
    SUMMARY_MAX_WORDS_MIN,
)
from services.utils import LIMITS


class AnalyzeEmailRequest(BaseModel):
    """POST /analyze-email — extraction de rendez-vous."""

    subject: str = ""
    from_: str = Field(default="", alias="from")
    bodyText: str = ""
    now: Optional[str] = None  # ISO — fourni par Next.js
    timezone: str = "Africa/Dakar"

    model_config = ConfigDict(populate_by_name=True)


class UserContext(BaseModel):
    """Charge de travail de l'utilisateur (calculée par Next.js)."""

    totalTasks: int = Field(default=0, ge=0, le=9999)
    urgentTasks: int = Field(default=0, ge=0, le=9999)
    overdueTasks: int = Field(default=0, ge=0, le=9999)


class SuggestPriorityRequest(BaseModel):
    """POST /suggest-priority — suggestion de priorité de tâche."""

    taskTitle: str = Field(min_length=1, max_length=LIMITS["taskTitle"])
    taskDescription: str = Field(default="", max_length=LIMITS["taskDescription"])
    dueDate: Optional[str] = None  # ISO ou null
    userContext: UserContext = UserContext()
    now: Optional[str] = None
    timezone: str = "Africa/Dakar"


class SummarizeRequest(BaseModel):
    """POST /summarize — synthèse de contenu long."""

    content: str = Field(min_length=1, max_length=LIMITS["summarizeContent"])
    style: str = "bullet_points"
    maxLength: int = Field(
        default=SUMMARY_MAX_WORDS_DEFAULT, ge=SUMMARY_MAX_WORDS_MIN, le=SUMMARY_MAX_WORDS_MAX
    )
    now: Optional[str] = None


class ChatMessage(BaseModel):
    role: str = "user"
    content: str = Field(min_length=1, max_length=LIMITS["chatMessage"])


class ChatRequest(BaseModel):
    """POST /chat — assistant en streaming (le prompt système, avec le contexte
    utilisateur, est construit côté Next.js)."""

    system: str = ""
    messages: List[ChatMessage]
