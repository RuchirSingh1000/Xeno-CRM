"""AI copilot — natural-language Q&A over the CRM via tool-use.

Why ReAct-over-JSON instead of provider-native function-calling:
- Provider-agnostic. Same loop works on Gemini, OpenAI, Anthropic, Groq, stub.
- Fits the existing `llm.complete_json` interface and audit trail.
- Trivially debuggable — each step is a JSON blob in `ai_runs.parsed_output`.

The cost is one extra parse-and-validate per turn versus native tool-calling.
At the scale of a marketer's chat session (few turns/minute), that's nothing.

The agent loop:
  1. System prompt describes the tools and forces a strict JSON output shape:
     either {"action": "call_tool", "tool": "...", "args": {...}}
     or     {"action": "respond", "message": "..."}.
  2. We feed the conversation + tool results back as the next user message.
  3. Cap at MAX_STEPS so a stuck model can't loop forever.

Every full Q&A is one AIRun row (purpose="copilot"), with the per-step trace
saved in parsed_output["trace"]. That's a real audit trail — you can see why
the model said what it said.
"""
from __future__ import annotations

import json
import time
from typing import Any, Callable

from pydantic import BaseModel, Field, ValidationError
from sqlalchemy.orm import Session

from app.ai.client import llm
from app.config import settings
from app.models import AIRun, Customer
from app.services import analytics
from app.services.brand import get_or_create_demo_brand


PROMPT_VERSION = "copilot.v1"
MAX_STEPS = 5  # hard cap on tool calls per question


# ---------------------------------------------------------------------------
# Tools — each is a plain Python function the LLM can choose to call.
# Keep the surface small. Marketers asking "how is campaign 3 doing" should
# never need a 30-tool toolbox; six well-chosen ones beat thirty thin ones.
# ---------------------------------------------------------------------------


def _tool_get_analytics_overview(db: Session, brand_id: int, args: dict) -> dict:
    return analytics.overview(db, brand_id)


def _tool_list_campaigns(db: Session, brand_id: int, args: dict) -> dict:
    limit = min(int(args.get("limit", 20)), 50)
    return analytics.campaigns_leaderboard(db, brand_id, limit=limit)


def _tool_get_campaign(db: Session, brand_id: int, args: dict) -> dict:
    from app.models import Campaign
    cid = int(args.get("campaign_id", 0))
    leaderboard = analytics.campaigns_leaderboard(db, brand_id, limit=200)
    for c in leaderboard.get("campaigns", []):
        if c.get("id") == cid:
            return c
    return {"error": f"campaign {cid} not found"}


def _tool_channel_breakdown(db: Session, brand_id: int, args: dict) -> dict:
    return analytics.channels(db, brand_id)


def _tool_failure_breakdown(db: Session, brand_id: int, args: dict) -> dict:
    return analytics.failures(db, brand_id)


def _tool_top_customers(db: Session, brand_id: int, args: dict) -> dict:
    """Top customers by LTV. Optional: city, tier."""
    limit = min(int(args.get("limit", 10)), 50)
    q = db.query(Customer).filter(Customer.brand_id == brand_id)
    if args.get("city"):
        q = q.filter(Customer.city == str(args["city"]))
    if args.get("tier"):
        q = q.filter(Customer.loyalty_tier == str(args["tier"]))
    rows = q.order_by(Customer.lifetime_value.desc().nullslast()).limit(limit).all()
    return {
        "customers": [
            {
                "master_id": r.master_customer_id,
                "name": r.full_name,
                "city": r.city,
                "tier": r.loyalty_tier,
                "ltv_inr": float(r.lifetime_value or 0),
                "orders": r.total_orders or 0,
            }
            for r in rows
        ],
        "count": len(rows),
    }


def _tool_count_customers(db: Session, brand_id: int, args: dict) -> dict:
    """Count customers with optional filters: city, tier, min_ltv."""
    q = db.query(Customer).filter(Customer.brand_id == brand_id)
    if args.get("city"):
        q = q.filter(Customer.city == str(args["city"]))
    if args.get("tier"):
        q = q.filter(Customer.loyalty_tier == str(args["tier"]))
    if args.get("min_ltv") is not None:
        q = q.filter(Customer.lifetime_value >= float(args["min_ltv"]))
    return {"count": q.count()}


TOOLS: dict[str, dict[str, Any]] = {
    "get_analytics_overview": {
        "fn": _tool_get_analytics_overview,
        "desc": "Portfolio-wide campaign metrics: total revenue, customers reached, sent/delivered/clicked/converted counts, delivery/CTR/conversion/failure rates.",
        "args": {},
    },
    "list_campaigns": {
        "fn": _tool_list_campaigns,
        "desc": "Per-campaign leaderboard with targeted, delivered, clicked, converted, revenue, CTR, conversion rate, status. Use to compare campaigns or find best/worst.",
        "args": {"limit": "int (optional, default 20, max 50)"},
    },
    "get_campaign": {
        "fn": _tool_get_campaign,
        "desc": "Full metrics for one campaign by id.",
        "args": {"campaign_id": "int (required)"},
    },
    "channel_breakdown": {
        "fn": _tool_channel_breakdown,
        "desc": "Performance per channel (whatsapp/sms/email): sent, delivery rate, CTR, conversion, revenue, revenue per send.",
        "args": {},
    },
    "failure_breakdown": {
        "fn": _tool_failure_breakdown,
        "desc": "Communication failures grouped by reason (invalid_number, opt_out, rate_limited, etc).",
        "args": {},
    },
    "top_customers": {
        "fn": _tool_top_customers,
        "desc": "Top customers by lifetime value. Optional filters: city, tier.",
        "args": {"limit": "int (default 10, max 50)", "city": "str (optional)", "tier": "str: bronze|silver|gold|platinum"},
    },
    "count_customers": {
        "fn": _tool_count_customers,
        "desc": "Count customers matching simple filters. Use before launching big campaigns.",
        "args": {"city": "str (optional)", "tier": "str (optional)", "min_ltv": "float (optional)"},
    },
}


def _tools_doc() -> str:
    lines = []
    for name, spec in TOOLS.items():
        args = ", ".join(f"{k}: {v}" for k, v in spec["args"].items()) or "(no args)"
        lines.append(f"- `{name}({args})` — {spec['desc']}")
    return "\n".join(lines)


SYSTEM_PROMPT = """You are the Xeno CRM copilot — a senior marketing analyst embedded in the Brewhouse Co. dashboard. The user is a marketer asking about their CRM data.

You have access to tools that read live data from the CRM. To use them, return STRICT JSON in one of two shapes (no prose, no markdown fences):

  {"action": "call_tool", "tool": "<tool_name>", "args": {...}, "thought": "<one short sentence on why>"}

or

  {"action": "respond", "message": "<final natural-language answer to the user>"}

Available tools:
""" + _tools_doc() + """

Rules:
- Call at most 3 tools per question; if you have enough, respond.
- Prefer the smallest tool that answers the question.
- When you respond, be concise: 1-4 sentences, real numbers, no hedging. Use ₹ for INR.
- If a question is conversational or outside the data ("hi", "what can you do"), respond directly without a tool call.
- All monetary values are in INR. Rates come back as 0-1 floats — convert to % when speaking.
- If a tool returns nothing useful or an error, say so plainly instead of making up numbers.
- Format multi-item answers as a short bulleted list when it helps."""


class _Step(BaseModel):
    action: str = Field(..., pattern="^(call_tool|respond)$")
    tool: str | None = None
    args: dict | None = None
    thought: str | None = None
    message: str | None = None


def ask(db: Session, brand_id: int, question: str, history: list[dict] | None = None) -> dict:
    """Run the agent loop for one user question. Returns the answer + a step trace.

    `history` is the prior turns as [{"role": "user"|"assistant", "content": "..."}]
    so the marketer can ask follow-ups ("which one converted best?" after asking
    about top campaigns).
    """
    started = time.time()
    history = history or []
    trace: list[dict] = []
    final_answer: str | None = None
    provider_used = settings.llm_provider if llm.has_credentials() else "stub"
    model_used = settings.model_for(provider_used)
    validation_status = "ok"
    error_msg: str | None = None

    # Build the running user message. We re-send the full mini-transcript on
    # each step because we're not threading provider-specific message arrays.
    def _user_for_step() -> str:
        parts = []
        if history:
            parts.append("Conversation so far:")
            for h in history[-6:]:
                parts.append(f"{h['role']}: {h['content']}")
            parts.append("")
        parts.append(f"User question: {question}")
        if trace:
            parts.append("")
            parts.append("Tool calls so far:")
            for t in trace:
                parts.append(f"- called `{t['tool']}` with {json.dumps(t['args'])}")
                parts.append(f"  result: {json.dumps(t['result'])[:1500]}")
        return "\n".join(parts)

    try:
        for step_idx in range(MAX_STEPS):
            result = llm.complete_json(
                system=SYSTEM_PROMPT,
                user=_user_for_step(),
                schema_hint={
                    "action": "respond|call_tool",
                    "tool": "string (if call_tool)",
                    "args": "object (if call_tool)",
                    "message": "string (if respond)",
                },
            )
            if llm.last_used_provider:
                provider_used = llm.last_used_provider
                model_used = llm.last_used_model

            try:
                step = _Step.model_validate(result)
            except ValidationError:
                # Model returned something off-shape — surface and exit gracefully.
                validation_status = "fallback_used"
                error_msg = f"step {step_idx} returned unparseable JSON: {result!r}"
                final_answer = (
                    "I couldn't structure my answer this turn. "
                    "Try rephrasing the question or asking again."
                )
                break

            if step.action == "respond":
                final_answer = step.message or "(no answer)"
                break

            # call_tool
            tool_name = step.tool or ""
            args = step.args or {}
            if tool_name not in TOOLS:
                trace.append({
                    "tool": tool_name,
                    "args": args,
                    "thought": step.thought,
                    "result": {"error": f"unknown tool {tool_name!r}"},
                })
                continue
            try:
                tool_result = TOOLS[tool_name]["fn"](db, brand_id, args)
            except Exception as e:
                tool_result = {"error": f"{type(e).__name__}: {e}"}
            trace.append({
                "tool": tool_name,
                "args": args,
                "thought": step.thought,
                "result": tool_result,
            })
        else:
            # Loop exhausted without a respond step
            validation_status = "fallback_used"
            error_msg = f"hit MAX_STEPS={MAX_STEPS} without final answer"
            final_answer = (
                "I gathered some data but couldn't summarize cleanly within the step budget. "
                "Try a more specific question."
            )
    except Exception as e:
        validation_status = "fallback_used"
        error_msg = f"{type(e).__name__}: {e}"
        final_answer = "The copilot hit an error. Check /ai-runs for details."

    latency_ms = int((time.time() - started) * 1000)
    run = AIRun(
        purpose="copilot",
        prompt_version=PROMPT_VERSION,
        provider=provider_used,
        model=model_used,
        input_summary=question[:300],
        raw_output=json.dumps({"answer": final_answer, "trace": trace})[:8000],
        parsed_output={"answer": final_answer, "trace": trace, "steps": len(trace)},
        validation_status=validation_status,
        error=error_msg,
        latency_ms=latency_ms,
    )
    db.add(run)
    db.commit()
    db.refresh(run)

    return {
        "ai_run_id": run.id,
        "answer": final_answer,
        "trace": trace,
        "provider": provider_used,
        "model": model_used,
        "latency_ms": latency_ms,
        "validation_status": validation_status,
    }
