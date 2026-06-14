"""Copilot route — natural-language Q&A over the CRM."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.services.ai_copilot import ask
from app.services.brand import get_or_create_demo_brand

router = APIRouter(prefix="/copilot", tags=["copilot"])


class CopilotTurn(BaseModel):
    role: str = Field(..., pattern="^(user|assistant)$")
    content: str


class CopilotAskIn(BaseModel):
    question: str = Field(..., min_length=1, max_length=2000)
    history: list[CopilotTurn] = Field(default_factory=list)


@router.post("/ask")
def copilot_ask(payload: CopilotAskIn, db: Session = Depends(get_db)) -> dict:
    brand = get_or_create_demo_brand(db)
    return ask(
        db,
        brand.id,
        payload.question,
        history=[t.model_dump() for t in payload.history],
    )
