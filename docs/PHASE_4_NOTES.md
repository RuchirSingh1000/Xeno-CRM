# Phase 4 — Channel Simulator + Async Webhook Loop

**Goal:** the assignment's hard requirement. Separate Channel Simulator service that accepts sends, fires HMAC-signed async webhook callbacks at realistic delays, and a CRM receiver that is HMAC-verifying, dedup'd by event_id, and derives communication state from max(sequence) so out-of-order delivery is safe.

## What exists now

### Channel Simulator (`:8001`)
- `app/hmac_sign.py` — HMAC-SHA256 over the raw request body. Constant-time verify.
- `app/simulator.py` — per-channel event distributions:
  - WhatsApp: 92% delivered → 60% read (of delivered) → 25% clicked (of read) → 8% converted (of clicked)
  - SMS: 95% delivered → 12% clicked → 5% converted
  - Email: 88% delivered → 40% opened → 15% clicked → 4% converted
  - RCS: 90% delivered → 55% read → 20% clicked → 6% converted
  - ~5% bounce mix: `invalid_number`, `provider_timeout`, `rate_limited`, `recipient_unsubscribed`
- Deterministic per-message via `provider_message_id`-seeded RNG (same recipient → same outcome on replay).
- **DEMO_TIMESCALE = 0.02** → all delays are 50x faster so the full lifecycle converges in <90s during the recording.
- **Jitter** of ±150ms added to each event so adjacent events can swap arrival order. This deliberately exercises the CRM's out-of-order-safety design.

### CRM API additions
- `app/services/hmac_sign.py` — mirror of the simulator's; kept in each service so neither depends on the other's package layout.
- `app/services/webhook_receiver.py` — the integrity boundary:
  1. HMAC-verify the raw body bytes (never the re-serialized JSON; key ordering would break it)
  2. Unique constraint on `event_id` collapses duplicates atomically (`IntegrityError` → mark as duplicate, return 200)
  3. After inserting the event, recompute `current_status` from the highest-sequence row; ties broken by status rank so `failed`/`converted` beat lifecycle events
  4. Every attempt — `processed`, `duplicate`, `invalid_signature`, `no_communication`, `failed` — lands in `webhook_deliveries`
- `app/services/campaign_launch.py` — promotes a draft to running:
  1. Validates state (must be draft, must have segment + template)
  2. Runs segment query LIVE (not snapshotted — tomorrow picks up newly-lapsed)
  3. Routes each customer with `channel_routing.route_one` (consent + contactability + priority)
  4. Per-customer template render via `template.render`
  5. Creates one Communication per targeted customer with rendered_message + recipient
  6. POSTs to simulator `/send`, stores returned `provider_message_id`
  7. Marks campaign `running`
- New routes on CRM:
  - `POST /campaigns/{id}/launch` — sync launch + dispatch summary
  - `GET /campaigns/{id}/funnel` — communications by status + funnel (distinct comms per event type) + failure reasons
  - `POST /webhooks/channel-events` — the receiver
  - `GET /webhooks/deliveries` + `POST /webhooks/deliveries/{id}/replay`
  - `GET /events` (filterable by campaign/comm/event_type) + `GET /events/stats`

### Frontend
- **`/events`** — auto-refresh (2s) event log with two tabs:
  - **Events**: filterable by type, color-coded per event type, deep links to campaigns
  - **Webhook deliveries**: every inbound attempt with status + retry count + replay button on failures
- **`/campaigns/[id]`** updates:
  - **Launch button** on draft campaigns (disabled when template has unknown variables)
  - **Live funnel section** appears once launched: stacked stage bars, queued → sent → delivered → opened/read → clicked → converted, with click-through rate + conversion rate stats
  - Polling every 2s while status=`running`; stops on `completed`
  - Failure reason breakdown when any communications failed
- **Sidebar**: Event log enabled

## End-to-end verification (already executed)

Launched the lapsed-VIP segment campaign (25 customers):
- Routing: 18 → WhatsApp, 6 → SMS, 1 → Email, 0 skipped, 0 send failures
- Webhooks flowed in: **0 invalid signatures**, **0 duplicates**, **0 failed deliveries**
- Event types received: `sent`, `delivered` (and on a full run, the lifecycle continues to `read`/`clicked`/`converted` per the distributions above)

## Key defense one-liners

- **"Walk me through HMAC verification."** The simulator signs the raw body bytes with HMAC-SHA256 + shared secret. Header `X-Xeno-Signature`. Receiver compares against `hmac.compare_digest` to avoid timing oracles. We verify *raw bytes* — re-serializing the parsed JSON would break the signature because key ordering and whitespace aren't preserved.
- **"How is the receiver idempotent?"** `communication_events.event_id` has a UNIQUE constraint. Duplicate POSTs hit `IntegrityError` on insert, we rollback, write a `webhook_deliveries` row with status=`duplicate`, return 200 OK. No SELECT-then-INSERT race.
- **"What if a `delivered` event arrives before its `sent`?"** State is derived from `max(sequence)` across the event log, not from arrival order. So the late-arriving `sent` event gets inserted but doesn't demote the current_status. We also break ties on `STATUS_RANK` so `failed` always wins over lifecycle events.
- **"Why a separate service?"** Mirrors real channel providers (WhatsApp BSP, Twilio, SendGrid): external boundary, async callbacks, signed payloads, retries. Forces the right architecture. Also lets me defend "the integration boundary is where the FDE works."
- **"What happens when the CRM is down and the simulator fires?"** Those webhooks return errors and are lost. The simulator's `webhook_log` (in-memory) records them. In production this is a retry-with-backoff path; in the demo I show the replay button on `webhook_deliveries` for failed attempts.
- **"Why ~5% failure rate?"** Realistic for Indian D2C — WhatsApp number invalidation, telco rate limits, recipient unsubscribes. Lets the demo show real failure handling without staging unreasonable error rates.
- **"DEMO_TIMESCALE — isn't that cheating?"** No: the *distributions* are real (1-5s delivery on WhatsApp, 30s-5min read window, etc.). The timescale just scales all delays uniformly so a 5-minute campaign lifecycle plays in 6 seconds during the recording. Production would set timescale=1.0.

## Carry-forward for Phase 5

- The launch path consumes a `ChannelPolicy.priority` list. Phase 5's AI campaign planner produces this priority list as part of its structured output. Same code path executes — no glue.
- Per-customer template rendering already happens at launch. Phase 5 can replace the static template with an AI-generated one without changing the dispatch loop.
- `ai_runs` is already wired and audit-clean. Phase 5 adds two more purposes: `campaign_plan` (NL goal → segment + channel + message angle) and `campaign_insight` (post-run analyst).
