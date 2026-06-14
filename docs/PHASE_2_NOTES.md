# Phase 2 — Multi-source ingestion + identity resolution

**Goal:** turn three messy source CSVs into one trustworthy customer view, with provenance and reasoning visible at every step.

## What exists now

### Backend services
- `app/services/normalize.py` — phone (last 10 digits, Indian mobile validation), email (lowercase + regex), name (whitespace collapse), date (multi-format parsing), amount (non-negative float).
- `app/services/ingestion.py` — per-source column mapping, writes raw + normalized rows to `staged_records`.
- `app/services/data_quality.py` — within-source validity checks PLUS cross-source overlap detection (the key FDE preview of "how much work does resolution have to do").
- `app/services/identity_resolution.py` — deterministic 4-rule chain with union-find, confidence scoring, match reasoning per identity, idempotent re-runs, deterministic consent population tied to source coverage.
- `app/services/orders_ingestion.py` — joins 5,000 orders to canonical customers via the identity graph, rolls up LTV / first-seen / last-seen.

### API routes
- `/ingest/source/{type}` — upload or use seed
- `/ingest/seed/all` — one-click ingest of all three
- `/ingest/data-quality` — full DQ report with cross-source overlap
- `/ingest/resolve` — run resolution + orders join
- `/ingest/reset` — wipe canonical state
- `/ingest/batches` — batch list
- `/identities/dashboard` — rule mix, source coverage, flagged count
- `/identities/flagged` — list of customers needing review
- `/customers` — paginated, filtered list (search / city / tier / min_sources)
- `/customers/{id}` — full detail with identities + orders + consent + categories
- `/customers/stats` — distribution stats for the list page

### Frontend pages
- `/ingest` — command center: one-click demo button, three source upload zones, DQ report with cross-source overlap callout, batches table, last-resolution result panel.
- `/identities` — resolution dashboard: rule chain breakdown with confidence bands + explanations, source coverage histogram, staged-by-source bar, flagged customers table linking to detail.
- `/customers` — list page with search + city + tier + min_sources filters, source-coverage dots per row, LTV / last-seen columns, pagination.
- `/customers/[id]` — **the demo's centerpiece**:
  - Hero: avatar, name, master ID, flagged badge, city/tier/sources count, LTV/orders/sources stats
  - Tabs: Overview (resolution chain visualization, canonical contact, top categories/stores, contactability summary), Source identities (raw vs normalized side-by-side with confidence bar + match rule + reasoning per source), Orders (cross-source timeline with source badges), Consent (per-channel grid with DND warning)

## The numbers on the seed data

After running resolution on the 2,963 staged rows from the three seed CSVs:

| Metric | Value |
|---|---|
| Canonical customers | 1,605 |
| Deduplication rate | 45.8% |
| Phone-exact merges | 1,244 identities |
| Email-exact merges | 703 identities |
| Name+city (flagged) merges | 353 identities |
| Singletons | 663 |
| Flagged components | 190 customers |
| Cross-source phone keys (DQ preview) | 622 |
| Cross-source email keys (DQ preview) | 536 |
| Likely merges estimate (DQ preview) | 1,158 |
| Orders matched to a canonical customer | 100% |

## Key defense one-liners

- **"Walk me through your matching rules in order."**
  Phone-exact (conf 1.00) → email-exact (0.95) → phone₈ + fuzzy name + city (0.85) → name + city only (0.70, flagged).
- **"What if phone matches but name is wildly different?"**
  Still merge — phone collisions are rare and usually mean shared family phones. The merge gets the highest-confidence rule (phone_exact), so it's visible in the UI exactly because reviewers should see it.
- **"What happens on a third re-import of the POS file?"**
  Idempotent. Source-side `source_record_id` is stable per row. Resolution wipes canonical state and recomputes (transformational, not incremental). Production would be incremental upsert with a versioned identity graph.
- **"Why rules not ML?"**
  Explainability and auditability — every merge has a rule, a confidence, and a reasoning string surfaced in the customer detail UI. ML adds opacity without accuracy gain at this scale.
- **"Why FLAG rule R4 if you still auto-merge?"**
  Because the demo needs to show the unified result. In production this rule would gate on human approval. The flag is the production hook — the demo just exercises the full path.
- **"What's the deduplication rate telling me?"**
  45.8% of source rows collapsed into shared canonical customers. Of the 1,605 canonical customers, 942 (59%) appear in 2+ sources. That's the value of CDP work, made visible.
- **"Why is the cross-source overlap preview meaningful?"**
  It's the FDE's pitch *before* running resolution. "Your three systems contain 1,158 likely duplicate customers — we can collapse those into a single view in under a second." That's the conversation a real FDE has on day 1 of an onboarding.

## What's deliberately NOT in Phase 2

- Incremental ingestion. Resolution is a transformation, not an upsert. A real production system would maintain a versioned identity graph.
- Manual merge / unmerge UI. The flagged list is read-only — a reviewer can see what to look at but can't act yet. Phase 7 polish could add this.
- AI-assisted merge explanation. The `match_reasoning` is currently deterministic. Phase 5 will add AI explanation for flagged merges only (saves tokens, only used where the value is high).
- True multi-tenancy. Single demo brand. Phase 7 documents the schema work for multi-tenant.

## Carry-forward for later phases

- The `consent` table is now populated — Phase 3 segments and Phase 5 channel routing will use this.
- The orders rollup (LTV, total_orders, last_order_at) lets Phase 3 segments query "lapsed > 60 days, LTV > X" without a sub-query.
- The `ai_runs` table is in place but empty — Phase 5 starts writing to it.
