"""Post-run AI analyst: given a campaign's funnel + failure mix + segment + goal,
return a 3-bullet plain-English insight (what worked, what didn't, recommended next).

Same defendable pattern as the other AI surfaces:
  - Pydantic-validated output
  - One retry on validation failure
  - Deterministic fallback derived from the funnel arithmetic
  - Audit row in `ai_runs`
"""
from __future__ import annotations

import json
import time
from typing import Any

from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.ai.client import llm
from app.config import settings
from app.models import (
    AIRun,
    Campaign,
    Communication,
    CommunicationEvent,
    Segment,
)

PROMPT_VERSION = "campaign_analyst.v1"


class CampaignInsight(BaseModel):
    headline: str = Field(..., min_length=10, max_length=180,
                          description="One-line summary of the campaign outcome.")
    what_worked: str = Field(..., min_length=10, max_length=300)
    what_didnt: str = Field(..., min_length=10, max_length=300)
    next_action: str = Field(..., min_length=10, max_length=300,
                             description="Concrete recommendation a marketer can act on this week.")


SYSTEM_PROMPT = """You are a retail-marketing analyst for an Indian D2C brand.
You will receive a campaign's goal, segment summary, channel routing, funnel stats,
and failure reasons. Produce a short structured insight a marketer can act on.

Hard rules:
- Output STRICT JSON matching the requested schema. No prose, no markdown.
- Use the actual numbers from the input. Do not hallucinate channels or events.
- `what_worked` and `what_didnt` should each cite specific numbers or rates.
- `next_action` must be concrete and actionable this week (not "consider doing X").
- If conversion rate is 0 or very low, do not pretend the campaign was successful.
- Indian English. Neutral, concise. No emojis."""


def _gather_campaign_facts(db: Session, campaign: Campaign) -> dict[str, Any]:
    seg = db.get(Segment, campaign.segment_id) if campaign.segment_id else None
    comms = db.query(Communication).filter(Communication.campaign_id == campaign.id).all()
    by_status: dict[str, int] = {}
    by_channel: dict[str, int] = {}
    by_routing_reason: dict[str, int] = {}
    for c in comms:
        by_status[c.current_status] = by_status.get(c.current_status, 0) + 1
        if c.resolved_channel:
            by_channel[c.resolved_channel] = by_channel.get(c.resolved_channel, 0) + 1
        if c.routing_reason:
            by_routing_reason[c.routing_reason] = by_routing_reason.get(c.routing_reason, 0) + 1

    events_by_type = dict(
        db.query(CommunicationEvent.event_type, func.count(CommunicationEvent.id))
        .join(Communication, Communication.id == CommunicationEvent.communication_id)
        .filter(Communication.campaign_id == campaign.id)
        .group_by(CommunicationEvent.event_type)
        .all()
    )
    failure_reasons = dict(
        db.query(CommunicationEvent.failure_reason, func.count(CommunicationEvent.id))
        .join(Communication, Communication.id == CommunicationEvent.communication_id)
        .filter(
            Communication.campaign_id == campaign.id,
            CommunicationEvent.event_type == "failed",
            CommunicationEvent.failure_reason.isnot(None),
        )
        .group_by(CommunicationEvent.failure_reason)
        .all()
    )

    return {
        "campaign_name": campaign.name,
        "goal": campaign.goal,
        "status": campaign.status,
        "segment": {
            "name": seg.name if seg else None,
            "description": seg.description if seg else None,
            "preview_count_at_save": seg.preview_count if seg else None,
        },
        "total_targeted": campaign.total_targeted,
        "total_skipped": campaign.total_skipped,
        "by_status": by_status,
        "by_channel": by_channel,
        "by_routing_reason": by_routing_reason,
        "events_by_type": events_by_type,
        "failure_reasons": failure_reasons,
    }


def _deterministic_fallback(facts: dict[str, Any]) -> CampaignInsight:
    """Used when the LLM is unavailable or returns invalid JSON twice.

    Pulls real numbers from the facts to produce a sensible, plain-spoken
    summary. Not insightful, but never misleading."""
    total = facts.get("total_targeted", 0) or 0
    funnel = facts.get("events_by_type", {})
    delivered = funnel.get("delivered", 0)
    clicked = funnel.get("clicked", 0)
    converted = funnel.get("converted", 0)
    failed = funnel.get("failed", 0)
    by_channel = facts.get("by_channel", {})
    top_channel = max(by_channel.items(), key=lambda kv: kv[1], default=(None, 0))

    headline = f"{total} customers targeted. {converted} converted ({(converted/max(1,total))*100:.1f}%)."
    if delivered == 0:
        worked = "Deterministic fallback summary — no delivered events captured."
        didnt = f"{failed} failures observed." if failed else "No failures, but no deliveries either."
    else:
        worked = f"Routing covered {sum(by_channel.values())} customers across {len(by_channel)} channel(s); {top_channel[0]} took the largest share ({top_channel[1]})." if top_channel[0] else f"{delivered} of {total} customers received the message."
        didnt = f"Click-through stalled at {clicked} ({(clicked/max(1,delivered))*100:.1f}% of delivered)." if delivered else "—"
    return CampaignInsight(
        headline=headline[:180],
        what_worked=worked[:300],
        what_didnt=didnt[:300],
        next_action="Review the failure mix in the Event Log and try a tighter segment + a different message angle in the next test.",
    )


def analyze_campaign(db: Session, campaign: Campaign) -> tuple[AIRun, CampaignInsight]:
    facts = _gather_campaign_facts(db, campaign)

    started = time.time()
    raw_output = ""
    parsed: CampaignInsight | None = None
    validation_status = "ok"
    error_msg: str | None = None

    provider_used = settings.llm_provider if llm.has_credentials() else "stub"
    model_used = settings.model_for(provider_used)

    user_prompt = (
        f"Campaign facts:\n{json.dumps(facts, indent=2)}\n\n"
        f"Return JSON matching this schema:\n{json.dumps(CampaignInsight.model_json_schema(), indent=2)}"
    )

    try:
        result = llm.complete_json(
            system=SYSTEM_PROMPT,
            user=user_prompt,
            schema_hint=CampaignInsight.model_json_schema(),
        )
        if llm.last_used_provider:
            provider_used = llm.last_used_provider
            model_used = llm.last_used_model
        raw_output = json.dumps(result)
        try:
            parsed = CampaignInsight.model_validate(result)
        except ValidationError as ve:
            # Retry against the fallback provider (Groq when configured) —
            # re-asking the model that just returned garbage rarely helps.
            retry = user_prompt + f"\n\nPrevious response failed validation:\n{ve}\nReturn STRICT JSON."
            result2 = llm.complete_json(
                system=SYSTEM_PROMPT,
                user=retry,
                schema_hint=CampaignInsight.model_json_schema(),
                force_provider=settings.retry_provider,
            )
            if llm.last_used_provider:
                provider_used = llm.last_used_provider
                model_used = llm.last_used_model
            raw_output = json.dumps(result2)
            try:
                parsed = CampaignInsight.model_validate(result2)
                validation_status = "retry_used"
            except ValidationError as ve2:
                validation_status = "fallback_used"
                error_msg = f"validation failed twice: {ve2}"
                parsed = _deterministic_fallback(facts)
    except Exception as e:
        validation_status = "fallback_used"
        error_msg = f"{type(e).__name__}: {e}"
        parsed = _deterministic_fallback(facts)

    latency_ms = int((time.time() - started) * 1000)

    run = AIRun(
        purpose="campaign_analyst",
        prompt_version=PROMPT_VERSION,
        provider=provider_used,
        model=model_used,
        input_summary=f"campaign={campaign.id} '{campaign.name[:80]}'",
        raw_output=raw_output,
        parsed_output=parsed.model_dump() if parsed else None,
        validation_status=validation_status,
        error=error_msg,
        latency_ms=latency_ms,
    )
    db.add(run)
    # Cache the insight on the campaign too — UI shows it without re-calling LLM
    if parsed:
        campaign.ai_insight = json.dumps(parsed.model_dump())
    db.commit()
    db.refresh(run)
    return run, parsed or _deterministic_fallback(facts)
