"""Pydantic schemas for AI structured outputs.

Every AI surface in the app validates LLM responses against one of these schemas.
Validation failures fall back to deterministic output and are flagged in `ai_runs`
so we can defend "what happens if the model returns garbage?" in interviews.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class MergeExplanationOutput(BaseModel):
    """AI explanation of a flagged identity merge."""

    explanation: str = Field(
        ...,
        min_length=20,
        max_length=600,
        description="One- or two-sentence plain-English explanation of why the system "
        "believes these source rows represent the same person, calling out the "
        "evidence (matching name tokens, same city, etc.) and the missing anchors "
        "(no shared phone or email).",
    )
    confidence_assessment: str = Field(
        ...,
        min_length=10,
        max_length=200,
        description="A short statement of how confident a reviewer should be, and why.",
    )
    recommendation: Literal["approve", "review", "reject"] = Field(
        ...,
        description="approve = high confidence, can auto-merge; review = needs a human "
        "look but probably the same person; reject = looks like a false positive.",
    )
