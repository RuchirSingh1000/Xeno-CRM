"""Segments API.

POST /segments/preview  — compile + execute a definition, return count + sample
POST /segments          — save a definition as a named, reusable Segment
GET  /segments          — list saved segments
GET  /segments/{id}     — fetch one
DELETE /segments/{id}   — delete one
GET  /segments/templates — pre-built definitions a marketer can clone
GET  /segments/variables — fields available for use in audience criteria
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Segment
from app.services.brand import get_or_create_demo_brand
from app.services.ai_segment_planner import plan_segment
from app.services.segment_engine import (
    PREBUILT_TEMPLATES,
    SegmentDefinition,
    count as segment_count,
    sample_with_reasons,
)

router = APIRouter(prefix="/segments", tags=["segments"])


class PreviewIn(BaseModel):
    definition: SegmentDefinition = Field(default_factory=SegmentDefinition)
    sample_limit: int = Field(5, ge=0, le=20)


class AIGenerateIn(BaseModel):
    prompt: str = Field(..., min_length=3, max_length=600)


@router.post("/ai-generate")
def ai_generate(payload: AIGenerateIn, db: Session = Depends(get_db)) -> dict:
    """Turn a natural-language marketer goal into a validated SegmentDefinition.

    Same Pydantic schema as the manual builder. The LLM proposes, the segment
    engine executes — there is no AI-only code path. Logs to ai_runs.
    """
    brand = get_or_create_demo_brand(db)
    run, definition, rationale = plan_segment(db, payload.prompt)
    total = segment_count(db, brand.id, definition)
    samples = sample_with_reasons(db, brand.id, definition, 5)
    return {
        "ai_run_id": run.id,
        "provider": run.provider,
        "model": run.model,
        "validation_status": run.validation_status,
        "latency_ms": run.latency_ms,
        "rationale": rationale,
        "definition": definition.model_dump(),
        "count": total,
        "sample": samples,
    }


@router.post("/preview")
def preview(payload: PreviewIn, db: Session = Depends(get_db)) -> dict:
    brand = get_or_create_demo_brand(db)
    total = segment_count(db, brand.id, payload.definition)
    samples = sample_with_reasons(db, brand.id, payload.definition, payload.sample_limit) if payload.sample_limit else []
    return {
        "count": total,
        "sample": samples,
        "definition": payload.definition.model_dump(),
    }


class SaveIn(BaseModel):
    name: str = Field(..., min_length=2, max_length=255)
    description: str | None = None
    definition: SegmentDefinition


@router.post("")
def save_segment(payload: SaveIn, db: Session = Depends(get_db)) -> dict:
    brand = get_or_create_demo_brand(db)
    total = segment_count(db, brand.id, payload.definition)
    seg = Segment(
        brand_id=brand.id,
        name=payload.name,
        description=payload.description,
        definition_json=payload.definition.model_dump(),
        preview_count=total,
        created_by_ai=False,
    )
    db.add(seg)
    db.commit()
    db.refresh(seg)
    return _segment_dict(seg)


@router.get("")
def list_segments(db: Session = Depends(get_db)) -> dict:
    brand = get_or_create_demo_brand(db)
    rows = (
        db.query(Segment)
        .filter(Segment.brand_id == brand.id)
        .order_by(Segment.id.desc())
        .all()
    )
    return {"segments": [_segment_dict(s) for s in rows]}


@router.get("/templates")
def list_templates() -> dict:
    return {"templates": PREBUILT_TEMPLATES}


@router.get("/variables")
def list_variables() -> dict:
    """Fields available for inclusion in audience_criteria. Frontend builder uses this."""
    return {
        "fields": [
            {"key": "last_order_days_min", "label": "Last order ≥ N days ago", "type": "int", "unit": "days"},
            {"key": "last_order_days_max", "label": "Last order ≤ N days ago", "type": "int", "unit": "days"},
            {"key": "ltv_min", "label": "Lifetime value ≥", "type": "float", "unit": "INR"},
            {"key": "ltv_max", "label": "Lifetime value ≤", "type": "float", "unit": "INR"},
            {"key": "total_orders_min", "label": "Total orders ≥", "type": "int"},
            {"key": "total_orders_max", "label": "Total orders ≤", "type": "int"},
            {"key": "cities", "label": "City is one of", "type": "string[]"},
            {"key": "loyalty_tiers", "label": "Loyalty tier is one of", "type": "enum[]", "options": ["bronze", "silver", "gold", "platinum"]},
            {"key": "min_source_coverage", "label": "Known across ≥ N sources", "type": "int", "max": 3},
        ]
    }


@router.get("/{segment_id}")
def get_segment(segment_id: int, db: Session = Depends(get_db)) -> dict:
    seg = db.get(Segment, segment_id)
    if not seg:
        raise HTTPException(status_code=404, detail="segment not found")
    return _segment_dict(seg)


@router.delete("/{segment_id}")
def delete_segment(segment_id: int, db: Session = Depends(get_db)) -> dict:
    seg = db.get(Segment, segment_id)
    if not seg:
        raise HTTPException(status_code=404, detail="segment not found")
    db.delete(seg)
    db.commit()
    return {"deleted": True}


def _segment_dict(s: Segment) -> dict:
    return {
        "id": s.id,
        "name": s.name,
        "description": s.description,
        "definition": s.definition_json,
        "preview_count": s.preview_count,
        "created_by_ai": s.created_by_ai,
        "created_at": s.created_at.isoformat() if s.created_at else None,
    }
