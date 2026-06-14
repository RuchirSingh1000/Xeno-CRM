"""AI-driven merge explanation for flagged identity resolution decisions.

Why this lives in Phase 2:
- The deterministic match_reasoning string (e.g., "[name_city_only] fuzzy name >= 92
  + same city") is correct but unfriendly. A marketer reviewing a flagged customer
  benefits from a plain-English explanation that calls out the specific evidence
  and missing anchors.
- This establishes the AI patterns the rest of the app uses:
    * provider-agnostic LLM client with stub fallback
    * Pydantic-validated structured output
    * full audit logging to `ai_runs`
    * graceful degradation when validation fails
- Phase 5 reuses every line of this pattern for the campaign planner.
"""
from __future__ import annotations

import json
import time
from typing import Any

from pydantic import ValidationError
from sqlalchemy.orm import Session

from app.ai.client import llm
from app.ai.schemas import MergeExplanationOutput
from app.config import settings
from app.models import AIRun, Customer, CustomerIdentity

PROMPT_VERSION = "merge_explanation.v1"

SYSTEM_PROMPT = """You are an identity resolution analyst for a retail CDP.
Your job: given a set of source rows the system suspects represent the same customer,
explain in plain English why they were merged, what evidence supports the merge,
and what a human reviewer should consider.

Constraints:
- Be specific about the evidence: cite the actual name tokens, city, or other shared
  attributes you see. Do not generalize.
- Call out missing anchors explicitly. If there is no shared phone or email, say so —
  that is what makes the merge "flagged" rather than confident.
- Do not invent data. If the input does not mention a phone, do not claim a phone
  match.
- Keep tone neutral, like a tech-savvy colleague writing a one-paragraph note.
- Output STRICT JSON matching the requested schema."""


def _build_user_prompt(customer: Customer, identities: list[CustomerIdentity]) -> str:
    rows = []
    for i in identities:
        rows.append({
            "source": i.source_system,
            "raw_name": i.raw_name,
            "raw_phone": i.raw_phone,
            "raw_email": i.raw_email,
            "normalized_phone": i.normalized_phone,
            "normalized_email": i.normalized_email,
            "match_confidence": i.match_confidence,
            "rule_reasoning": i.match_reasoning,
        })

    schema = MergeExplanationOutput.model_json_schema()

    return f"""Customer: {customer.full_name} ({customer.master_customer_id})
City: {customer.city or "unknown"}
Source rows merged into this customer:
{json.dumps(rows, indent=2)}

Return JSON matching this schema:
{json.dumps(schema, indent=2)}
"""


def _summarize_input(customer: Customer, identities: list[CustomerIdentity]) -> str:
    """Compact human-readable summary stored on the AIRun row for the audit page."""
    sources = ",".join(sorted({i.source_system for i in identities}))
    return f"{customer.master_customer_id} · {customer.full_name} · sources={sources} · {len(identities)} rows"


def explain_merge(
    db: Session,
    customer: Customer,
    identities: list[CustomerIdentity],
) -> tuple[AIRun, MergeExplanationOutput]:
    """Run the AI explainer and persist an `ai_runs` row. Returns the row + parsed output.

    On validation failure we retry once with the validation error in the prompt;
    on second failure we fall back to a deterministic explanation and mark the run
    as `fallback_used`. The route still returns a usable response either way.
    """
    user_prompt = _build_user_prompt(customer, identities)
    input_summary = _summarize_input(customer, identities)

    started = time.time()
    raw_output: str = ""
    parsed: dict[str, Any] | None = None
    validation_status = "ok"
    error_msg: str | None = None

    provider_used = settings.llm_provider if llm.has_credentials() else "stub"
    model_used = settings.model_for(provider_used)

    try:
        result = llm.complete_json(
            system=SYSTEM_PROMPT,
            user=user_prompt,
            schema_hint=MergeExplanationOutput.model_json_schema(),
        )
        # Override with the provider that actually served the request (Groq
        # fallback may have kicked in transparently).
        if llm.last_used_provider:
            provider_used = llm.last_used_provider
            model_used = llm.last_used_model
        raw_output = json.dumps(result)
        try:
            validated = MergeExplanationOutput.model_validate(result)
            parsed = validated.model_dump()
        except ValidationError as ve:
            # Retry against the fallback provider (Groq when configured) —
            # re-asking the model that just returned garbage rarely helps.
            retry_user = (
                user_prompt
                + "\n\nThe previous response did not validate. Errors:\n"
                + str(ve)
                + "\n\nReturn STRICT JSON matching the schema this time."
            )
            result2 = llm.complete_json(
                system=SYSTEM_PROMPT,
                user=retry_user,
                schema_hint=MergeExplanationOutput.model_json_schema(),
                force_provider=settings.retry_provider,
            )
            if llm.last_used_provider:
                provider_used = llm.last_used_provider
                model_used = llm.last_used_model
            raw_output = json.dumps(result2)
            try:
                validated = MergeExplanationOutput.model_validate(result2)
                parsed = validated.model_dump()
                validation_status = "retry_used"
            except ValidationError as ve2:
                validation_status = "fallback_used"
                error_msg = f"validation failed twice: {ve2}"
                parsed = _deterministic_fallback(customer, identities).model_dump()
    except Exception as e:  # network errors, API errors, etc.
        validation_status = "fallback_used"
        error_msg = f"{type(e).__name__}: {e}"
        parsed = _deterministic_fallback(customer, identities).model_dump()

    latency_ms = int((time.time() - started) * 1000)

    run = AIRun(
        purpose="merge_explanation",
        prompt_version=PROMPT_VERSION,
        provider=provider_used,
        model=model_used,
        input_summary=input_summary,
        raw_output=raw_output,
        parsed_output=parsed,
        validation_status=validation_status,
        error=error_msg,
        latency_ms=latency_ms,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run, MergeExplanationOutput.model_validate(parsed)


def _deterministic_fallback(
    customer: Customer, identities: list[CustomerIdentity]
) -> MergeExplanationOutput:
    """Last-resort deterministic explanation. Used when the LLM call or validation fails."""
    names = sorted({i.raw_name for i in identities if i.raw_name})
    sources = sorted({i.source_system for i in identities})
    has_phone = any(i.normalized_phone for i in identities)
    has_email = any(i.normalized_email for i in identities)
    weakest_rule = min((i.match_confidence for i in identities), default=1.0)

    parts = [f"{len(identities)} source rows from {', '.join(sources)} were merged."]
    if names:
        parts.append(f"Name variants: {', '.join(names)}.")
    if customer.city:
        parts.append(f"All in {customer.city}.")
    if not has_phone and not has_email:
        parts.append("No phone or email anchor — the merge relies on name + city only.")

    recommendation: str = "approve" if weakest_rule >= 0.95 else "review" if weakest_rule >= 0.7 else "reject"

    return MergeExplanationOutput(
        explanation=" ".join(parts),
        confidence_assessment=f"Weakest rule confidence: {weakest_rule:.2f}. "
        + ("Strong" if weakest_rule >= 0.95 else "Moderate — recommend human review."),
        recommendation=recommendation,
    )
