"""Eval-harness UI surface.

Two endpoints:
  - GET  /evals/last      — read the cached last_run.json so the UI has something
                            to render without paying for an LLM round-trip.
  - POST /evals/run       — re-execute the suite, write last_run.json, return it.

The runner imports the harness module's run_suite() to avoid re-implementing
case discovery + assertions here. Both endpoints return the same shape so the
UI can swap one in for the other.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException

router = APIRouter(prefix="/evals", tags=["evals"])

EVALS_DIR = Path(__file__).resolve().parents[2] / "evals"
LAST_RUN = EVALS_DIR / "last_run.json"
CASES_FILE = EVALS_DIR / "campaign_planner_cases.json"


def _enrich(payload: dict) -> dict:
    """Decorate the raw runner output with metadata the UI cares about:
    file mtime (so the operator sees when this was last refreshed) and the
    per-case input goal (the runner only stores ids; we join from cases.json
    so the UI can show what was actually tested)."""
    enriched = dict(payload)
    if LAST_RUN.exists():
        enriched["generated_at"] = datetime.fromtimestamp(
            LAST_RUN.stat().st_mtime, tz=timezone.utc
        ).isoformat()
    # Hydrate per-case goals + expected-assertion summaries
    cases_by_id: dict[str, dict] = {}
    if CASES_FILE.exists():
        for c in json.loads(CASES_FILE.read_text(encoding="utf-8")):
            cases_by_id[c["id"]] = c
    for r in enriched.get("results", []):
        ref = cases_by_id.get(r["id"])
        if ref:
            r["input_goal"] = ref.get("input_goal")
            r["expected_summary"] = list((ref.get("expected") or {}).keys())
    return enriched


@router.get("/last")
def last_run() -> dict:
    """Return the cached last eval run, enriched with file mtime + per-case goals."""
    if not LAST_RUN.exists():
        return {
            "passing": 0,
            "total": 0,
            "pct": 0,
            "elapsed_seconds": 0,
            "results": [],
            "generated_at": None,
            "never_run": True,
        }
    raw = json.loads(LAST_RUN.read_text(encoding="utf-8"))
    return _enrich(raw)


@router.post("/run")
def run_now() -> dict:
    """Re-execute the suite right now and return the fresh result. Heavy —
    each case is a real LLM call. The harness already caps at the eval
    fixtures' size (~15 cases). Frontend should show a loader and disable the
    button while this is in flight."""
    import sys as _sys
    # Make the evals module importable
    if str(EVALS_DIR.parent) not in _sys.path:
        _sys.path.insert(0, str(EVALS_DIR.parent))
    try:
        from evals.run_evals import run_suite  # type: ignore
    except Exception as e:
        raise HTTPException(500, f"could not import eval runner: {type(e).__name__}: {e}")
    try:
        payload = run_suite(write_to=LAST_RUN)
    except Exception as e:
        raise HTTPException(500, f"eval run failed: {type(e).__name__}: {e}")
    return _enrich(payload)
