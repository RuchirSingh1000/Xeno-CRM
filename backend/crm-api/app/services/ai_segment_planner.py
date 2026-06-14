"""Natural-language → SegmentDefinition.

The marketer types something like
  "high-paying customers who haven't ordered in 30 days"
and we return a fully-validated SegmentDefinition the existing builder can render
and the segment engine can execute. The output is *the same Pydantic shape* the
manual builder produces — no separate "AI segments" code path. Two reasons:

1. Auditability: there is no AI-only execution surface. The LLM proposes, the
   deterministic compiler executes. Same code path, same guardrails.
2. Reuse: the merge explainer pattern (provider-agnostic + Pydantic validation
   + retry + deterministic fallback + ai_runs audit row) is identical here.

Fallback strategy when the LLM is unavailable: a small keyword extractor that
handles the most common retail-marketing patterns. Better than empty.
"""
from __future__ import annotations

import json
import re
import time

from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.ai.client import llm
from app.config import settings
from app.models import AIRun
from app.services.segment_engine import (
    AudienceCriteria,
    SegmentDefinition,
    SuppressionRules,
)

PROMPT_VERSION = "segment_planner.v1"

SYSTEM_PROMPT = """You are a retail-marketing segment planner for an Indian D2C brand.
Your job: turn a marketer's natural-language request into a structured audience definition
the CRM can execute deterministically.

Hard rules:
- Output STRICT JSON matching the requested schema. No prose, no comments, no trailing text.
- Only use fields defined in the schema. Do not invent new ones.
- If the prompt is ambiguous, prefer conservative thresholds that include fewer customers
  (e.g., higher LTV minimum, longer inactivity window) — the marketer can loosen later.
- Default to `exclude_dnd=true` (TRAI compliance) unless the prompt explicitly opts out.
- Default to `require_channel_consent="any"` so the segment isn't full of unreachable people.
- For monetary thresholds, units are Indian Rupees (₹). "High-paying" or "VIP" maps roughly
  to ltv_min around 5000. "Whales" or "top spenders" closer to 15000.
- For inactivity: "lapsed", "inactive", "haven't ordered", "dormant" → use last_order_days_min.
  For recency: "recent", "active", "this month" → use last_order_days_max.
- For frequency: "repeat", "loyal" → total_orders_min >= 3. "First-time" → total_orders_min=1, total_orders_max=1.
- Valid cities (case-sensitive): Bengaluru, Mumbai, Delhi, Pune, Hyderabad, Chennai, Kolkata,
  Ahmedabad, Jaipur, Indore, Chandigarh, Kochi, Surat, Gurugram, Noida. If the prompt mentions
  a city not in this list, omit the cities field.
- Valid loyalty tiers: bronze, silver, gold, platinum. "VIP" maps to ["gold","platinum"]."""


def _user_prompt(nl_prompt: str) -> str:
    schema = SegmentDefinition.model_json_schema()
    return f"""Marketer prompt: "{nl_prompt}"

Return JSON matching this schema:
{json.dumps(schema, indent=2)}
"""


def _keyword_fallback(nl_prompt: str) -> SegmentDefinition:
    """Lightweight keyword extractor for when the LLM isn't available.

    Not exhaustive — covers the most common retail-marketing intent shapes so the
    marketer gets *something* useful rather than an empty form."""
    p = nl_prompt.lower()
    ac = AudienceCriteria()

    # Day window — look for "N day(s)" near intent words. Tolerates "60+ days".
    INACTIVITY_WORDS = ("inactive", "lapsed", "haven't", "havent", "no order", "dormant", "didn't", "win back", "win-back", "dormant")
    RECENCY_WORDS = ("active", "recent", "last", "past")
    m = re.search(r"(\d+)\s*\+?\s*days?", p)
    if m:
        days = int(m.group(1))
        if any(w in p for w in INACTIVITY_WORDS):
            ac.last_order_days_min = days
        elif any(w in p for w in RECENCY_WORDS):
            ac.last_order_days_max = days
    else:
        # No explicit day count — but inactivity language alone should still
        # produce a sensible default so downstream filters aren't no-ops.
        if any(w in p for w in INACTIVITY_WORDS):
            ac.last_order_days_min = 30

    # Value bands
    if any(w in p for w in ("whale", "top spender", "biggest customer")):
        ac.ltv_min = 15000
    elif any(w in p for w in ("high paying", "high-paying", "high value", "high-value", "vip", "premium", "valuable", "best customer")):
        ac.ltv_min = 5000

    # Tier
    tiers = []
    if "gold" in p:
        tiers.append("gold")
    if "platinum" in p:
        tiers.append("platinum")
    if "silver" in p:
        tiers.append("silver")
    if "bronze" in p:
        tiers.append("bronze")
    if "vip" in p and not tiers:
        tiers = ["gold", "platinum"]
    if tiers:
        ac.loyalty_tiers = tiers  # type: ignore[assignment]

    # Frequency
    if any(w in p for w in ("first time", "first-time", "new customer", "one order")):
        ac.total_orders_min = 1
        ac.total_orders_max = 1
    elif any(w in p for w in ("repeat", "loyal", "frequent")):
        ac.total_orders_min = 3
    # Explicit "N+ orders" / "N or more orders"
    om = re.search(r"(\d+)\s*\+?\s*(or more)?\s*orders?", p)
    if om and ac.total_orders_min is None:
        ac.total_orders_min = int(om.group(1))

    # Multi-source coverage. "across all three / all three sources / all our systems"
    if re.search(r"all\s+(three|3)\s+(of\s+(our\s+)?)?(sources|systems)", p) or "across all three" in p:
        ac.min_source_coverage = 3
    elif "across all sources" in p or "in every source" in p:
        ac.min_source_coverage = 3

    # Cities
    cities = []
    for city in (
        "Bengaluru", "Mumbai", "Delhi", "Pune", "Hyderabad", "Chennai", "Kolkata",
        "Ahmedabad", "Jaipur", "Indore", "Chandigarh", "Kochi", "Surat", "Gurugram", "Noida",
    ):
        if city.lower() in p:
            cities.append(city)
    if cities:
        ac.cities = cities

    # Channel hint
    channel = None
    for ch in ("whatsapp", "sms", "email", "rcs"):
        if ch in p:
            channel = ch
            break

    sr = SuppressionRules(
        exclude_dnd=True,
        require_channel_consent=channel or "any",  # type: ignore[arg-type]
    )
    return SegmentDefinition(audience_criteria=ac, suppression_rules=sr)


def plan_segment(db: Session, nl_prompt: str) -> tuple[AIRun, SegmentDefinition, str]:
    """Returns (ai_run row, parsed definition, short rationale string).

    The rationale is a 1-sentence summary the UI surfaces above the builder so
    the marketer can see *why* the AI proposed these filters.
    """
    started = time.time()
    raw_output = ""
    parsed: SegmentDefinition | None = None
    rationale = ""
    validation_status = "ok"
    error_msg: str | None = None

    provider_used = settings.llm_provider if llm.has_credentials() else "stub"
    model_used = settings.model_for(provider_used)

    # Ask the model for a definition + a one-sentence rationale in one shot
    user_with_rationale = _user_prompt(nl_prompt) + """

Additionally include a top-level "rationale" string field (one short sentence) explaining your interpretation, then the SegmentDefinition fields. Example:
{ "rationale": "...", "audience_criteria": {...}, "suppression_rules": {...} }"""

    try:
        result = llm.complete_json(
            system=SYSTEM_PROMPT,
            user=user_with_rationale,
            schema_hint=SegmentDefinition.model_json_schema(),
        )
        if llm.last_used_provider:
            provider_used = llm.last_used_provider
            model_used = llm.last_used_model
        raw_output = json.dumps(result)
        rationale = str(result.pop("rationale", "")).strip()
        try:
            parsed = SegmentDefinition.model_validate(result)
        except ValidationError as ve:
            # Retry with the validation error in the prompt. If a different
            # provider is available (typically Groq), prefer it — re-asking the
            # same model that just returned garbage rarely helps.
            retry_user = user_with_rationale + (
                f"\n\nYour previous response failed validation:\n{ve}\n"
                "Return STRICT JSON matching the schema."
            )
            retry_provider = settings.retry_provider
            result2 = llm.complete_json(
                system=SYSTEM_PROMPT,
                user=retry_user,
                schema_hint=SegmentDefinition.model_json_schema(),
                force_provider=retry_provider,
            )
            if llm.last_used_provider:
                provider_used = llm.last_used_provider
                model_used = llm.last_used_model
            raw_output = json.dumps(result2)
            rationale = str(result2.pop("rationale", "")).strip() or rationale
            try:
                parsed = SegmentDefinition.model_validate(result2)
                validation_status = "retry_used"
            except ValidationError as ve2:
                validation_status = "fallback_used"
                error_msg = f"validation failed twice: {ve2}"
                parsed = _keyword_fallback(nl_prompt)
                rationale = "AI validation failed; used keyword fallback."
    except Exception as e:
        validation_status = "fallback_used"
        error_msg = f"{type(e).__name__}: {e}"
        parsed = _keyword_fallback(nl_prompt)
        rationale = "AI call failed; used keyword fallback."

    latency_ms = int((time.time() - started) * 1000)

    run = AIRun(
        purpose="segment_planner",
        prompt_version=PROMPT_VERSION,
        provider=provider_used,
        model=model_used,
        input_summary=nl_prompt[:300],
        raw_output=raw_output,
        parsed_output={
            "rationale": rationale,
            **(parsed.model_dump() if parsed else {}),
        },
        validation_status=validation_status,
        error=error_msg,
        latency_ms=latency_ms,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run, parsed or _keyword_fallback(nl_prompt), rationale
