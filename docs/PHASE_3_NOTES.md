# Phase 3 — Consent + segments + campaign drafts

**Goal:** the marketer workflow. Define audiences, draft campaigns, route per-customer to the right channel, preview before launch.

## What exists now

### Backend services
- `app/services/segment_engine.py` — Pydantic schemas (`AudienceCriteria`, `SuppressionRules`, `SegmentDefinition`), SQLAlchemy query compiler, `count()` / `sample()`, deterministic "why included" reasoning per customer, six pre-built templates.
- `app/services/channel_routing.py` — deterministic per-customer routing using consent + contactability + priority list. Returns `(channel, reason)` per customer. `route_segment()` aggregates across a whole segment for the pre-launch summary.
- `app/services/template.py` — `{{variable}}` extraction + render + per-channel length feedback (SMS 160/140, WhatsApp 4096/1024, Email no inline cap with soft 600, RCS 2500/1500). Validates against an allow-list of 10 variables.

### API routes
- `/segments/preview` — POST a definition, get count + sample with reasons
- `/segments` — save / list saved
- `/segments/templates` — six pre-built definitions for one-click cloning
- `/segments/variables` — fields available for use in audience criteria (frontend builder reads this)
- `/segments/{id}` — fetch / delete
- `/campaigns` — create / list / fetch
- `/campaigns/{id}` — fetch / update
- `/campaigns/{id}/preview` — template render against 3 samples + routing breakdown across the full segment

### Frontend pages
- `/segments` — side-by-side builder + live preview:
  - Pre-built templates strip (6 templates: Lapsed high-value, VIP, First-time, Multi-source, Active recent, WhatsApp-Bengaluru)
  - Form with recency / value / frequency / city chips / tier chips / source coverage / consent suppression
  - Live debounced preview (250ms): count + 5 sample customers with "why included" reasons
  - Save with name + description
  - Saved segments library with chip summaries + delete + "Use in campaign" link
  - Collapsible JSON definition viewer (auditability)
- `/campaigns` — list + new-draft panel:
  - Status badges (draft / launching / running / completed / failed)
  - Campaign cards with channel priority badges and segment metadata
  - Search-paramable: `/campaigns?segment_id=N` pre-fills the new-campaign form
- `/campaigns/[id]` — full editor:
  - Inline editable name
  - Goal textarea + segment selector
  - Channel priority list (reorder ↑↓, add/remove channels from the priority list)
  - Message template editor with variable picker chips + length counter + unknown-variable validation
  - **Pre-launch routing breakdown**: stacked bar showing the segment split by channel + skipped reasons (DND / no eligible channel / no contactability)
  - **3 sample customer renders** with per-channel length feedback (SMS warns at 140, etc.)

## The numbers on the seed data

A segment of "lapsed >= 60 days, LTV >= ₹5,000, exclude DND, any-channel consent" returns:
- **25 customers**
- Routing breakdown with priority `[whatsapp, sms, email]`:
  - **18 → WhatsApp** (opted-in, has phone)
  - **6 → SMS** (no WhatsApp consent, but SMS opted-in)
  - **1 → Email** (no WhatsApp/SMS consent, but email opted-in)
  - **0 skipped** (100% reachable on this audience)

This is the demo's "FDE day-1 value" moment: marketer types criteria, instantly sees which 25 people qualify, which channel each goes through, and why.

## Key defense one-liners

- **"Why a JSON segment definition instead of letting an LLM write SQL?"**
  Three reasons: SQL injection surface, lack of structural validation, and customers can't trust opaque queries. The structured definition is auditable — open the collapsible viewer to see the JSON. Phase 5's AI campaign planner *proposes* a definition; the deterministic compiler executes it.
- **"How does multi-channel routing actually decide per customer?"**
  Walk the priority list. For each channel, check: customer has the right contact field (phone for WhatsApp/SMS/RCS, email for email) AND opted in to that channel AND not DND. First match wins. If nothing matches, customer is skipped with a specific reason. Code lives in `app/services/channel_routing.py`, 40 lines.
- **"What if AI decides a channel that a customer can't receive on?"**
  AI sets the *priority list policy*, not per-customer routing. The deterministic routing function then resolves each customer to one channel honoring consent and contactability. Even a confused LLM can't accidentally send WhatsApp to a customer who opted out.
- **"Why does the segment exclude DND by default?"**
  TRAI compliance. In India, the National Do-Not-Disturb registry is legally binding for commercial communication. The default in the builder is checked; explicit opt-out requires unchecking. This is non-negotiable in production and the UI mirrors that.
- **"Why are there six pre-built templates instead of asking AI to generate them?"**
  Recoverable starting points. A marketer can clone "Lapsed high-value" and tweak the threshold without learning the schema. AI generation is for the *specific* goal in front of the marketer (Phase 5); templates cover the *general* shapes.
- **"What happens if I change a saved segment's underlying customer data?"**
  Saved segments store a snapshot count (`preview_count`) at save time. The definition itself runs fresh every time it's used in a campaign — so re-running a campaign next week against "lapsed >= 60d" picks up new lapsed customers automatically. The saved count is a marker, not the live audience.
- **"Walk me through template safety."**
  Three guards: (1) allow-list of 10 variable names; unknown variables surface as a red error before launch and the message-template editor warns inline. (2) Variables substitute *after* rendering, so no eval / no injection. (3) Per-channel length validation (SMS, WhatsApp, Email, RCS) prevents shipping a 2,000-char SMS that becomes 14 segments.

## What's deliberately NOT in Phase 3

- **No launch path yet.** Campaigns sit at status=`draft`. Phase 4 wires the channel simulator (separate FastAPI service on :8001) and the launch path: create `communications` rows, POST to `/send`, receive async webhooks, derive state.
- **No AI in this phase.** Phase 3 is the deterministic foundation. Phase 5 adds the campaign planner that turns a marketer goal into a structured plan (segment definition + channel priority + message angle) — and *every* piece of that AI output flows through the same services we just built.
- **No A/B variants or scheduling.** Possible future; not a Phase 0-7 line item.

## Carry-forward for later phases

- `Campaign.status` field will move through draft → launching → running → completed in Phase 4 as the channel simulator returns events.
- The `routing_breakdown` returned by `/campaigns/{id}/preview` will be the same shape used in Phase 4's launch endpoint — the marketer sees the breakdown, clicks Launch, and `communications` rows get created with `resolved_channel` set by this same function.
- Phase 5's AI campaign planner output schema will produce a `SegmentDefinition` + `priority` list — both directly consumable by what Phase 3 already built. No glue code needed.
