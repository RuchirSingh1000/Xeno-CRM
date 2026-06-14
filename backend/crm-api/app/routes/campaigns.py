"""Campaigns API.

POST /campaigns               — create a draft campaign
GET  /campaigns               — list campaigns
GET  /campaigns/{id}          — fetch one with full detail
POST /campaigns/{id}          — update a draft
POST /campaigns/{id}/preview  — render template against a sample + routing breakdown
DELETE /campaigns/{id}        — delete a draft

The launch path lives in Phase 4 (channel simulator integration). Phase 3 stops
at preparing a campaign that's ready to launch.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db.session import get_db
from app.models import Campaign, Communication, CommunicationEvent, Segment
from app.services.ai_campaign_analyst import analyze_campaign
from app.services.ai_autopilot import suggest_next_campaign
from app.services.ai_campaign_planner import plan_campaign, regenerate_message
from app.services.brand import get_or_create_demo_brand
from app.services.campaign_launch import launch_campaign as do_launch_campaign, retry_queued as do_retry_queued
from app.services.channel_routing import DEFAULT_PRIORITY, VALID_CHANNELS, route_segment
from app.services.segment_engine import count as segment_count, sample_with_reasons
from app.services.segment_engine import (
    SegmentDefinition,
    sample as segment_sample,
)
from app.services.template import (
    ALLOWED_VARIABLES,
    build_context,
    length_feedback,
    render,
    validate_template,
)

router = APIRouter(prefix="/campaigns", tags=["campaigns"])


class ChannelPolicy(BaseModel):
    priority: list[str] = Field(default_factory=lambda: list(DEFAULT_PRIORITY))
    respect_consent: bool = True
    respect_dnd: bool = True


class CampaignIn(BaseModel):
    name: str = Field(..., min_length=2, max_length=255)
    goal: Optional[str] = None
    segment_id: int
    message_template: str = Field("", max_length=4096)
    channel_policy: ChannelPolicy = Field(default_factory=ChannelPolicy)


class AIPlanIn(BaseModel):
    goal: str = Field(..., min_length=3, max_length=600)


@router.post("/ai-plan")
def ai_plan(payload: AIPlanIn, db: Session = Depends(get_db)) -> dict:
    """NL goal → full campaign plan. Returns the plan PLUS a preview of the
    segment it produced (count + sample) so the marketer can size-check before
    creating a draft. The frontend then calls /campaigns/ai-plan/create to
    persist the draft."""
    brand = get_or_create_demo_brand(db)
    run, plan = plan_campaign(db, payload.goal)
    seg_def = plan.segment_definition
    total = segment_count(db, brand.id, seg_def)
    samples = sample_with_reasons(db, brand.id, seg_def, 5)
    return {
        "ai_run_id": run.id,
        "provider": run.provider,
        "model": run.model,
        "latency_ms": run.latency_ms,
        "validation_status": run.validation_status,
        "plan": plan.model_dump(),
        "segment_preview": {"count": total, "sample": samples},
    }


class AIRegenMessageIn(BaseModel):
    goal: str = Field(..., min_length=3, max_length=600)
    message_angle: str = Field("", max_length=300)
    previous_template: str = Field("", max_length=4096)
    channel_priority: list[str] = Field(default_factory=list)


@router.post("/ai-plan/regenerate-message")
def ai_plan_regenerate_message(payload: AIRegenMessageIn, db: Session = Depends(get_db)) -> dict:
    """Re-roll just the message template. Same goal + angle, different copy."""
    run, template = regenerate_message(
        db,
        nl_goal=payload.goal,
        message_angle=payload.message_angle,
        previous_template=payload.previous_template,
        channel_priority=payload.channel_priority,
    )
    return {
        "ai_run_id": run.id,
        "provider": run.provider,
        "model": run.model,
        "latency_ms": run.latency_ms,
        "validation_status": run.validation_status,
        "message_template": template,
    }


class AIPlanCreateIn(BaseModel):
    goal: str = Field(..., min_length=3, max_length=600)
    name: str
    rationale: str | None = None
    segment_definition: dict
    channel_priority: list[str]
    message_template: str
    message_angle: str | None = None
    success_metric: str | None = None
    suppression_notes: str | None = None
    ai_run_id: int | None = None


@router.post("/ai-plan/create")
def ai_plan_create(payload: AIPlanCreateIn, db: Session = Depends(get_db)) -> dict:
    """Persist an AI-generated plan as a Segment + Campaign draft.

    The marketer reviews the AI plan in the UI, optionally edits it, then
    clicks Create — the AI's output flows through the same Segment/Campaign
    storage as a hand-built draft. There is no AI-only execution path."""
    from app.models import Segment
    from app.services.segment_engine import SegmentDefinition
    brand = get_or_create_demo_brand(db)

    sdef = SegmentDefinition.model_validate(payload.segment_definition)
    total = segment_count(db, brand.id, sdef)
    seg = Segment(
        brand_id=brand.id,
        name=f"[AI] {payload.name[:200]}",
        description=payload.rationale,
        definition_json=sdef.model_dump(),
        preview_count=total,
        created_by_ai=True,
    )
    db.add(seg)
    db.flush()

    camp = Campaign(
        brand_id=brand.id,
        name=payload.name,
        goal=payload.goal,
        segment_id=seg.id,
        channel_policy_json={
            "priority": [c for c in payload.channel_priority if c in VALID_CHANNELS] or list(DEFAULT_PRIORITY),
            "respect_consent": True,
            "respect_dnd": True,
        },
        message_template=payload.message_template,
        ai_plan_json={
            "ai_run_id": payload.ai_run_id,
            "message_angle": payload.message_angle,
            "success_metric": payload.success_metric,
            "suppression_notes": payload.suppression_notes,
        },
        status="draft",
    )
    db.add(camp)
    db.commit()
    db.refresh(camp)
    return {"campaign_id": camp.id, "segment_id": seg.id}


@router.post("")
def create_campaign(payload: CampaignIn, db: Session = Depends(get_db)) -> dict:
    brand = get_or_create_demo_brand(db)
    seg = db.query(Segment).filter(Segment.id == payload.segment_id, Segment.brand_id == brand.id).first()
    if not seg:
        raise HTTPException(status_code=404, detail="segment not found")

    camp = Campaign(
        brand_id=brand.id,
        name=payload.name,
        goal=payload.goal,
        segment_id=seg.id,
        channel_policy_json=payload.channel_policy.model_dump(),
        message_template=payload.message_template,
        status="draft",
    )
    db.add(camp)
    db.commit()
    db.refresh(camp)
    return _campaign_dict(camp, seg)


@router.post("/{campaign_id}")
def update_campaign(campaign_id: int, payload: CampaignIn, db: Session = Depends(get_db)) -> dict:
    brand = get_or_create_demo_brand(db)
    camp = db.query(Campaign).filter(Campaign.id == campaign_id, Campaign.brand_id == brand.id).first()
    if not camp:
        raise HTTPException(status_code=404, detail="campaign not found")
    seg = db.query(Segment).filter(Segment.id == payload.segment_id, Segment.brand_id == brand.id).first()
    if not seg:
        raise HTTPException(status_code=404, detail="segment not found")
    camp.name = payload.name
    camp.goal = payload.goal
    camp.segment_id = seg.id
    camp.channel_policy_json = payload.channel_policy.model_dump()
    camp.message_template = payload.message_template
    db.commit()
    db.refresh(camp)
    return _campaign_dict(camp, seg)


@router.get("")
def list_campaigns(db: Session = Depends(get_db)) -> dict:
    brand = get_or_create_demo_brand(db)
    rows = (
        db.query(Campaign)
        .filter(Campaign.brand_id == brand.id)
        .order_by(Campaign.id.desc())
        .all()
    )
    out = []
    for c in rows:
        seg = db.get(Segment, c.segment_id) if c.segment_id else None
        out.append(_campaign_dict(c, seg))
    return {"campaigns": out}


@router.get("/{campaign_id}")
def get_campaign(campaign_id: int, db: Session = Depends(get_db)) -> dict:
    brand = get_or_create_demo_brand(db)
    camp = db.query(Campaign).filter(Campaign.id == campaign_id, Campaign.brand_id == brand.id).first()
    if not camp:
        raise HTTPException(status_code=404, detail="campaign not found")
    seg = db.get(Segment, camp.segment_id) if camp.segment_id else None
    return _campaign_dict(camp, seg)


@router.delete("/{campaign_id}")
def delete_campaign(campaign_id: int, db: Session = Depends(get_db)) -> dict:
    brand = get_or_create_demo_brand(db)
    camp = db.query(Campaign).filter(Campaign.id == campaign_id, Campaign.brand_id == brand.id).first()
    if not camp:
        raise HTTPException(status_code=404, detail="campaign not found")
    db.delete(camp)
    db.commit()
    return {"deleted": True}


@router.post("/{campaign_id}/cancel-stuck")
def cancel_stuck(campaign_id: int, db: Session = Depends(get_db)) -> dict:
    """Mark any communications still in `queued` (or `sent` without follow-up)
    as `failed` with a synthetic 'webhook_lost' reason.

    Used to clean up campaigns where the simulator's webhooks timed out on the
    CRM and were dropped. Lets the campaign reach `completed` so the funnel
    isn't permanently stuck.
    """
    from datetime import datetime, timezone
    brand = get_or_create_demo_brand(db)
    camp = db.query(Campaign).filter(Campaign.id == campaign_id, Campaign.brand_id == brand.id).first()
    if not camp:
        raise HTTPException(status_code=404, detail="campaign not found")

    stuck = (
        db.query(Communication)
        .filter(
            Communication.campaign_id == campaign_id,
            Communication.current_status.in_(["queued", "sent"]),
        )
        .all()
    )
    n = 0
    for c in stuck:
        c.current_status = "failed"
        c.last_event_at = datetime.now(timezone.utc)
        n += 1
    if n > 0:
        camp.status = "completed"
        camp.completed_at = datetime.now(timezone.utc)
    db.commit()
    return {"cancelled": n, "campaign_status": camp.status}


@router.post("/{campaign_id}/launch")
def launch_campaign(campaign_id: int, db: Session = Depends(get_db)) -> dict:
    """Promote a draft to running. Creates Communications, calls the simulator's
    /send for each, returns the dispatch summary. Webhooks arrive asynchronously."""
    brand = get_or_create_demo_brand(db)
    camp = db.query(Campaign).filter(Campaign.id == campaign_id, Campaign.brand_id == brand.id).first()
    if not camp:
        raise HTTPException(status_code=404, detail="campaign not found")
    return do_launch_campaign(db, brand.name, camp)


@router.post("/{campaign_id}/retry-queued")
def retry_queued_route(campaign_id: int, db: Session = Depends(get_db)) -> dict:
    """Re-dispatch communications stuck in queued/sent. Fresh provider_message_ids."""
    brand = get_or_create_demo_brand(db)
    camp = db.query(Campaign).filter(Campaign.id == campaign_id, Campaign.brand_id == brand.id).first()
    if not camp:
        raise HTTPException(status_code=404, detail="campaign not found")
    return do_retry_queued(db, camp, brand.name)


@router.post("/{campaign_id}/autopilot/next")
def campaign_autopilot_next(campaign_id: int, db: Session = Depends(get_db)) -> dict:
    """Autopilot: given a campaign, run analyst → derive follow-up goal → planner,
    return everything the UI needs to show the suggestion and accept it as a draft."""
    brand = get_or_create_demo_brand(db)
    camp = db.query(Campaign).filter(Campaign.id == campaign_id, Campaign.brand_id == brand.id).first()
    if not camp:
        raise HTTPException(status_code=404, detail="campaign not found")
    return suggest_next_campaign(db, camp)


@router.post("/{campaign_id}/insight")
def campaign_insight(campaign_id: int, db: Session = Depends(get_db)) -> dict:
    """Generate (or refresh) the AI post-run insight for this campaign."""
    brand = get_or_create_demo_brand(db)
    camp = db.query(Campaign).filter(Campaign.id == campaign_id, Campaign.brand_id == brand.id).first()
    if not camp:
        raise HTTPException(status_code=404, detail="campaign not found")
    run, insight = analyze_campaign(db, camp)
    return {
        "ai_run_id": run.id,
        "provider": run.provider,
        "model": run.model,
        "latency_ms": run.latency_ms,
        "validation_status": run.validation_status,
        "insight": insight.model_dump(),
    }


@router.get("/{campaign_id}/funnel")
def campaign_funnel(campaign_id: int, db: Session = Depends(get_db)) -> dict:
    """Live funnel: counts of communications in each lifecycle state, plus
    aggregated event-type counts and skipped-reason breakdown."""
    from sqlalchemy import func
    brand = get_or_create_demo_brand(db)
    camp = db.query(Campaign).filter(Campaign.id == campaign_id, Campaign.brand_id == brand.id).first()
    if not camp:
        raise HTTPException(status_code=404, detail="campaign not found")

    comms = db.query(Communication).filter(Communication.campaign_id == campaign_id).all()
    by_status: dict[str, int] = {}
    by_channel: dict[str, int] = {}
    for c in comms:
        by_status[c.current_status] = by_status.get(c.current_status, 0) + 1
        if c.resolved_channel:
            by_channel[c.resolved_channel] = by_channel.get(c.resolved_channel, 0) + 1

    # Derive the funnel from current_status — the SoT — not from raw event
    # counts. current_status is computed from max(sequence) per comm so it
    # always reflects the deepest stage reached, even if intermediate webhooks
    # were lost. This guarantees funnel math obeys lifecycle invariants:
    #   sent >= delivered + failed         (failed is a sibling of delivered)
    #   delivered >= viewed >= clicked >= converted
    #
    # opened and read are MUTUALLY EXCLUSIVE per comm in the simulator:
    # email channels emit "opened", whatsapp/rcs emit "read", sms emits neither.
    # Showing them as separate funnel rows misleads a marketer into thinking
    # one is a subset of the other. We collapse into a single "viewed" stage
    # for the funnel display; the by_channel breakdown elsewhere preserves the
    # channel-specific detail.
    n = {row[0]: row[1] for row in by_status.items()}
    n_queued = n.get("queued", 0)
    n_sent = n.get("sent", 0)
    n_delivered = n.get("delivered", 0)
    n_opened = n.get("opened", 0)
    n_read = n.get("read", 0)
    n_clicked = n.get("clicked", 0)
    n_converted = n.get("converted", 0)
    n_failed = n.get("failed", 0)

    # Cumulative reach in lifecycle order
    sent_reached = n_sent + n_delivered + n_opened + n_read + n_clicked + n_converted + n_failed
    delivered_reached = n_delivered + n_opened + n_read + n_clicked + n_converted
    # "viewed" = opened OR read. SMS comms that clicked without a view event
    # are conservatively included since their click implies awareness.
    viewed_reached = n_opened + n_read + n_clicked + n_converted
    clicked_reached = n_clicked + n_converted
    converted_reached = n_converted
    failed_reached = n_failed

    funnel = {
        "sent": sent_reached,
        "delivered": delivered_reached,
        "viewed": viewed_reached,
        "clicked": clicked_reached,
        "converted": converted_reached,
        "failed": failed_reached,
    }
    funnel = {k: v for k, v in funnel.items() if v > 0}

    # Failure reasons
    failure_rows = (
        db.query(CommunicationEvent.failure_reason, func.count(CommunicationEvent.id))
        .join(Communication, Communication.id == CommunicationEvent.communication_id)
        .filter(Communication.campaign_id == campaign_id, CommunicationEvent.event_type == "failed")
        .group_by(CommunicationEvent.failure_reason)
        .all()
    )
    failure_reasons = dict(failure_rows)

    return {
        "campaign_id": campaign_id,
        "status": camp.status,
        "total_targeted": camp.total_targeted,
        "total_skipped": camp.total_skipped,
        "by_status": by_status,
        "by_channel": by_channel,
        "funnel": funnel,
        "failure_reasons": failure_reasons,
        "launched_at": camp.launched_at.isoformat() if camp.launched_at else None,
        "completed_at": camp.completed_at.isoformat() if camp.completed_at else None,
    }


@router.post("/{campaign_id}/preview")
def preview_campaign(campaign_id: int, db: Session = Depends(get_db)) -> dict:
    """Return a rich preview: template validation, sample renders per channel,
    and the deterministic routing breakdown across the segment."""
    brand = get_or_create_demo_brand(db)
    camp = db.query(Campaign).filter(Campaign.id == campaign_id, Campaign.brand_id == brand.id).first()
    if not camp:
        raise HTTPException(status_code=404, detail="campaign not found")
    seg = db.get(Segment, camp.segment_id) if camp.segment_id else None
    if not seg:
        raise HTTPException(status_code=400, detail="campaign has no segment")

    definition = SegmentDefinition.model_validate(seg.definition_json or {})
    priority: list[str] = (camp.channel_policy_json or {}).get("priority", list(DEFAULT_PRIORITY))
    # Filter to valid channels only
    priority = [p for p in priority if p in VALID_CHANNELS] or list(DEFAULT_PRIORITY)

    template_report = validate_template(camp.message_template or "")

    # Sample renders against the first few segment members
    samples = segment_sample(db, brand.id, definition, limit=3)
    rendered_samples = []
    for c in samples:
        ctx = build_context(c, brand.name)
        text = render(camp.message_template or "", ctx)
        per_channel = {
            ch: length_feedback(text, ch) for ch in priority if ch in VALID_CHANNELS
        }
        rendered_samples.append({
            "customer": {
                "id": c.id,
                "master_customer_id": c.master_customer_id,
                "full_name": c.full_name,
                "city": c.city,
            },
            "context_used": ctx,
            "rendered": text,
            "length_per_channel": per_channel,
        })

    routing = route_segment(db, brand.id, definition, priority)

    return {
        "campaign_id": camp.id,
        "template_report": template_report,
        "allowed_variables": ALLOWED_VARIABLES,
        "samples": rendered_samples,
        "routing_breakdown": routing,
    }


def _campaign_dict(c: Campaign, seg: Segment | None) -> dict:
    return {
        "id": c.id,
        "name": c.name,
        "goal": c.goal,
        "status": c.status,
        "segment": {
            "id": seg.id if seg else None,
            "name": seg.name if seg else None,
            "preview_count": seg.preview_count if seg else 0,
        } if seg else None,
        "channel_policy": c.channel_policy_json or {},
        "message_template": c.message_template or "",
        "ai_plan": c.ai_plan_json,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "launched_at": c.launched_at.isoformat() if c.launched_at else None,
    }
