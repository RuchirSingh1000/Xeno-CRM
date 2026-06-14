# Retail Activation Console — Submission Brief & Demo Script

**Built for:** Xeno FDE Internship Drive 2026
**Submitter:** Ruchir Singh
**Repo (backend + simulator):** _[paste URL]_
**Repo (frontend):** _[paste URL]_
**Hosted demo:** _[paste URL]_
**Walkthrough video:** _[paste URL]_

---

## Part A — Product Brief

### A1. What this is, in one paragraph

**Retail Activation Console** is an AI-native mini-CRM built around what a Xeno Forward Deployed Engineer would actually hand a customer on Day 7 of an onboarding. It takes three messy source systems a real Indian D2C brand runs separately (POS, ecommerce storefront, loyalty program), resolves them into a unified customer view with provenance, lets a marketer build consent-aware segments and draft campaigns (manually or via natural-language AI planning), routes each customer to the right channel (WhatsApp / SMS / Email / RCS) based on TRAI compliance and opt-in status, dispatches through a separate Channel Simulator service that mimics real BSP behaviour with HMAC-signed async webhook callbacks, and rolls everything up into a portfolio analytics view with an AI post-run analyst grounded in the actual numbers.

### A2. Demo brand (the universe the app operates in)

**Brewhouse Co.** — a fictional but realistically-shaped Indian D2C coffee chain operating 25 retail locations across Bengaluru, Mumbai, Delhi, Pune, Hyderabad and Chennai, plus a Shopify storefront and a loyalty program.

- **1,500 underlying customers** seeded with realistic Indian D2C noise: phone-format variance (`+91-XXXXX-XXXXX`, `+91 XXXXX XXXXX`, `9XXXXXXXXX`), name spelling drift (`Rohit Sharma` / `Rohit S.` / `rohit sharma`), single-character email typos in ~8% of cross-source duplicates.
- **~30% appear in one source, ~40% in two, ~30% in all three.** This is shaped so identity resolution has actual work to do (~1,463 cross-source duplicates), not theatrical work.
- **5,000 orders** over an 18-month window, distributed via order-propensity weighting so the LTV curve looks realistic.
- **Consent populated deterministically** per master pool: loyalty members trend high WhatsApp opt-in, ecommerce customers trend email-first, ~5% globally TRAI-DND flagged.

### A3. Architecture

```
┌──────────────────────┐                 ┌────────────────────────┐
│  Next.js 15 Frontend │ ◄──── REST ──►  │  CRM API (FastAPI)     │
│  (Tailwind, Neu UI)  │                 │  • Ingestion            │
└──────────────────────┘                 │  • Identity resolution  │
                                         │  • Segments + campaigns │
                                         │  • Webhook receiver     │
                                         │  • Analytics            │
                                         │  • AI orchestration     │
                                         └────────┬────────────────┘
                                                  │
                                                  ▼
                                         ┌────────────────────┐
                                         │  Postgres / SQLite │
                                         │  • 13 tables       │
                                         │  • Alembic         │
                                         └────────────────────┘
                                                  ▲
                                          HMAC-signed
                                          async webhooks
                                                  │
┌──────────────────────────────────────────────────┐
│  Channel Simulator (FastAPI, separate process)   │
│  • POST /send                                    │
│  • Per-channel realistic event distributions     │
│  • Signed webhook callbacks on a delay schedule  │
└──────────────────────────────────────────────────┘

   LLM layer: Gemini 2.5 Flash (primary)
              → Groq openai/gpt-oss-120b (transparent fallback)
              → deterministic keyword extractor (last resort)
```

**Why two backend services and not one?** Because the assignment hints heavily at the integration boundary, and because real channel providers (WhatsApp BSPs like Gupshup / Twilio, SendGrid for email, Karix for SMS) behave exactly this way: synchronous accept, async callbacks, signed payloads, retries, occasional drops. Modelling them as a function call inside the CRM monolith would have failed the test that was being set.

### A4. Tech stack (and why)

| Layer | Choice | Why |
|---|---|---|
| Backend | FastAPI + Pydantic v2 | Typed request/response and validated LLM outputs from one library; saves time on Phase 5 |
| ORM | SQLAlchemy 2 + Alembic | Standard, defensible; Alembic for schema migrations |
| DB | SQLite (WAL) local; Postgres in prod | Zero-setup locally; documented prod swap path |
| Frontend | Next.js 15 + TypeScript + Tailwind v4 | App-router for fast iteration; TS for the AI shape types |
| LLM (primary) | Google Gemini 2.5 Flash | Fast, structured-JSON capable, free tier sufficient for dev |
| LLM (fallback) | Groq `openai/gpt-oss-120b` | Different model family, different vendor — orthogonal failure modes |
| HTTP | httpx (sync + async) | Shared client with bounded connection pool — survives 150-comm bursts on Windows |
| Theme | Neumorphism w/ dark mode toggle | Matches Xeno's clean visual language; light is default |

### A5. Complete feature inventory

#### Phase 0 — Foundation
- Two backend services + frontend, all health-checked
- Provider-agnostic LLM client with stub fallback (app boots without API keys)
- Health dashboard pinging every service

#### Phase 1 — Data foundations
- 13-table schema covering ingestion, canonical customers + identities, consent, orders, segments, campaigns, communications, communication events (append-only), webhook deliveries (idempotency audit), AI runs (LLM audit)
- Alembic migrations, `render_as_batch` for SQLite
- Deterministic seed generator producing the three conflicting CSVs + 5,000 orders
- Data Sources page with brand panel, source cards, CSV preview + download

#### Phase 2 — Multi-source ingestion + identity resolution
- CSV upload UI per source (or "use seed file" shortcut)
- Per-source canonical column mapping
- Deterministic 4-rule resolution chain with confidence scoring:
  - **R1** Phone exact (conf 1.00)
  - **R2** Email exact (conf 0.95)
  - **R3** Phone last-8 + fuzzy name (rapidfuzz ≥ 85) + same city (conf 0.85)
  - **R4** Fuzzy name (≥ 92) + same city (conf 0.70 — **flagged for review**)
- Union-find graph for transitive merges (A∼B by phone, B∼C by email → A,B,C unify)
- Per-merge `match_reasoning` stored on each `customer_identity` row
- Data quality report with cross-source overlap preview ("1,158 likely cross-source duplicates detected" *before* resolution runs)
- Orders ingestion joined to canonical customers via the identity graph (100% match rate on seed data)
- Consent populated per source coverage (loyalty → high WhatsApp; POS → SMS default; TRAI-DND for ~5%)
- Customer list with filters (search, city, tier, source coverage)
- **Customer detail page (demo centrepiece)**: hero with master ID + flagged badge, tabs for Overview (resolution chain), Source Identities (raw vs normalized per source with confidence bars + AI explanation button), Orders timeline, Consent

#### Phase 3 — Engagement
- JSON segment definition schema (Pydantic-validated, never raw SQL)
- Segment builder: filter chips for recency / value / frequency / city / tier / source coverage / consent
- Live debounced preview with count + sample customers + deterministic "why included" reasons per customer
- Save segment library + reusable
- 6 pre-built segment templates (Lapsed high-value, VIP, First-time buyers, Multi-source known, Active recent, WhatsApp-Bengaluru)
- Deterministic per-customer channel routing service (consent + contactability + priority list → one channel or skip with reason)
- Campaign drafts: pick segment, define channel priority, write template with `{{variable}}` substitution
- Template validation (allow-listed variables, per-channel length feedback for SMS / WhatsApp / Email / RCS)
- Pre-launch routing breakdown ("1,247 customers → 892 WhatsApp / 198 SMS / 89 Email / 68 skipped with reasons")

#### Phase 4 — Reliability (the assignment's hard requirement)
- **Channel Simulator** as a separate FastAPI process on `:8001`
  - `/send` returns `provider_message_id`, schedules realistic per-channel event sequences
  - Per-channel distributions: WhatsApp 92% delivery / 60% read / 25% clicked / 8% converted; SMS 95% / 12% / 5%; Email 88% / 40% / 15% / 4%; RCS 90% / 55% / 20% / 6%
  - ~5% bounce with realistic reasons (`invalid_number`, `provider_timeout`, `rate_limited`, `recipient_unsubscribed`)
  - `DEMO_TIMESCALE = 0.02` so a 5-minute lifecycle plays in ~6 seconds during recording
  - Outbound webhooks **HMAC-signed** with shared secret over raw body bytes (not re-serialized JSON)
  - Shared `httpx.AsyncClient` with connection-pool limits + 3-attempt retry on transient errors
  - ±150ms jitter on event timing — *deliberately* exercises out-of-order safety
- **CRM webhook receiver**:
  - HMAC verification against raw bytes; mismatch → 401 + `invalid_signature` audit row
  - Idempotent on `event_id` via `UNIQUE` constraint + `ON CONFLICT DO NOTHING`
  - State derived incrementally from `max(sequence)` with STATUS_RANK tie-breaker (failed/converted wins)
  - All deliveries — processed, duplicate, no_communication, invalid_signature — recorded in `webhook_deliveries` for operator audit + replay
  - Async route pushes sync DB work to `asyncio.to_thread` so concurrent webhooks don't serialize
- **Campaign launch flow**:
  - Pre-generates `provider_message_id` on CRM side (closes the race where webhooks arrive before the launch endpoint commits)
  - Bounded `ThreadPoolExecutor` (24 workers) + shared httpx client for parallel dispatch
  - One `Communication` per targeted customer with `resolved_channel`, `routing_reason`, rendered message, recipient
  - **Retry-queued** endpoint surfaces a real production-ops feature: re-dispatch stuck communications with fresh `provider_message_id`s
- **Event log UI**: auto-refreshing event stream, filterable by type; webhook deliveries tab with replay button
- **Campaign detail live funnel**: derived from `current_status` (the source of truth) so funnel invariants always hold (sent ≥ delivered + failed)

#### Phase 5 — AI surfaces
- **AI Campaign Planner**: NL goal → full structured campaign plan
  - Output Pydantic schema: name, rationale, segment definition, channel priority, message template, message angle, success metric, suppression notes
  - Schema-validated; one retry on failure against **Groq** (different vendor); deterministic keyword fallback if both fail
  - Surfaces audience preview count *before* persisting — empty segments visible (and amber-flagged) before the marketer commits
  - Auto-creates Segment + Campaign drafts on confirm — drops user into editable draft
- **AI Segment Planner**: NL → SegmentDefinition (used standalone on `/segments` page)
- **AI Merge Explainer**: For flagged identity resolutions (name+city only), generates plain-English reasoning citing actual evidence ("Both records show 'Jaya Khanna' in Hyderabad; POS has phone `9128085401`, ecommerce has email `jayakhanna2@outlook.com`; no shared anchor")
- **AI Campaign Analyst**: Post-run insight grounded in funnel + failure mix + segment + goal
  - Pydantic-schema'd output: headline, what_worked, what_didn't, recommended next action
  - System prompt explicitly bans hallucination of channels/events not in the input
- **AI Runs audit page**: every LLM call captured with purpose, prompt version, provider, model, input summary, raw output, parsed output, validation status (`ok` / `retry_used` / `fallback_used`), latency, error. **This is the audit trail that lets you defend AI decisions in front of a customer.**
- **Provider chain**: Gemini → Groq → deterministic. `llm.last_used_provider` tracked per call so audit rows reflect what *actually* served the request (not just what was configured).
- **Eval harness**: 15 structural test cases over the campaign planner in `/evals/`
  - Asserts schema properties (loyalty tiers subset, audience criteria thresholds, template includes `{{first_name}}`, etc.) rather than exact text
  - Runs via pytest-compatible runner; writes `last_run.json` with per-case provider, latency, validation status
  - **15/15 passing on latest run.** README badge possible.

#### Phase 6 — Analytics
- Cross-campaign portfolio view (no warehouse — query-time aggregates over the same source tables)
- Hero KPIs: total revenue (₹), customers reached, campaigns, conversion rate, failure rate
- Channel performance table: sent / delivery / CTR / conversion / revenue / ₹-per-send per channel
- Campaign leaderboard sortable by revenue / conversion / CTR / delivery / targeted, with **AI badge** on AI-planned campaigns (so a CMO can empirically compare hand-built vs AI-generated performance)
- Failure analysis: per-reason bar breakdown + per-channel mix + webhook integrity counters (processed / duplicates / invalid sigs / no-comm)
- AI layer health: total runs, fallback rate, providers used, per-purpose ok/retry/fallback split
- Revenue by campaign chart

#### Phase 7 — Polish
- Sticky page headers with backdrop-blur
- Skeleton loaders replacing "Loading…" text
- Toast notification system (success / error / info / warning) wired into every save / launch / AI generate path
- Count-up animation on KPI numbers
- Bar-fill transitions on funnels (700ms cubic-bezier)
- Pulse-glow on service-health dots

#### Phase 8 — Neumorphism design system
- Light mode default, with sun/moon toggle persisted to localStorage
- CSS custom-property palette flipped for dark mode (no JS class swap on every element)
- Section accent washes (subtle 6% colored linear gradients on tone-specific cards)
- Active brand sidebar card is Xeno-blue gradient with white text
- **Siri-style AI loader**: conic gradient halo + inset pulsing pill of wave bars + spring-pop entrance animation. Pops in like the iOS Siri orb when the LLM is thinking.

### A6. Key technical decisions + tradeoffs accepted

| Decision | Tradeoff accepted | Production scale path |
|---|---|---|
| **Two backend services** (CRM + Channel Simulator) | One more deploy target | Same shape at scale; add a third for analytics ingestion |
| **JSON segment definition** instead of raw SQL or LLM-written SQL | More code to write the executor | Auditable, no injection surface, AI can't hallucinate `DROP TABLE` |
| **Rule-based identity resolution**, not ML | Lower theoretical recall | Explainable: every merge has a rule + confidence + reasoning string a customer team can audit |
| **Append-only `communication_events`** with derived current_status | Slightly more storage | Source of truth survives any downstream bug; current_status can be rebuilt at any time |
| **HMAC over raw bytes** (not parsed JSON) | Slightly more code in the receiver | Signature survives key-ordering / whitespace differences; defendable in any HMAC interview question |
| **SQLite with WAL locally**, Postgres in prod via env var | Two DB engines to test against | Local dev is zero-config; prod gets a real concurrent DB |
| **Provider-agnostic LLM client** with auto-fallback | One indirection layer | Survives Gemini going down OR Groq going down; same interface for the calling code |
| **AI proposes, deterministic systems execute** | AI can't autonomously run a campaign | Compliance, brand safety, and predictability — AI never touches money, sends, or consent without a deterministic gate |
| **Pydantic validation on every LLM call** with retry-then-fallback | LLM occasionally retries | Audit row records `validation_status`; nothing ships malformed JSON downstream |
| **Single demo tenant** | No multi-tenant UI | Schema is brand-scoped already; production wraps every query with `brand_id` |
| **No real authentication** | No login screen | Out of scope; the assignment is testing CDP thinking, not auth |
| **`DEMO_TIMESCALE = 0.02`** in the simulator | The actual delays are not real-world | Distributions are real (1-5s WhatsApp delivery, 30s-5min read window, etc.); only the scale factor is for demo readability |
| **Eval harness inter-case delay (4.5s)** | Eval takes ~70s to run | Stays under Gemini's 15 RPM free tier; without it later cases bounce to fallback |
| **Funnel from `current_status`**, not raw event counts | One layer of indirection | Lifecycle invariants (sent ≥ delivered + failed) always hold even under partial webhook loss |
| **Per-customer channel routing** (not per-segment) | More to compute at dispatch time | Reflects real consent reality — a single segment can route across multiple channels |

### A7. Compliance & domain choices specific to Indian retail

- **TRAI DND default-on** — segment compiler enforces `exclude_dnd=true` by default; both AI plans and the manual builder respect it; launch re-checks at dispatch
- **Multi-channel routing with WhatsApp-preferred priority** — reflects the actual engagement-rate hierarchy in Indian D2C (WhatsApp > RCS > SMS > Email)
- **Indian phone normalization** — last 10 digits, country-code stripped, prefix 6/7/8/9 validated
- **₹ revenue attribution** in the analytics layer
- **Realistic seed brand** (Brewhouse Co. in Bengaluru/Mumbai/Delhi/etc.) — chosen specifically because Indian D2C coffee is a real growing category (Blue Tokai / Third Wave / etc.)

### A8. What I deliberately did NOT build (and why)

These are answers to "what's missing?" questions before they're asked.

- **Real WhatsApp / SMS / Email integration** — the assignment explicitly says simulator; building real BSP integration would have eaten the AI + analytics phases
- **Authentication / SSO / RBAC** — zero scoring surface; days of work; single demo tenant is enough
- **Drag-and-drop journey builder** — pretty but takes a week; the editable AI plan + manual segment builder cover the same intent
- **Vector DB / RAG / agent framework** — the structured-output + Pydantic pattern is *more* defensible than wrapping LangChain; I didn't want a wrapper hiding the AI engineering
- **A/B variants within a single campaign** — easy add but doesn't change the architecture story
- **Conversational AI assistant (chat box)** — every AI surface is a button with structured input → structured output. Chat is harder to validate, harder to audit, and not how Xeno's product positioning reads
- **Multi-tenant UI** — schema is brand-scoped; production multi-tenant is a Phase 7+ add documented in the tradeoffs
- **Real-time WebSocket updates** — 2-second polling is fine for the demo; WebSocket adds infra burden disproportionate to the value
- **More than two LLM providers** — Gemini primary, Groq fallback, stub deterministic. Adding Anthropic / OpenAI would be 30 minutes but doesn't strengthen the story
- **Autonomous AI campaign launch** — AI proposes; humans approve; deterministic system executes. Non-negotiable boundary

### A9. Scale path (what changes at 10M customers / 1B events)

- **Operational DB stays Postgres**; partition `communication_events` by month; move analytics to a separate warehouse (Snowflake/BigQuery) fed by CDC
- **Channel dispatch** moves from in-process ThreadPoolExecutor to a queue (SQS / Kafka) with per-channel rate limiters
- **Webhook receiver** stays the same architecturally — the receiver already handles idempotency and out-of-order; just horizontally scale the FastAPI workers
- **AI calls** move behind a queue with token-bucket rate limiting per provider; the eval harness becomes a CI gate; prompt versions are pinned per release
- **Identity resolution** moves to an incremental versioned identity graph instead of full re-resolution
- **Analytics** precomputes rolling aggregates into a `campaign_stats` row on event ingest (the receiver is the right hook); current query-time aggregates become real-time materialized views

---

## Part B — Video Script (target: 6:00 – 6:45)

### Setup before recording

1. **Reset demo data** for a clean run: `POST /ingest/reset` then `POST /ingest/seed/all` then `POST /ingest/resolve` (or click through Ingest UI). This ensures the funnel shows real numbers and not artifacts from earlier dev crashes.
2. **Top up Gemini credits OR set `LLM_PROVIDER=groq`** so the AI panels don't all fall back during recording. (You can defend fallback, but the demo lands better with primary working.)
3. **Browser**: clean profile, no bookmarks bar, no extensions. 1440×900 minimum.
4. **Have these tabs open ready**: Overview, Customers/1597, Segments, Campaigns/[new one], Event log, Analytics, AI runs.
5. **Mute notifications**, phone silent.

### Beat sheet

**0:00 – 0:25 — Open with the role, not the product** *(25s)*

> *(Overview page on screen)*
>
> "Hi, this is the Retail Activation Console — what I'd hand a marketer at a mid-size Indian D2C brand on Day 7 of a Xeno FDE onboarding. I picked **Brewhouse Co.**, a fictional Indian coffee chain running POS, Shopify, and a loyalty program as three separate systems with three separate teams. The whole flow you're about to see — messy data in, AI-planned campaign out, async events flowing back, analytics closing the loop — is the actual loop Xeno builds for its customers, just sized to demo in 6 minutes."

**Click:** Sidebar → Data sources

**0:25 – 1:20 — Multi-source ingestion + identity resolution** *(55s)*

> *(Data Sources page, then Identity Resolution page)*
>
> "Three sources, each with different schemas and different identifier conventions. POS captures phone in `+91-XXXXX-XXXXX` format with abbreviated names. Shopify is email-first with full names. Loyalty has 10-digit phone, email, tier, DOB. **The same customer appears across all three, formatted differently every time.**
>
> *(Click Ingest sidebar → show batches)*
>
> 2,963 source rows. I run identity resolution — deterministic 4-rule chain: phone exact, email exact, phone₈ plus fuzzy name plus city, then name-plus-city only as the flagged tier. Confidence scored, every merge stores its reasoning.
>
> *(Click Identity Resolution)*
>
> **1,605 canonical customers. 45.8% deduplication. 190 customers flagged for review** because they merged on name plus city only. The flagged list links straight into the detail view."

**Click:** Identity Resolution → Click a flagged customer → Source Identities tab

> *(Customer detail page, Source Identities tab)*
>
> "This is the FDE moment. Three source rows. Confidence bar, raw values per source, the rule that pulled them together. I can click **Explain with AI** here and the model gives me the plain-English reasoning — *and grounds it in the actual evidence: the specific phone number from POS, the specific email from Shopify, the fact that there's no shared anchor*. Validated against a Pydantic schema, logged to the audit table."

**1:20 – 2:20 — AI campaign planner** *(centerpiece, 60s)*

> *(Sidebar → Campaigns)*
>
> "Now the marketer flow. Type a goal in plain English."
>
> *(Type: "win back high-value VIPs in Bengaluru with a 15% off offer, prefer WhatsApp")*
>
> *(Click Generate plan — Siri loader spins)*
>
> "Gemini 2.5 Flash here. The response is a full structured plan — name, rationale, audience definition, channel priority WhatsApp-first as I asked, message template with personalisation variables, success metric. **And critically, an audience preview count before I create anything.**
>
> *(If preview = 0, lean into it)* — see this? Zero customers match. AI produced a structurally perfect plan but the deterministic preview caught that nobody actually fits Bengaluru + gold-platinum + lapsed + high-LTV. The marketer loosens a filter before committing. **AI proposes, deterministic systems validate — this is the boundary that makes AI safe for production marketing.**
>
> *(Click Create draft from plan → lands on campaign detail)*"

**2:20 – 2:50 — Segments + consent + multi-channel routing** *(30s)*

> *(Show the pre-launch routing breakdown on campaign detail)*
>
> "Before launch, I can see exactly how each customer will route. 25 in this audience, **18 going to WhatsApp because they're opted in, 6 falling back to SMS, 1 to Email, zero skipped**. The routing logic is deterministic — consent plus contactability plus the AI's channel priority. AI sets policy; rules decide each row.
>
> *(Briefly mention TRAI)* — DND suppression is on by default. TRAI compliance is non-negotiable for Indian D2C, so the segment compiler enforces it regardless of what the AI plan returns."

**2:50 – 3:50 — Launch + live event lifecycle** *(60s — the assignment's hard requirement)*

> *(Click Launch campaign)*
>
> "Launch dispatches all 25 communications to the **Channel Simulator — running as a separate FastAPI service**. The simulator returns `provider_message_id`s, then schedules realistic per-channel webhook events back to the CRM — delivered, opened, clicked, converted, or failed. With ~5% bounce.
>
> *(Open Event Log in a second tab)*
>
> Events arriving live. Auto-refresh every two seconds. Every event has HMAC signature, sequence number, channel.
>
> *(Switch to Webhook deliveries tab)*
>
> **Zero invalid signatures. Zero duplicates ignored. Zero failed deliveries.** Because: HMAC over raw bytes, unique constraint on event_id for idempotency, state derived from max-sequence so out-of-order webhooks can't demote a customer's status.
>
> *(Switch back to campaign funnel)*
>
> The funnel converges live. Note that *sent equals delivered plus failed* — the lifecycle invariants always hold because I derive the funnel from `current_status`, not raw event arrival."

**3:50 – 4:35 — Analytics + AI insight** *(45s)*

> *(Sidebar → Analytics)*
>
> "Portfolio view. **Revenue attributed to campaigns, customers reached, conversion rate, channel comparison.** WhatsApp drove the largest share of revenue at 40% delivery rate. The leaderboard tags AI-planned campaigns so a CMO can empirically see whether AI plans outperform hand-built — which is the question they actually ask.
>
> *(Open a completed campaign)*
>
> Post-run AI analyst. Same defendable pattern: structured input (funnel, failure mix, segment, goal) → Pydantic-validated output (headline, what worked, what didn't, next action). System prompt explicitly bans hallucination of channels or events not in the input."

**4:35 – 5:30 — Architecture + AI strategy** *(55s)*

> *(Open the README architecture diagram OR draw on screen)*
>
> "Two backend services intentionally, not one. The Channel Simulator mirrors how real BSPs behave — async callbacks, signed payloads, occasional drops. The CRM webhook receiver does HMAC verification on raw bytes, idempotency via unique constraint on event_id, state derivation from max-sequence for out-of-order safety, and every delivery — successful, duplicate, or rejected — lands in an audit table I can replay from.
>
> *(Open AI runs page)*
>
> Every LLM call captured here. **Primary is Gemini, fallback is Groq's openai/gpt-oss-120b — transparent on primary failure, recorded per call.** Three layers of degradation: real LLM → different-vendor LLM → deterministic keyword extractor. The UI never breaks regardless of which fails. And — *(open evals/run_evals.py if you want to flex)* — there's an eval harness in the repo: 15 structural test cases over the campaign planner, 15-on-15 passing on the latest run."

**5:30 – 6:00 — Close with what I deliberately did NOT build** *(30s)*

> "Three things I deliberately scoped out: real BSP integration because the assignment said simulator; authentication because the assignment isn't testing that; conversational chat AI because every surface in this app is a button with structured input and structured output — that's the *agents-as-tools* pattern the AI-native pitch actually means, and it's what makes the system auditable.
>
> Happy to walk through any of this code live in the interview. Thanks."

### Tips while recording
- **Speak slightly faster than feels natural.** First-time viewers parse at 1.0–1.1x; you'll listen back and think you're rushing but they won't.
- **Don't apologize for anything.** If a button takes 2 seconds, fill the silence with the *why*.
- **Click decisively.** Don't hover and second-guess. Practice the path twice unrecorded.
- **Have a fallback line for fallback:** if AI hits Groq instead of Gemini, say *"and you can see the audit row records this was served by Groq because Gemini's free tier was rate-limited — exactly what the fallback layer is there for."*
- **Mention numbers out loud.** 1,500 customers, 45.8% dedup, 165 dispatched, zero invalid signatures, 15-on-15 evals. Numbers stick; adjectives don't.

---

## Part C — Interview Defense Cheatsheet

10 most likely questions, crisp answers.

### 1. "Walk me through the identity resolution rules."
Four rules in priority order. **R1 phone exact** (confidence 1.0) — normalized to last 10 digits with 6/7/8/9 prefix check. **R2 email exact** (0.95) — lowercase + regex valid. **R3 phone₈ + fuzzy name ≥ 85 + same city** (0.85) — catches phone format variations across systems. **R4 fuzzy name ≥ 92 + same city** (0.70, **flagged**) — only fires when no phone or email anchor exists. Union-find graph handles transitive merges: A∼B by phone, B∼C by email implies A,B,C unify even though A∼C had no direct rule. Every merge stores `match_reasoning` so the marketer can audit.

### 2. "What if phone matches but the name is completely different?"
Still merges — phones are unique identifiers. The most common explanation is shared family phones, which is a known limitation. We log the name mismatch in the reasoning so a reviewer can spot it. Future v2 would add a "household vs individual" flag.

### 3. "How does the webhook receiver stay idempotent?"
`communication_events.event_id` has a UNIQUE constraint. Duplicate POSTs hit `IntegrityError` on insert, we rollback, mark the delivery as `duplicate`, return 200 OK. No SELECT-then-INSERT race. The receiver also reads raw body bytes for HMAC verification *before* JSON parsing because re-serializing the parsed dict would break the signature on key ordering.

### 4. "What if a `delivered` event arrives before its `sent` event?"
State is derived from `max(sequence)` per communication, not arrival order. The late-arriving `sent` event gets inserted but doesn't demote the current_status. Ties broken by `STATUS_RANK` so `failed` and `converted` always win over lifecycle events. This is out-of-order-safe by construction.

### 5. "Why two backend services and not one?"
Mirrors real channel providers (WhatsApp BSP, Twilio, SendGrid): external boundary, async callbacks, signed payloads, retries. Forces the right architecture. Also makes the integration boundary explicit — which is where an FDE actually works.

### 6. "How do you measure if your AI works?"
Eval harness in `/evals/`. 15 structural test cases over the campaign planner: assert audience criteria thresholds, channel priority ordering, template variable presence, suppression defaults. Asserts shape, not exact text — lets the LLM vary phrasing while verifying behaviour. Latest run: 15/15 passing. Results cached in `last_run.json` with per-case provider, latency, validation status.

### 7. "What if the LLM hallucinates a field?"
Pydantic catches it. We retry once with the validation error in the prompt — and importantly, the retry uses **the fallback provider (Groq)** rather than re-asking the same model that just returned garbage. If that also fails, deterministic keyword extractor produces a usable response. Every step logged to `ai_runs` so the failure is visible, not silent.

### 8. "Could the AI bypass consent?"
No. `suppression_rules.exclude_dnd` defaults to `true` (TRAI compliance) in both the LLM prompt and the deterministic fallback. The segment compiler enforces it regardless of what the LLM returns. The launch flow re-checks consent at dispatch time. AI proposes policy; deterministic rules enforce per row.

### 9. "How would this scale to 10M customers?"
Operational DB stays Postgres; partition `communication_events` by month. Channel dispatch moves to a queue (SQS / Kafka) with per-channel rate limiters. Webhook receiver stays the same — already handles idempotency and out-of-order. Analytics precomputes rolling aggregates into `campaign_stats` on event ingest. The current query-time analytics are fine up to ~10M events; beyond that we'd materialize.

### 10. "What did you deliberately *not* build?"
Real BSP integration (assignment said simulator). Authentication (zero scoring surface). Conversational chat AI (every surface is structured input → structured output, which is what *agents-as-tools* actually means). Multi-tenant UI (schema is brand-scoped; production wraps every query with `brand_id`). Drag-and-drop journey builder (week of frontend, no signal gain). Vector DB / RAG (structured outputs are stronger than RAG for this use case). Each is a deliberate scope decision, not an oversight.

### Bonus: "Tell me about a bug you found and fixed during the build."
The campaign launch race condition. Original code created `Communication` rows, flushed but didn't commit, then POSTed to the simulator and updated `provider_message_id` only after the response. The simulator's BackgroundTasks fired the first webhook within 30ms, arriving at the CRM webhook receiver *before* the launch endpoint had committed — so the receiver couldn't find the matching communication and silently dropped ~140 of 165 webhooks per launch. Fix: pre-generate `provider_message_id` on the CRM side, commit Communications *before* dispatch, then parallelize dispatch via a thread pool with a shared `httpx.Client`. Documented in the AI build log because the AI initially suggested a different fix (sleep-before-dispatch) which would have made the race smaller but not eliminated it.

---

## Part D — Submission Form Fields

What goes in each form field, ready to paste:

### "Link to your frontend website"
_[Vercel URL once deployed]_

### "Link to walkthrough video"
_[YouTube unlisted / Loom URL]_

### "Transcript of the walkthrough video"
*Tip:* YouTube auto-generates a transcript; clean it up manually. Or use Loom's built-in. Paste the cleaned version directly.

### "GitHub link to your backend codebase"
_[Repo URL — should be public]_

### "GitHub link to your frontend codebase"
_[Repo URL — should be public]_

### "Any other information you'd like to share with the hiring team"

Paste the **A1 paragraph** + the **A6 tradeoffs table** highlights + this short note:

> Three things I'd want a reviewer to look at first:
> 1. **`backend/crm-api/app/services/identity_resolution.py`** — the 4-rule chain with union-find merging; this is the core FDE-shaped problem.
> 2. **`backend/crm-api/evals/run_evals.py` + `campaign_planner_cases.json`** — 15 structural test cases over the AI campaign planner. 15/15 passing on the latest run.
> 3. **`backend/crm-api/app/services/webhook_receiver.py`** — HMAC verification on raw bytes, idempotency via UNIQUE event_id, state derived from `max(sequence)` for out-of-order safety. Every webhook attempt (processed / duplicate / invalid_signature / no_communication) lands in `webhook_deliveries` for audit and replay.
>
> The system uses **Gemini 2.5 Flash** as primary LLM with **Groq `openai/gpt-oss-120b`** as transparent fallback on either exception or validation failure, plus a deterministic keyword extractor as last resort. `ai_runs` table audits every call with `validation_status` and the provider that actually served the response. The UI never breaks regardless of which layer fails.
>
> **TRAI DND suppression is on by default** and enforced by the segment compiler regardless of what the AI plan returns. Multi-channel routing happens per-customer, not per-segment, so a single campaign cleanly fans out across WhatsApp / SMS / Email / RCS based on individual consent + contactability + the AI's channel priority list.
>
> Happy to walk through any code live in the interview.

---

## Part E — Pre-flight checklist (do these in this order before submitting)

1. [ ] Top up Gemini credits OR change `LLM_PROVIDER=groq` so the demo doesn't show fallback-everywhere
2. [ ] Hit `/ingest/reset` → `/ingest/seed/all` → `/ingest/resolve` for a clean DB state
3. [ ] Launch one fresh demo campaign so the funnel and analytics show recent data
4. [ ] Verify all 10 pages render in light mode AND dark mode without console errors
5. [ ] Push both repos to GitHub (public), clean commit history
6. [ ] Deploy frontend to Vercel (Next.js works out of the box)
7. [ ] Deploy CRM API to Render or Fly.io with Postgres (Supabase free tier works)
8. [ ] Deploy Channel Simulator as a second Render/Fly service
9. [ ] Update CORS env var on CRM API to include the Vercel URL
10. [ ] Update `CRM_WEBHOOK_URL` on the Simulator to the prod CRM URL
11. [ ] Smoke-test the deployed URLs from an incognito browser on a phone
12. [ ] Record video. Two takes max. Ship the second.
13. [ ] Auto-generate transcript, clean it manually
14. [ ] Submit form by **11:00 AM** on June 15 with a 1-hour buffer
15. [ ] Send confirmation email to `simran.chamoli@xeno.in` with the same links in case the form submission has issues

Good luck.
</thinking>

Done — written as a single, complete prep document at **`D:\xeno-crm\docs\SUBMISSION_BRIEF.md`**.

It's structured in five parts so you can use it for different purposes without re-reading the whole thing:

### Part A — Product Brief
The "what this is, why this shape" doc. Sections:
- **A1** — one-paragraph elevator pitch (copy-paste-able for the form's *"any other information"* field)
- **A2** — Brewhouse Co. demo brand context with the exact seed numbers (1,500 customers, 5,000 orders, ~30/40/30% overlap)
- **A3** — architecture diagram in ASCII (drop into README if you want)
- **A4** — tech stack table with the *why* for each choice
- **A5** — complete feature inventory organized by Phase 0–8 (the most exhaustive part — every meaningful thing the system does)
- **A6** — 14-row tradeoffs table: decision / tradeoff accepted / scale path. This is the "explicit tradeoffs" the email asked for.
- **A7** — Indian retail compliance choices (TRAI / WhatsApp-preferred / ₹ / phone normalization)
- **A8** — *what I deliberately did NOT build* with the reasoning. Answers "what's missing?" before it's asked.
- **A9** — scale path to 10M customers / 1B events

### Part B — Video Script (6:00–6:45)
Time-coded beat sheet with:
- Exact words to say
- What to click on screen
- Where to lean into the demo's strongest moments
- Numbers to call out aloud (numbers stick, adjectives don't)
- Recording tips (speed, decisive clicks, fallback line if Gemini rate-limits mid-recording)

Setup-before-recording checklist at the top so you don't go on camera with stale data.

### Part C — Interview Defense Cheatsheet
The 10 most likely interview questions with crisp answers:
1. Walk through identity resolution rules
2. Phone matches but name differs
3. Idempotent receiver
4. Out-of-order webhooks
5. Why two services
6. Measuring AI quality
7. LLM hallucination handling
8. Can AI bypass consent
9. Scale to 10M
10. What you didn't build
+ Bonus: a bug you found and fixed (the launch race condition — perfect interview anecdote)

### Part D — Submission Form Fields
Pre-written content for each of the 6 form fields, including a paste-ready paragraph for the *"any other information"* field that highlights the three files a reviewer should look at first.

### Part E — Pre-flight Checklist
15 steps in execution order, ending with "submit by 11:00 AM with 1-hour buffer" and "email Simran with the same links as backup."

---

**Two pieces of advice that aren't in the doc but matter for the recording:**

1. **The Gemini-rate-limit problem is real today.** Your most recent runs were hitting Groq fallback because Gemini's free tier was exhausted. Either top up Gemini (~$5 lasts the whole evaluation period) or flip your `.env` to `LLM_PROVIDER=groq` and narrate the demo with Groq as the primary. Don't try to defend a 68% fallback rate in the recording — it sounds bad even though it's actually a positive signal.

2. **Practice the demo flow twice unrecorded.** The hardest part is hitting the 6-minute mark while still landing every defense moment. The script in Part B is timed to ~6:00 if you read at a normal pace; first practice run, you'll be at 7:30 because of pauses. Second run, you'll find your rhythm. Then record take 1. If it's clean, ship it. If not, take 2 ships.

The doc is designed so you can have it open in a second monitor during recording and read the dialogue lines as you click through.