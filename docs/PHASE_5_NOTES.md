# Phase 5 — AI Campaign Planner + Analyst + Eval Harness

**Goal:** the centerpiece AI surfaces. Natural-language goal becomes a complete, validated, editable campaign plan. Post-run analyst grounds a plain-English insight in the actual numbers. An eval harness measures planner quality with 15 structural cases.

## What exists now

### Backend services
- `app/services/ai_campaign_planner.py` — NL goal → full plan with all the same guarantees as the merge explainer: Pydantic schema, one retry on validation failure, deterministic keyword fallback, `ai_runs` audit row.
- `app/services/ai_campaign_analyst.py` — post-run insight grounded in funnel + failures + channel mix + goal. Cached on `Campaign.ai_insight` so reopening a completed campaign doesn't re-call the LLM.
- `app/services/ai_segment_planner.py` — improved keyword extractor: handles "60+ days", "all three sources/systems", "lapsed" without explicit days, "3+ orders" / "N or more orders". Used as the fallback for both segment-only and campaign-level planners.

### API routes
- `POST /campaigns/ai-plan` — NL goal → structured plan + segment preview (count + sample). No persistence; just shows the marketer what they'd get.
- `POST /campaigns/ai-plan/create` — persists an AI plan as a Segment + Campaign draft. The Segment is tagged `created_by_ai=True` and prefixed `[AI] `. The Campaign's `ai_plan_json` stores the planner's message_angle, success_metric, suppression_notes, and the originating `ai_run_id`.
- `POST /campaigns/{id}/insight` — runs the analyst, caches the insight on the campaign row.

### Frontend
- **`/campaigns`** — AI campaign planner panel at the top:
  - NL prompt box with 4 sample prompts
  - "Generate plan" calls the planner
  - Panel below shows: provider/model/latency badge, **audience preview with count** (red if 0 so the marketer sees over-constrained plans), editable name, AI rationale, channel priority badges, editable message template with character + variable count, message angle, success metric, suppression notes, collapsible JSON viewer
  - "Create draft from plan →" persists and navigates to the campaign detail page
- **`/campaigns/[id]`** — AI post-run analyst panel:
  - Shows only when status != draft
  - "Generate insight" button calls the analyst
  - Renders headline + what_worked / what_didn't side-by-side + recommended next action, all with the provider/model/latency badge

### Eval harness
- `evals/campaign_planner_cases.json` — 15 structural test cases (see `evals/README.md` for the full list)
- `evals/run_evals.py` — runner with assertion DSL (`_at_least`, `_eq`, `loyalty_tiers_subset_of`, etc.). Inter-case 4.5s delay keeps us under Gemini's 15 RPM free tier.
- `evals/last_run.json` — cached pass/fail breakdown with provider + latency + validation_status per case.

**Latest run: 15/15 passing (100%)** — README documents the test cases and the evaluation strategy.

## End-to-end verification

Live test with prompt `"win back lapsed VIPs in Bengaluru with a 15% off offer, prefer WhatsApp"`:
- Provider: Gemini 2.5 Flash, latency ~10s, validation `ok`
- Plan name: *"Win Back Lapsed VIPs - Bengaluru (15% Off)"*
- Rationale: *"This campaign targets high-value, inactive customers in Bengaluru who hold Gold or Platinum loyalty status. The goal is to re-engage them with a compelling 15% discount, leveraging WhatsApp for direct and preferred communication."*
- Channel priority: `whatsapp → sms → email` ✓ (WhatsApp first as requested)
- Template: `Hi {{first_name}}, we've missed you at Brewhouse Co.! As a valued {{loyalty_tier}} member, enjoy 15% off your next order. Rediscover your favourite coffee with us. T&C apply.`
- Segment preview: **0 customers** — and that's the right behaviour. AND'ing lapsed + Bengaluru + gold/platinum + high-LTV yields no one in this seed data. **The preview surfaces over-constrained plans BEFORE the marketer commits.**

That last point is the demo's biggest defense moment: *"The AI produced a structurally perfect plan, but the deterministic preview caught that nobody matches it. The marketer loosens a filter and tries again — no broken campaign reaches a real customer."*

## Key defense one-liners

- **"How do you measure if your AI works?"** Open `evals/run_evals.py`, run it, point to the 15/15 pass table. Then show `last_run.json` — every case has provider, latency, validation_status, and any failures. Most candidates can't put a number on AI quality. This one can.
- **"What if the LLM hallucinates a field?"** Pydantic rejects the response. We retry once with the validation error appended to the prompt. If that fails, the deterministic keyword fallback produces a sensible plan. Every step is logged to `ai_runs` so the failure is visible, not silent.
- **"What if the LLM proposes a great plan but the audience is 0?"** The endpoint runs the segment query and returns the count alongside the plan. The UI renders 0 in amber with a "loosen filters" hint. The marketer never creates a draft for an empty audience.
- **"How does AI route channels?"** It doesn't. AI proposes the channel **priority list** as part of the plan. The deterministic routing engine (Phase 3) picks each customer's actual channel based on consent + contactability + the priority. AI sets policy; rules execute per row.
- **"Could the AI bypass consent?"** No. `suppression_rules.exclude_dnd` defaults to `true` (TRAI compliance) in both the LLM prompt and the fallback. The segment compiler enforces it regardless of what the LLM produces. The launch flow re-checks consent at dispatch time.
- **"Walk me through the analyst's grounding."** It receives a single JSON with the campaign's goal, segment summary, total_targeted, by_status, by_channel, by_routing_reason, events_by_type, and failure_reasons. The system prompt says "use the actual numbers from the input, do not hallucinate channels or events." Pydantic schema constrains the output shape. Same retry + fallback pattern.

## What's deliberately NOT in Phase 5

- **No AI-only execution surface.** The AI plan goes through the exact same Segment + Campaign storage as a hand-built draft. No code path branches on `created_by_ai`. Production multi-tenancy would gate AI features per brand permission, but execution is unified.
- **No streaming responses.** The campaign planner takes ~3-10s on Gemini Flash. Streaming would be polish for Phase 7; doesn't change the pattern.
- **No auto-launch.** Even after AI generates a perfect plan, the marketer lands on the editable campaign detail page and explicitly clicks Launch. By design.
- **No multi-turn refinement.** "Make the audience bigger" / "use a different angle" would require conversational state. Out of scope.

## Carry-forward for Phase 6 + 7

- The `ai_runs` table now has four purposes: `merge_explanation`, `segment_planner`, `campaign_planner`, `campaign_analyst`. The audit page renders all four uniformly.
- Phase 7 (deployment) will pin the prompt version + model in env vars and document the rollback path.
- Phase 6 (analytics) can pull the analyst's insights to build a multi-campaign retrospective view.
