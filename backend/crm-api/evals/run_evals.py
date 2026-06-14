"""Run the AI Campaign Planner eval suite.

Usage:
  D:\\xeno-crm\\.venv\\Scripts\\python.exe evals/run_evals.py

Each case in `campaign_planner_cases.json` has:
  - `input_goal`: the NL prompt fed to the planner
  - `expected`: structural assertions the output must satisfy

Assertions are deliberately structural, not text-match. Example: instead of
asserting the template contains the literal word "discount", we assert it
contains a {{first_name}} variable. This lets the LLM vary phrasing while we
still check the load-bearing behaviour.

Failing cases are documented in the README — they're known limitations that
help future-me refine the prompt rather than red-flag the suite.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

# Make app importable when running this file directly
ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.db.session import SessionLocal  # noqa: E402
from app.services.ai_campaign_planner import plan_campaign  # noqa: E402


CASES_PATH = Path(__file__).resolve().parent / "campaign_planner_cases.json"


def load_cases() -> list[dict]:
    return json.loads(CASES_PATH.read_text(encoding="utf-8"))


def _get(d: dict | None, path: str):
    """Walk dotted path through a dict, returning None if any step is missing."""
    cur = d or {}
    for k in path.split("."):
        if not isinstance(cur, dict) or k not in cur:
            return None
        cur = cur[k]
    return cur


def evaluate(case: dict, plan: dict) -> tuple[bool, list[str]]:
    """Return (passed, failures_for_this_case)."""
    failures: list[str] = []
    expected = case.get("expected", {})

    ac = _get(plan, "segment_definition.audience_criteria") or {}
    sr = _get(plan, "segment_definition.suppression_rules") or {}
    priority = plan.get("channel_priority") or []
    template = plan.get("message_template") or ""

    # audience_criteria_has
    ach = expected.get("audience_criteria_has", {})
    for k, v in ach.items():
        if k.endswith("_at_least"):
            field = k.removesuffix("_at_least")
            actual = ac.get(field)
            if actual is None or actual < v:
                failures.append(f"audience.{field} should be >= {v}, got {actual!r}")
        elif k.endswith("_at_most"):
            field = k.removesuffix("_at_most")
            actual = ac.get(field)
            if actual is None or actual > v:
                failures.append(f"audience.{field} should be <= {v}, got {actual!r}")
        elif k.endswith("_eq"):
            field = k.removesuffix("_eq")
            actual = ac.get(field)
            if actual != v:
                failures.append(f"audience.{field} should == {v}, got {actual!r}")
        elif k == "loyalty_tiers_subset_of":
            actual = ac.get("loyalty_tiers") or []
            if not actual or not set(actual).issubset(set(v)):
                failures.append(f"loyalty_tiers should be subset of {v}, got {actual!r}")
        elif k == "cities_contains":
            actual = ac.get("cities") or []
            if v not in actual:
                failures.append(f"cities should contain {v!r}, got {actual!r}")
        elif k == "cities_omitted_or_empty":
            actual = ac.get("cities")
            if actual not in (None, [], {}):
                failures.append(f"cities should be omitted or empty, got {actual!r}")
        else:
            failures.append(f"unknown audience assertion key: {k}")

    # suppression_rules
    for k, v in expected.get("suppression_rules", {}).items():
        if sr.get(k) != v:
            failures.append(f"suppression.{k} should == {v}, got {sr.get(k)!r}")

    # channel_priority
    if "channel_priority_contains" in expected:
        for ch in expected["channel_priority_contains"]:
            if ch not in priority:
                failures.append(f"channel_priority should contain {ch!r}, got {priority!r}")
    if "channel_priority_starts_with" in expected:
        if not priority or priority[0] != expected["channel_priority_starts_with"]:
            failures.append(
                f"channel_priority[0] should be {expected['channel_priority_starts_with']!r}, "
                f"got {(priority[0] if priority else None)!r}"
            )
    if "channel_priority_min_length" in expected:
        if len(priority) < expected["channel_priority_min_length"]:
            failures.append(
                f"channel_priority length should be >= {expected['channel_priority_min_length']}, got {len(priority)}"
            )

    # template
    if "template_has_variables" in expected:
        for var in expected["template_has_variables"]:
            if f"{{{{{var}}}}}" not in template:
                failures.append(f"template should reference {{{{{var}}}}}, got {template!r}")
    if "template_min_length" in expected:
        if len(template) < expected["template_min_length"]:
            failures.append(
                f"template length should be >= {expected['template_min_length']}, got {len(template)}"
            )
    if "template_must_not_contain_any" in expected:
        # Word-boundary match so "off" doesn't trip on "coffee".
        import re as _re
        lc = template.lower()
        for needle in expected["template_must_not_contain_any"]:
            n = needle.lower()
            if _re.search(rf"\b{_re.escape(n)}\b", lc):
                failures.append(f"template must not contain word {needle!r}, got {template!r}")

    return len(failures) == 0, failures


def run_suite(write_to: Path | None = None) -> dict:
    """Programmatic runner — returns the payload dict instead of printing.
    Used by the /evals/run API route so the frontend can trigger a fresh run.
    Set `write_to` to overwrite `last_run.json` for the cached endpoint.
    """
    cases = load_cases()
    db = SessionLocal()
    results: list[dict] = []
    started_all = time.time()
    try:
        INTER_CASE_DELAY_S = 4.5
        for i, case in enumerate(cases, 1):
            if i > 1:
                time.sleep(INTER_CASE_DELAY_S)
            t0 = time.time()
            run_row, plan = plan_campaign(db, case["input_goal"])
            elapsed_ms = int((time.time() - t0) * 1000)
            passed, failures = evaluate(case, plan.model_dump())
            results.append({
                "id": case["id"],
                "passed": passed,
                "validation_status": run_row.validation_status,
                "provider": run_row.provider,
                "latency_ms": elapsed_ms,
                "failures": failures,
            })
    finally:
        db.close()

    total = len(results)
    passing = sum(1 for r in results if r["passed"])
    payload = {
        "passing": passing,
        "total": total,
        "pct": 100 * passing / max(1, total),
        "elapsed_seconds": round(time.time() - started_all, 2),
        "results": results,
    }
    if write_to is not None:
        write_to.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    return payload


def run() -> int:
    cases = load_cases()
    db = SessionLocal()
    results: list[dict] = []
    started_all = time.time()
    try:
        # Inter-case sleep keeps us comfortably under Gemini's 15 RPM free tier.
        # Without this, later cases bounce to the deterministic fallback.
        INTER_CASE_DELAY_S = 4.5
        for i, case in enumerate(cases, 1):
            if i > 1:
                time.sleep(INTER_CASE_DELAY_S)
            t0 = time.time()
            run_row, plan = plan_campaign(db, case["input_goal"])
            elapsed_ms = int((time.time() - t0) * 1000)
            passed, failures = evaluate(case, plan.model_dump())
            results.append({
                "id": case["id"],
                "passed": passed,
                "validation_status": run_row.validation_status,
                "provider": run_row.provider,
                "latency_ms": elapsed_ms,
                "failures": failures,
            })
            mark = "PASS" if passed else "FAIL"
            print(f"  [{i:>2}/{len(cases)}] {mark:<4} {case['id']:<40} {elapsed_ms:>6}ms  {run_row.validation_status}")
            if failures:
                for f in failures:
                    print(f"           - {f}")
    finally:
        db.close()

    total = len(results)
    passing = sum(1 for r in results if r["passed"])
    pct = 100 * passing / max(1, total)
    elapsed_total = time.time() - started_all

    print()
    print(f"  {passing}/{total} passing ({pct:.1f}%) — total {elapsed_total:.1f}s")
    print()

    out_path = Path(__file__).resolve().parent / "last_run.json"
    out_path.write_text(json.dumps({
        "passing": passing,
        "total": total,
        "pct": pct,
        "elapsed_seconds": round(elapsed_total, 2),
        "results": results,
    }, indent=2), encoding="utf-8")
    print(f"  Wrote {out_path}")

    return 0 if passing == total else 1


if __name__ == "__main__":
    sys.exit(run())
