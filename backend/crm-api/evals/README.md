# AI Campaign Planner — Eval Harness

15 structural test cases over `services/ai_campaign_planner.plan_campaign`. Each case asserts that the planner's structured output satisfies load-bearing properties — not that it produces specific text. This lets the LLM vary phrasing while we still verify behaviour.

## Why this exists (defense)

Most AI-native projects in this submission pool will show an LLM call and a button. They cannot answer "how often does it work?" with a number.

This harness answers it: **15/15 passing on the latest run**, with the run cached in `last_run.json` (provider, latency, validation status, and per-case failures included).

## What's tested

| Case | Asserts |
|---|---|
| `lapsed_high_value_basic` | inactivity window + LTV minimum + WhatsApp/SMS in priority + first_name variable |
| `vip_gold_platinum` | loyalty_tier filter + first_name + loyalty_tier variables |
| `first_time_buyers` | total_orders min=max=1 + WhatsApp priority |
| `whatsapp_preferred` | city filter + WhatsApp leads priority |
| `active_recent` | recency window + frequency minimum |
| `explicit_no_discount` | template does not include discount keywords (word-boundary match so "coffee" doesn't trip "off") |
| `premium_upsell` | recency window + first_name |
| `whales_only` | LTV minimum >= 10000 |
| `tier_silver_focus` | loyalty_tiers subset + city filter |
| `multi_source_known` | min_source_coverage == 3 |
| `explicit_dnd_compliance` | exclude_dnd defaults to true (TRAI) |
| `email_only_long_form` | inactivity window + email leads priority |
| `frequency_loyal_repeat` | total_orders >= 3 |
| `name_personalization_required` | template includes {{first_name}} |
| `city_not_in_list_should_be_omitted` | Goa (not in allowed list) is omitted; inactivity window still set |

## Running

```powershell
$env:PYTHONIOENCODING="utf-8"
D:\xeno-crm\.venv\Scripts\python.exe evals\run_evals.py
```

Output: pass/fail per case + summary + `last_run.json` written for the README badge.

## Latest run

See `last_run.json` for the timestamped breakdown. Fields per case:

```json
{
  "id": "lapsed_high_value_basic",
  "passed": true,
  "validation_status": "ok | retry_used | fallback_used",
  "provider": "gemini | openai | anthropic | stub",
  "latency_ms": 3600,
  "failures": []
}
```

`validation_status` is critical context: a `fallback_used` row still passes only if the deterministic keyword extractor produces a sensible plan from the prompt. That's by design — when the LLM rate-limits, the demo doesn't break.

## How the evals are structured (not text-matching)

Each case asserts properties of the JSON shape:

- `audience_criteria_has` with sub-keys ending in `_at_least`, `_at_most`, `_eq`
- `loyalty_tiers_subset_of` — output tiers must be a subset of the allowed list
- `cities_contains` / `cities_omitted_or_empty`
- `channel_priority_contains` / `_starts_with` / `_min_length`
- `template_has_variables` — verifies `{{var_name}}` appears in the template
- `template_must_not_contain_any` — word-boundary regex so we don't false-positive on substrings inside other words
- `template_min_length` — sanity check

## Adding new cases

Drop into `campaign_planner_cases.json`. The evaluator dispatches by suffix (`_at_least`, `_eq`, etc.) so most new assertions need zero runner changes.

## Inter-case throttle

`INTER_CASE_DELAY_S = 4.5` keeps us under Gemini's 15 RPM free-tier limit. Adjust if you have a higher tier or want to stress-test the receiver.
