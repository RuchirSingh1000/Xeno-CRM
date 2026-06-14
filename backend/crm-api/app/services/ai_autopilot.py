"""Campaign Autopilot — close the loop from one campaign's results to the next campaign's plan.

The brief's last AI-native example is "a true AI agent that takes a broad goal and
executes the campaign end to end". We have the pieces separately — analyst (post-run
insight) and planner (NL goal → segment + message + channels). This stitches them:

  1. Gather facts about the completed (or running) campaign.
  2. Run the analyst to get a structured insight (what worked / didn't / next).
  3. Derive a natural-language goal for a *follow-up* campaign from that insight.
     The derivation itself is an LLM call (so the suggestion considers the original
     campaign's intent + the funnel mix + the segment overlap to avoid).
  4. Feed that derived goal into the existing campaign planner.
  5. Return both the insight and the new plan to the UI as a one-click action.

Why a separate derivation step (3) instead of just asking the analyst for a goal:
- Keeps each AI call narrow (one job, one schema), which is what makes them reliable.
- Lets us audit the chain — each step lands as its own ai_runs row, so a reviewer
  can see the full reasoning trail without us logging blob JSON.
- The follow-up goal is short and stable; the planner needs the long structured
  output. Decoupling means we can tune one without re-tuning the other.

Cost is one extra LLM round-trip per "next?" click. Acceptable — this is an
operator action, not a hot path.
"""
from __future__ import annotations

import json
import time
from typing import Any

from pydantic import BaseModel, Field, ValidationError
from sqlalchemy.orm import Session

from app.ai.client import llm
from app.config import settings
from app.models import AIRun, Campaign
from app.services.ai_campaign_analyst import analyze_campaign
from app.services.ai_campaign_planner import plan_campaign


PROMPT_VERSION = "autopilot.followup_goal.v1"


class FollowupGoal(BaseModel):
    """Single-sentence next-campaign goal, derived from a completed campaign's insight."""
    goal: str = Field(
        ..., min_length=20, max_length=400,
        description="A complete natural-language campaign goal the marketer could paste into the planner. Names the audience, the offer or angle, and the channel preference.",
    )
    rationale: str = Field(
        ..., min_length=10, max_length=300,
        description="One sentence on why this is the right next move given the prior campaign's outcome.",
    )


SYSTEM_PROMPT = """You are a senior retail-marketing strategist for an Indian D2C brand (Brewhouse Co.).
The marketer just finished one campaign. They want to know what to do NEXT.

You will receive the previous campaign's goal, segment, channel mix, funnel numbers, and an
analyst's plain-English insight. Produce a single natural-language goal for a follow-up
campaign — one sentence the planner can turn into a full plan.

Hard rules:
- Output STRICT JSON: { "goal": "...", "rationale": "..." }. No prose, no markdown.
- The follow-up should LEARN from the prior outcome:
  - If conversion was strong, target the *adjacent* audience (similar tier/recency) to expand.
  - If conversion was weak but delivery was strong, change the angle or offer.
  - If delivery itself was weak, narrow the audience to those with stronger channel consent.
  - If failures spiked on a specific reason (DND, opt-out, invalid), suppress that segment.
- Name the audience tightly. Reference the channel that performed best, if obvious.
- Don't repeat the previous campaign verbatim. The point is a sequel, not a retry.
- Indian English. Concrete. No hedging."""


def _derive_followup_goal(
    db: Session, campaign: Campaign, insight_dict: dict[str, Any]
) -> tuple[AIRun, FollowupGoal]:
    """LLM call #2 in the chain — turn an insight into a next-campaign NL goal."""
    started = time.time()
    raw_output = ""
    parsed: FollowupGoal | None = None
    validation_status = "ok"
    error_msg: str | None = None
    provider_used = settings.llm_provider if llm.has_credentials() else "stub"
    model_used = settings.model_for(provider_used)

    user_prompt = (
        f"Previous campaign name: {campaign.name}\n"
        f"Previous campaign goal: {campaign.goal or '(none)'}\n"
        f"Insight from analyst:\n{json.dumps(insight_dict, indent=2)}\n\n"
        "Return JSON: { \"goal\": \"...\", \"rationale\": \"...\" }"
    )

    try:
        result = llm.complete_json(
            system=SYSTEM_PROMPT,
            user=user_prompt,
            schema_hint=FollowupGoal.model_json_schema(),
        )
        if llm.last_used_provider:
            provider_used = llm.last_used_provider
            model_used = llm.last_used_model
        raw_output = json.dumps(result)
        try:
            parsed = FollowupGoal.model_validate(result)
        except ValidationError as ve:
            validation_status = "fallback_used"
            error_msg = f"validation failed: {ve}"
    except Exception as e:
        validation_status = "fallback_used"
        error_msg = f"{type(e).__name__}: {e}"

    if parsed is None:
        # Deterministic fallback: build a goal from the campaign's segment + insight headline.
        headline = insight_dict.get("headline", "")
        next_action = insight_dict.get("next_action", "")
        seg_name = "the same audience"
        parsed = FollowupGoal(
            goal=f"Re-engage {seg_name} based on prior results: {next_action[:200]}".strip()[:400],
            rationale=f"Derived from analyst headline: {headline[:200]}",
        )

    latency_ms = int((time.time() - started) * 1000)
    run = AIRun(
        purpose="autopilot_followup_goal",
        prompt_version=PROMPT_VERSION,
        provider=provider_used,
        model=model_used,
        input_summary=f"campaign #{campaign.id}: {campaign.name[:120]}",
        raw_output=raw_output,
        parsed_output=parsed.model_dump(),
        validation_status=validation_status,
        error=error_msg,
        latency_ms=latency_ms,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run, parsed


def suggest_next_campaign(db: Session, campaign: Campaign) -> dict[str, Any]:
    """Full chain: analyst → derive follow-up goal → planner. Returns everything the
    UI needs to show the suggestion and let the user accept it as a draft."""
    # Step 1+2: analyst
    analyst_run, insight = analyze_campaign(db, campaign)

    # Step 3: derive follow-up goal
    goal_run, followup = _derive_followup_goal(db, campaign, insight.model_dump())

    # Step 4: full plan from that goal
    plan_run, plan = plan_campaign(db, followup.goal)

    return {
        "previous_campaign": {
            "id": campaign.id,
            "name": campaign.name,
            "status": campaign.status,
        },
        "insight": insight.model_dump(),
        "followup_goal": followup.model_dump(),
        "plan": plan.model_dump(),
        "ai_runs": {
            "analyst": analyst_run.id,
            "followup_goal": goal_run.id,
            "planner": plan_run.id,
        },
        "providers": {
            "analyst": f"{analyst_run.provider}/{analyst_run.model}",
            "followup_goal": f"{goal_run.provider}/{goal_run.model}",
            "planner": f"{plan_run.provider}/{plan_run.model}",
        },
        "latency_ms": {
            "analyst": analyst_run.latency_ms,
            "followup_goal": goal_run.latency_ms,
            "planner": plan_run.latency_ms,
            "total": (analyst_run.latency_ms or 0) + (goal_run.latency_ms or 0) + (plan_run.latency_ms or 0),
        },
    }
