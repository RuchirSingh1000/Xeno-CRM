"""AI runs audit page endpoint.

Every LLM call lands in `ai_runs`. This route exposes them for the frontend
audit page — a rare-in-this-pool signal of "I think about AI engineering, not
just AI features."
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.config import settings
from app.db.session import get_db
from app.models import AIRun
from sqlalchemy import delete

router = APIRouter(prefix="/ai-runs", tags=["ai-runs"])


@router.get("")
def list_runs(
    db: Session = Depends(get_db),
    limit: int = Query(50, ge=1, le=200),
    purpose: str | None = None,
) -> dict:
    q = db.query(AIRun).order_by(AIRun.id.desc())
    if purpose:
        q = q.filter(AIRun.purpose == purpose)
    total = q.count()
    rows = q.limit(limit).all()
    return {
        "total": total,
        "runs": [
            {
                "id": r.id,
                "purpose": r.purpose,
                "prompt_version": r.prompt_version,
                "provider": r.provider,
                "model": r.model,
                "input_summary": r.input_summary,
                "raw_output": r.raw_output,
                "parsed_output": r.parsed_output,
                "validation_status": r.validation_status,
                "error": r.error,
                "latency_ms": r.latency_ms,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ],
        "provider_status": {
            "configured_provider": settings.llm_provider,
            "has_anthropic_key": bool(settings.anthropic_api_key),
            "has_openai_key": bool(settings.openai_api_key),
            "has_gemini_key": bool(settings.gemini_api_key),
            "has_groq_key": bool(settings.groq_api_key),
            "effective_provider": (
                "anthropic" if settings.llm_provider == "anthropic" and settings.anthropic_api_key
                else "openai" if settings.llm_provider == "openai" and settings.openai_api_key
                else "gemini" if settings.llm_provider == "gemini" and settings.gemini_api_key
                else "groq" if settings.llm_provider == "groq" and settings.groq_api_key
                else "stub"
            ),
            "fallback_provider": "groq" if settings.groq_api_key and settings.llm_provider != "groq" else None,
        },
    }


@router.delete("")
def clear_runs(
    db: Session = Depends(get_db),
    purpose: str | None = None,
    status: str | None = None,
) -> dict:
    """Wipe AI runs from the audit table.

    Useful for resetting the demo state before recording. Optional filters:
    - `purpose` (e.g. campaign_planner) clears only one surface's history
    - `status` (e.g. fallback_used) clears only that validation outcome
    """
    q = db.query(AIRun)
    if purpose:
        q = q.filter(AIRun.purpose == purpose)
    if status:
        q = q.filter(AIRun.validation_status == status)
    deleted = q.count()
    q.delete(synchronize_session=False)
    db.commit()
    return {"deleted": deleted}
