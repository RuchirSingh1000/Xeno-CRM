# Retail Activation Console

> An AI-native mini CRM that helps a brand intelligently reach its shoppers.
> Xeno Engineering Take-Home Assignment, June 2026.

A working CRM for an Indian D2C coffee chain (Brewhouse Co.) — ingests messy
multi-source shopper data, resolves identities, segments and reaches them across
WhatsApp / SMS / Email with consent + DND respected, tracks the async webhook
lifecycle, and uses AI at every step where AI actually helps. Live, deployed,
seeded with realistic data.

- **Live app:** *<set after deploy>*
- **Code:** *<this repo>*
- **Walkthrough video:** *<set after recording>*

---

## The bets I made (and what I dropped)

The brief is deliberately open. These are the calls I made and why.

**Built deep**
- **Identity resolution across 3 source systems.** POS, Shopify, loyalty CSVs land as `staged_records`, then a graph-based resolver collapses them into canonical `customers` by phone/email overlap, with per-merge confidence and provenance. Most CRMs treat this as a one-time setup; I treat it as a first-class surface — there's a `/identities` page that shows what merged, why, with low-confidence merges flagged for review. *Reason: in retail, every downstream feature degrades if this is bad.*
- **AI used five different ways, not one.** Segment planner, campaign planner, message rewriter, post-run analyst, campaign autopilot (the three chained), copilot (chat over tools), CSV column mapper. Each one is small, JSON-schema-validated, with a deterministic fallback. *Reason: "AI-native" means AI is structural, not bolted on.*
- **Audited everything.** Every LLM call writes one `ai_runs` row with provider, model, latency, validation status, raw + parsed output. The `/ai-runs` page is debuggable production telemetry, not vibes. *Reason: AI you can't audit, you can't trust.*
- **Webhook loop modelled honestly.** Idempotency via UNIQUE(provider_event_id), per-event monotonic sequence + status-rank reducer for out-of-order delivery, HMAC signature verification, persisted failed deliveries with an operator replay button. The `/reliability` page maps each guarantee to a number. *Reason: the brief explicitly asks how I handle volume, ordering, retries, failures.*

**Dropped on purpose**
- **Real channel providers.** Brief forbids it. The simulator is a separate FastAPI service that schedules deliver/click/convert events with realistic timing and failure rates, signs them with HMAC, and POSTs them back asynchronously.
- **Multi-tenant RBAC.** Single brand (`Brewhouse Co.`). The data model is `brand_id`-scoped so adding tenants is a SQL change, not a refactor — but the UI for it isn't there. Out of scope for a take-home.
- **A/B test framework.** Considered. Would be one more table + a holdout flag on Campaign, but the demo time was better spent on the autopilot loop that closes "what should we do next".
- **Custom auth.** Stub user; the CRM is brand-scoped, not user-scoped. Real Xeno has SSO + audit. A take-home that adds auth without using it is theatre.
- **An LLM-driven router for messages.** Channel routing is deterministic: priority list × consent × DND. AI proposes the priority; the engine executes it. *That separation is the bet — AI proposes, deterministic systems execute. It's defensible, auditable, and the failure mode of a bad LLM call is "default order", not "wrong messages sent to wrong people".*

---

## The AI surfaces (when AI proposes vs when AI decides)

| Surface | What AI does | What AI does NOT do |
|---|---|---|
| **Segment planner** | NL goal → audience criteria + suppression rules | Run the query (deterministic engine does) |
| **Campaign planner** | Full plan: name, rationale, segment, channels, message, success metric | Save without operator review |
| **Message rewriter** | Re-roll the message holding everything else fixed | Touch the audience or channel mix |
| **Post-run analyst** | Plain-English insight grounded in the actual funnel + failure mix | Hallucinate channels or numbers (Pydantic-validated against the facts blob) |
| **Campaign autopilot** | Chain: analyst → derive follow-up goal → planner. One click, three audited LLM calls. | Launch — always lands as a draft for review |
| **Copilot (chat)** | Tool-use loop over read-only analytics endpoints | Mutate state. No write tools exist. |
| **CSV column mapper** | Propose source-column → canonical-field mapping with confidence | Apply without operator confirmation |

Each surface has the same shape: prompt versioned, output Pydantic-validated, one retry against the fallback provider (Groq), deterministic fallback if both fail, audit row written, latency + provider recorded. Same defendable pattern five times beats five clever patterns once.

The **copilot** deserves a note: it's not a function-calling-API integration (provider-specific, brittle). It's a ReAct-style JSON loop where each step is `{action: call_tool|respond, ...}`, validated, executed, fed back. Provider-agnostic. Trivially debuggable from `ai_runs`.

---

## The channel loop (volume, ordering, retries, failures)

The brief calls this out specifically. Each guarantee maps to a code-level mechanism. The `/reliability` page surfaces the live numbers; here's the why.

| Concern | Mechanism | File |
|---|---|---|
| **Volume** | FastAPI threadpool bumped to 200 tokens at startup. Webhook receiver path is purely synchronous SQL — no extra hops. | `app/main.py` |
| **Idempotency** | `UNIQUE(provider_event_id)` on `communication_events`. Insert-then-catch absorbs duplicates atomically. Duplicate POSTs return 200 OK with no state mutation. | `app/services/webhook_receiver.py` |
| **Ordering** | Each event carries a `sequence` per communication. The reducer keeps the highest-rank status (`failed > converted > clicked > delivered > sent > queued`), so a late `delivered` cannot overwrite a `clicked`. | `app/services/webhook_receiver.py` |
| **Security** | Every webhook HMAC-signed with a shared secret. Failure → `status=invalid_signature`, 401, no mutation. | `app/services/hmac_sign.py` |
| **Failures** | Failed deliveries persist with `raw_payload` + `last_error`. Operator can replay via `POST /webhooks/deliveries/{id}/replay`. The same idempotency guard prevents double-application. | `app/routes/webhooks.py` |

---

## Architecture

```
┌──────────────┐      ┌──────────────────┐      ┌───────────────────────┐
│  Next.js     │ ───► │  CRM API         │ ◄──► │  Channel Simulator    │
│  (frontend)  │      │  (FastAPI)       │      │  (FastAPI, separate)  │
└──────────────┘      └────────┬─────────┘      └───────────────────────┘
                               │                          │ async, HMAC-signed
                               ▼                          │ POST webhooks
                       ┌──────────────┐  ◄────────────────┘
                       │  SQLite/PG   │
                       └──────────────┘
```

Two backend services on purpose — that's the brief's design exercise. CRM owns customer data, identity, segments, campaigns, webhook receipt, analytics. Channel Simulator mimics provider behaviour: accepts a `/send`, returns a `provider_message_id`, then asynchronously schedules and POSTs deliver/view/click/convert/fail events back.

**Stack:** FastAPI + SQLAlchemy + SQLite (Postgres-ready) on the backend; Next.js 15 + Tailwind + neumorphic design system on the frontend; provider-agnostic LLM client supporting Gemini / OpenAI / Anthropic / Groq with deterministic stub fallback. Boring, fast to ship, easy to defend.

---

## Scale tradeoffs — what I did, what I'd do at 10M customers

| Concern | Built for this take-home | Would do at scale |
|---|---|---|
| **DB** | SQLite single file, ORM session per request | Postgres + read replicas; analytics on a snapshotted OLAP store (DuckDB/ClickHouse) |
| **Webhooks** | Synchronous in-process handler | SQS/Kinesis queue between receiver and reducer; same idempotency guard, batched commits |
| **Campaign launch** | Synchronous loop over segment customers | Background worker (Celery/Arq), batched sends, rate-limit per channel provider |
| **AI calls** | Inline in request, ~10s p95 | Pre-warmed for planner/analyst (hot path); copilot uses streaming + tool-result caching |
| **Identity resolution** | Re-runs whole graph on demand | Incremental: only newly-staged rows + their neighbourhood |
| **Segment queries** | SQL over `customers` table | Materialized segment counts refreshed on customer-state change |
| **Frontend** | Polled refresh | Server-sent events for webhook stream + campaign funnel |
| **Multi-tenant** | `brand_id` everywhere, single brand seeded | Same column, row-level security policies in Postgres |
| **Audit** | `ai_runs` table | Same table, dual-written to S3 for retention, queryable from a BI tool |

The take-home version makes the right *shape* of choices. None of the above is a rewrite — each is a swap of one component.

---

## AI-native dev workflow

I built this with Claude Code (the CLI agent). Specifics, since the rubric asks:

- **The agent wrote most of the code.** I directed and reviewed. Every PR-equivalent commit was code I read line by line, with the comments and structure being mine to accept or reshape.
- **Pydantic schemas first.** Every AI surface starts with the validation schema before the prompt. That's the contract; the prompt is the implementation. If the agent drifts, the schema bites.
- **One change per turn.** I never asked for sweeping refactors. Each turn is a small, reviewable diff. This is also how Xeno's FDE harnesses are designed to work.
- **Run-time audit as a debugging tool.** When an AI surface misbehaved during the build, the `ai_runs` row was the first thing I looked at. The provider/model/latency/validation_status fields aren't decoration — they're a debugger.
- **Manual smoke tests after every backend change.** `curl` the new endpoint, eyeball the response, then move on. Test coverage is light because the agent + manual smoke flushed bugs faster than tests would have.

Things I *didn't* let AI do:
- Pick the architecture (two-service split, identity resolution as a first-class surface, AI-proposes/deterministic-executes pattern — all me).
- Write the schemas for new domain concepts. Those are the contract.
- Pick scope. The "what to build / what to drop" calls are mine.

---

## Quick start (local)

Prereqs: Python 3.12+ and Node 20+.

```powershell
# Backend deps (one venv for both services)
python -m venv .venv
.venv\Scripts\pip.exe install -r backend\crm-api\requirements.txt
.venv\Scripts\pip.exe install -r backend\channel-simulator\requirements.txt

# Env files
Copy-Item backend\crm-api\.env.example backend\crm-api\.env
Copy-Item backend\channel-simulator\.env.example backend\channel-simulator\.env
Copy-Item frontend\.env.local.example frontend\.env.local

# Three terminals
cd backend\crm-api && ..\..\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8000 --reload
cd backend\channel-simulator && ..\..\.venv\Scripts\python.exe -m uvicorn app.main:app --port 8001 --reload
cd frontend && npm install && npm run dev
```

Visit <http://localhost:3000>. The Overview page is the executive dashboard; from there:

- **/ingest** — seed the three CSV sources, then run identity resolution. Or use **AI ingest** (NL prompt) or **messy-CSV** (any CSV, AI maps columns).
- **/customers** — canonical view, filters, tier pills, source-coverage filter.
- **/segments** — AI segment planner (NL → audience).
- **/campaigns** — AI campaign planner (NL → full plan), launch, autopilot ("what should I do next?").
- **/analytics** — portfolio funnel, channel breakdown, comparison bars.
- **/reliability** — webhook receiver guarantees translated into numbers.
- **/ai-runs** — full audit trail of every LLM call.
- **Floating ✦ button** — copilot chat, tool-use over the read APIs.

---

## What's where

```
backend/
  crm-api/                       ← main service
    app/
      ai/                        ← provider-agnostic LLM client + fallback chain
      models/                    ← SQLAlchemy core tables
      routes/                    ← FastAPI routers (one file per resource)
      services/
        ai_*                     ← five AI surfaces, same defendable pattern
        identity_resolution.py   ← graph-based merger with provenance
        segment_engine.py        ← deterministic query over canonical customers
        campaign_launch.py       ← orchestrates routing + simulator dispatch
        webhook_receiver.py      ← idempotent, ordered, signed
        analytics.py             ← all the dashboard aggregates
  channel-simulator/             ← stub WhatsApp/SMS/Email/RCS provider
frontend/
  src/
    app/                         ← Next.js pages
    components/
      Copilot.tsx                ← floating chat, ReAct over backend tools
      CsvMapper.tsx              ← messy-CSV ingest with AI mapping
      charts/                    ← hand-rolled SVG/HTML — no chart lib dep
```

---

Built in 8 days by [Ruchir](mailto:ryanelijahmathew23@gmail.com) for Xeno FDE 2026. Genuinely had fun.
