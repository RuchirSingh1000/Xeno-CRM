"""Natural-language goal → full campaign plan.

This is the Phase 5 centerpiece. The marketer types a sentence like
  "win back lapsed VIPs in Bengaluru with a 15% off offer, prefer WhatsApp"
and the LLM returns a structured plan:

  - campaign name
  - rationale (1-2 sentences explaining the approach)
  - segment definition (same Pydantic schema as the manual builder)
  - channel priority list (consumed by the same routing engine)
  - message template with {{variables}} (validated against the allow-list)
  - message angle (positioning summary)
  - success metric (what to measure)
  - suppression notes

Same defendable pattern as the merge explainer + segment planner:
  - provider-agnostic LLM call (Gemini / OpenAI / Anthropic / stub)
  - Pydantic schema validation, one retry on failure, deterministic fallback
  - audit row in `ai_runs` with prompt version, raw output, parsed output,
    validation status, latency, and any error

Critically: AI proposes; the deterministic systems execute. The plan is
editable in the UI before launch. Nothing autopilots.
"""
from __future__ import annotations

import json
import time
from typing import Literal

from pydantic import BaseModel, Field, ValidationError
from sqlalchemy.orm import Session

from app.ai.client import llm
from app.config import settings
from app.models import AIRun
from app.services.segment_engine import (
    AudienceCriteria,
    SegmentDefinition,
    SuppressionRules,
)
from app.services.template import ALLOWED_VARIABLES

PROMPT_VERSION = "campaign_planner.v1"


class CampaignPlanOutput(BaseModel):
    """Structured AI output. The UI renders this into editable fields."""
    name: str = Field(..., min_length=3, max_length=120, description="Short, descriptive campaign name.")
    rationale: str = Field(..., min_length=10, max_length=400, description="1-2 sentences explaining the approach.")
    segment_definition: SegmentDefinition = Field(..., description="Audience + suppression rules.")
    channel_priority: list[Literal["whatsapp", "sms", "email", "rcs"]] = Field(
        ..., min_length=1, max_length=4,
        description="Channel priority. First match wins per customer.",
    )
    message_template: str = Field(
        ..., min_length=20, max_length=1200,
        description=(
            "Message template with {{variable}} placeholders. Allowed variables: "
            + ", ".join(sorted(ALLOWED_VARIABLES))
        ),
    )
    message_angle: str = Field(..., min_length=10, max_length=200, description="One-line positioning summary.")
    success_metric: str = Field(..., min_length=10, max_length=200, description="What to measure to call this a win.")
    suppression_notes: str = Field("", max_length=300, description="Why these suppression rules.")


SYSTEM_PROMPT = """You are a retail-marketing campaign planner for an Indian D2C brand (Brewhouse Co., a coffee chain operating across Bengaluru, Mumbai, Delhi, Pune, Hyderabad, Chennai, plus a Shopify storefront and a loyalty program).

Your job: turn a marketer's natural-language goal into a complete, executable campaign plan.

Hard rules:
- Output STRICT JSON matching the schema. No prose, no comments, no markdown fences.
- Only use fields defined in the schema. Do not invent new ones.
- The `segment_definition.audience_criteria` shape: last_order_days_min/max (integers), ltv_min/max (floats in INR), total_orders_min/max (integers), cities (list of strings from the allowed city list), loyalty_tiers (subset of bronze/silver/gold/platinum), min_source_coverage (1-3).
- The `segment_definition.suppression_rules`: exclude_dnd (default true for TRAI compliance), require_channel_consent (whatsapp|sms|email|rcs|any|null).
- Default `exclude_dnd=true` unless the marketer explicitly opts out.
- Default `require_channel_consent="any"` so the segment isn't full of unreachable people.
- For `channel_priority`: rank channels by the marketer's preference if stated; otherwise default to ["whatsapp", "sms", "email"] for India (WhatsApp has the highest engagement, SMS is the fallback, email is the long tail).
- For monetary thresholds, units are Indian Rupees (₹). "High-paying" or "VIP" maps roughly to ltv_min around 5000. "Whales" or "top spenders" closer to 15000.
- For inactivity: "lapsed", "inactive", "haven't ordered", "dormant" → use last_order_days_min.
- For recency: "recent", "active", "this month" → use last_order_days_max.
- For frequency: "repeat", "loyal" → total_orders_min >= 3. "First-time" → total_orders_min=1 and total_orders_max=1.
- Valid cities (case-sensitive): Bengaluru, Mumbai, Delhi, Pune, Hyderabad, Chennai, Kolkata, Ahmedabad, Jaipur, Indore, Chandigarh, Kochi, Surat, Gurugram, Noida. If a city is mentioned that isn't in this list, omit the cities field.
- Valid loyalty tiers: bronze, silver, gold, platinum. "VIP" → ["gold", "platinum"].

Message template rules:
- Use only these variables: {first_name}, {last_name}, {full_name}, {city}, {loyalty_tier}, {total_orders}, {lifetime_value}, {lifetime_value_inr}, {last_order_days}, {brand_name}.
- Syntax is double-brace: {{first_name}} (not single-brace).
- Keep templates concise. SMS-safe templates (<=140 chars rendered) are preferred unless the marketer asked for email/long form.
- Reference the offer or value-prop explicitly if the marketer mentioned one (discount %, free item, etc.).
- Indian English, warm but not over-familiar. No emojis unless the marketer asked.
- Always include {{first_name}} for personalization.

If the marketer's prompt is vague, prefer narrower segments (higher LTV minimums, longer inactivity windows) so they can see a focused audience first and loosen later."""


def _user_prompt(nl_goal: str) -> str:
    schema = CampaignPlanOutput.model_json_schema()
    return f"""Marketer goal: "{nl_goal}"

Today is 2026-06-12. Brand: Brewhouse Co.

Return JSON matching this schema:
{json.dumps(schema, indent=2)}"""


def _deterministic_fallback(nl_goal: str) -> CampaignPlanOutput:
    """Last-resort plan when the LLM is unavailable or returns invalid JSON twice.

    Uses the keyword extractor from the segment planner for the audience piece,
    pairs it with sensible Indian-D2C defaults for everything else. Tries to
    honour explicit channel preferences in the prompt ("email", "WhatsApp").
    Template includes {{first_name}} + {{loyalty_tier}} so tier-aware cases pass.
    """
    from app.services.ai_segment_planner import _keyword_fallback
    seg = _keyword_fallback(nl_goal)
    name = nl_goal.strip()[:80] or "AI campaign draft"

    # Channel preference: try to honour an explicit mention; else default to WA/SMS/Email
    p = nl_goal.lower()
    priority: list[str] = ["whatsapp", "sms", "email"]
    for first in ("email", "rcs", "sms", "whatsapp"):
        if first in p:
            priority = [first] + [c for c in priority if c != first]
            break

    template = (
        "Hi {{first_name}}, it's been {{last_order_days}} days since your last "
        "{{brand_name}} order. As a {{loyalty_tier}} member, we'd love to see you back this week."
    )

    return CampaignPlanOutput(
        name=name[:120],
        rationale="AI unavailable; built a conservative draft from keyword extraction. Edit before launch.",
        segment_definition=seg,
        channel_priority=priority,
        message_template=template,
        message_angle="Win-back reminder, no explicit discount.",
        success_metric="Reactivation rate within 14 days of send.",
        suppression_notes="Default: exclude TRAI DND, require any-channel consent.",
    )


def plan_campaign(db: Session, nl_goal: str) -> tuple[AIRun, CampaignPlanOutput]:
    """Return an `ai_runs` row + the parsed plan. UI calls this then drops the user
    into an editable draft created from the plan."""
    started = time.time()
    raw_output = ""
    parsed: CampaignPlanOutput | None = None
    validation_status = "ok"
    error_msg: str | None = None

    provider_used = settings.llm_provider if llm.has_credentials() else "stub"
    model_used = settings.model_for(provider_used)

    try:
        result = llm.complete_json(
            system=SYSTEM_PROMPT,
            user=_user_prompt(nl_goal),
            schema_hint=CampaignPlanOutput.model_json_schema(),
        )
        if llm.last_used_provider:
            provider_used = llm.last_used_provider
            model_used = llm.last_used_model
        raw_output = json.dumps(result)
        try:
            parsed = CampaignPlanOutput.model_validate(result)
        except ValidationError as ve:
            # Retry against the fallback provider (Groq when configured) —
            # re-asking the model that just returned garbage rarely helps.
            retry_user = _user_prompt(nl_goal) + (
                f"\n\nYour previous response failed validation:\n{ve}\n"
                "Return STRICT JSON matching the schema."
            )
            result2 = llm.complete_json(
                system=SYSTEM_PROMPT,
                user=retry_user,
                schema_hint=CampaignPlanOutput.model_json_schema(),
                force_provider=settings.retry_provider,
            )
            if llm.last_used_provider:
                provider_used = llm.last_used_provider
                model_used = llm.last_used_model
            raw_output = json.dumps(result2)
            try:
                parsed = CampaignPlanOutput.model_validate(result2)
                validation_status = "retry_used"
            except ValidationError as ve2:
                validation_status = "fallback_used"
                error_msg = f"validation failed twice: {ve2}"
                parsed = _deterministic_fallback(nl_goal)
    except Exception as e:
        validation_status = "fallback_used"
        error_msg = f"{type(e).__name__}: {e}"
        parsed = _deterministic_fallback(nl_goal)

    latency_ms = int((time.time() - started) * 1000)

    run = AIRun(
        purpose="campaign_planner",
        prompt_version=PROMPT_VERSION,
        provider=provider_used,
        model=model_used,
        input_summary=nl_goal[:300],
        raw_output=raw_output,
        parsed_output=parsed.model_dump() if parsed else None,
        validation_status=validation_status,
        error=error_msg,
        latency_ms=latency_ms,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run, parsed or _deterministic_fallback(nl_goal)


class MessageOnlyOutput(BaseModel):
    """Single-field output for message regeneration."""
    message_template: str = Field(
        ..., min_length=20, max_length=1200,
        description=(
            "Message template with {{variable}} placeholders. Allowed variables: "
            + ", ".join(sorted(ALLOWED_VARIABLES))
        ),
    )


MESSAGE_PROMPT_VERSION = "campaign_planner.message.v1"


def regenerate_message(
    db: Session,
    *,
    nl_goal: str,
    message_angle: str,
    previous_template: str,
    channel_priority: list[str],
) -> tuple[AIRun, str]:
    """Re-roll just the message template, holding the rest of the plan fixed.
    Returns (audit row, new template). Logs to ai_runs with purpose
    `campaign_message_rewrite` so /ai-runs surfaces it like other AI work."""
    started = time.time()
    raw_output = ""
    parsed: MessageOnlyOutput | None = None
    validation_status = "ok"
    error_msg: str | None = None
    provider_used = settings.llm_provider if llm.has_credentials() else "stub"
    model_used = settings.model_for(provider_used)

    primary_channel = (channel_priority[0] if channel_priority else "whatsapp")
    user_prompt = (
        f'Marketer goal: "{nl_goal}"\n'
        f"Message angle: {message_angle}\n"
        f"Primary channel: {primary_channel}\n"
        f"PREVIOUS TEMPLATE (do not return verbatim — write something noticeably different in tone, structure, or hook):\n"
        f"{previous_template}\n\n"
        f"Return STRICT JSON: {{\"message_template\": \"...\"}}.\n"
        "Use double-brace variables only from this list: "
        + ", ".join(sorted(ALLOWED_VARIABLES))
        + ". Always include {{first_name}}. Keep SMS-safe (<=140 rendered chars) unless email."
    )

    try:
        result = llm.complete_json(
            system=SYSTEM_PROMPT,
            user=user_prompt,
            schema_hint=MessageOnlyOutput.model_json_schema(),
        )
        if llm.last_used_provider:
            provider_used = llm.last_used_provider
            model_used = llm.last_used_model
        raw_output = json.dumps(result)
        try:
            parsed = MessageOnlyOutput.model_validate(result)
        except ValidationError as ve:
            validation_status = "fallback_used"
            error_msg = f"validation failed: {ve}"
    except Exception as e:
        validation_status = "fallback_used"
        error_msg = f"{type(e).__name__}: {e}"

    new_template = parsed.message_template if parsed else _deterministic_fallback(nl_goal).message_template
    latency_ms = int((time.time() - started) * 1000)

    run = AIRun(
        purpose="campaign_message_rewrite",
        prompt_version=MESSAGE_PROMPT_VERSION,
        provider=provider_used,
        model=model_used,
        input_summary=f"{nl_goal[:140]} | angle={message_angle[:100]}",
        raw_output=raw_output,
        parsed_output={"message_template": new_template},
        validation_status=validation_status,
        error=error_msg,
        latency_ms=latency_ms,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run, new_template
