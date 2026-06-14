"use client";

/** About page — author details + a navigable feature catalog of the whole app.
 *
 * Doubles as the reviewer's table of contents. Every feature has a short
 * description and a direct link so anyone walking through the submission can
 * jump straight to it.
 */

import Link from "next/link";
import { PageHeader } from "@/components/PageHeader";

type Feature = {
  title: string;
  href?: string;
  blurb: string;
  highlights: string[];
  badge?: { label: string; tone: "violet" | "emerald" | "sky" | "amber" | "xeno" };
};

const FEATURE_GROUPS: { name: string; tone: string; items: Feature[] }[] = [
  {
    name: "Ingestion & identity",
    tone: "text-c-emerald",
    items: [
      {
        title: "Multi-source CSV ingest",
        href: "/ingest",
        blurb: "POS, Shopify, loyalty exports stage into one canonical customer table.",
        highlights: ["3 source systems", "Provenance per row", "One-click seed demo"],
      },
      {
        title: "AI customer ingest",
        href: "/ingest",
        blurb: "Two flavours — paste a messy CSV and let AI map columns, or describe a few customers in plain English.",
        highlights: ["AI column mapping with per-column confidence", "Per-row issues flagged before apply", "NL → structured records"],
        badge: { label: "AI", tone: "violet" },
      },
      {
        title: "Identity resolution",
        href: "/identities",
        blurb: "Graph-based merge across sources with confidence + auditable rule chain. Operator can confirm or reject any flagged merge.",
        highlights: ["4-rule chain (phone exact → name+city)", "Source-coverage histogram", "Confirm / Reject on flagged rows"],
      },
    ],
  },
  {
    name: "Customers",
    tone: "text-c-sky",
    items: [
      {
        title: "Canonical customers",
        href: "/customers",
        blurb: "Unified customer view after resolution. Filter by city, loyalty tier, source coverage.",
        highlights: ["Tier pills", "LTV percentiles", "Per-customer detail with order timeline"],
      },
    ],
  },
  {
    name: "Engagement",
    tone: "text-c-amber",
    items: [
      {
        title: "Segments",
        href: "/segments",
        blurb: "Build audiences with rule chips. Live preview with why-included reasoning per sampled customer.",
        highlights: ["Pre-built templates", "Live count", "JSON definition viewable"],
      },
      {
        title: "Campaigns",
        href: "/campaigns",
        blurb: "Draft, edit, launch. Consent + DND respected. Channel priority deterministically routed.",
        highlights: ["AI campaign planner (NL → full plan)", "Message rewriter", "Routing preview before launch"],
        badge: { label: "AI", tone: "violet" },
      },
      {
        title: "Campaign autopilot",
        href: "/campaigns",
        blurb: "After a launch, click 'What should I do next?' — runs analyst → derive follow-up goal → planner, end-to-end.",
        highlights: ["3 audited LLM calls per click", "Drafts the next campaign", "Closes the loop"],
        badge: { label: "AI", tone: "violet" },
      },
      {
        title: "Event log",
        href: "/events",
        blurb: "Every async webhook event from the channel simulator, with type + sequence + failure reason.",
        highlights: ["Filter by campaign / type", "Stream of deliver/click/convert/fail"],
      },
      {
        title: "Webhook reliability",
        href: "/reliability",
        blurb: "Live proof of how the receiver handles volume, ordering, retries, and failures. Inject a fake failure to demo the replay flow.",
        highlights: ["Idempotency / out-of-order / HMAC / retry counters", "Operator replay button", "+ Simulate failure"],
      },
    ],
  },
  {
    name: "Intelligence",
    tone: "text-c-violet",
    items: [
      {
        title: "Portfolio analytics",
        href: "/analytics",
        blurb: "Cross-campaign view — revenue, channel mix, funnel, leaderboard, failure breakdown.",
        highlights: ["Per-campaign bars", "N-way campaign comparison", "Revenue-by-channel donut"],
      },
      {
        title: "AI runs (audit trail)",
        href: "/ai-runs",
        blurb: "Every LLM call — provider, model, latency, validation status, raw + parsed output.",
        highlights: ["Searchable", "Fallback-chain visible", "Every AI surface logs here"],
      },
      {
        title: "AI evals",
        href: "/evals",
        blurb: "Structural test suite over the campaign planner. 15 hand-written cases with Pydantic-validated assertions.",
        highlights: ["Per-case pass/fail", "Provider breakdown", "Run-now button"],
        badge: { label: "AI", tone: "violet" },
      },
      {
        title: "Ask Xeno (copilot)",
        blurb: "Floating ✦ chat. Natural-language Q&A over the live CRM with tool-use over the read endpoints.",
        highlights: ["Provider-agnostic ReAct loop", "Trace of tool calls visible", "Real numbers, no hedging"],
        badge: { label: "AI", tone: "violet" },
      },
    ],
  },
];

const TECH = [
  { label: "Frontend", value: "Next.js 15, React 19, TypeScript, Tailwind 4, neumorphic design system" },
  { label: "Backend", value: "FastAPI, SQLAlchemy 2, Pydantic v2, SQLite (Postgres-ready)" },
  { label: "Channel simulator", value: "Separate FastAPI service, async HMAC-signed webhooks" },
  { label: "AI", value: "Gemini / OpenAI / Anthropic / Groq, provider-agnostic client with fallback chain + deterministic stub" },
  { label: "Auditing", value: "ai_runs table + eval harness + reliability summary endpoint" },
];

export default function AboutPage() {
  return (
    <div className="min-h-screen animate-fade-in">
      <PageHeader
        eyebrow="About"
        title="Retail Activation Console"
        description="AI-native mini CRM for an Indian D2C retail brand. Built for the Xeno FDE Engineering Take-Home Assignment, June 2026."
      />

      <div className="px-8 py-8 max-w-6xl space-y-8">
        {/* Author card */}
        <section
          className="neu-card p-6"
          style={{
            background:
              "linear-gradient(135deg, color-mix(in srgb, var(--xeno-blue), transparent 90%), color-mix(in srgb, var(--xeno-blue), transparent 96%))",
          }}
        >
          <div className="text-[10px] uppercase tracking-widest text-xeno font-semibold mb-2">
            Built by
          </div>
          <div className="flex items-start justify-between gap-6 flex-wrap">
            <div>
              <h2 className="text-2xl font-bold text-[var(--neu-text)] mb-1">Ruchir Singh</h2>
              <p className="text-sm text-[var(--neu-text-muted)]">
                Engineering candidate · Xeno FDE 2026
              </p>
            </div>
            <div className="text-sm space-y-1.5 font-mono">
              <div className="flex items-center gap-2">
                <span className="text-[var(--neu-text-subtle)] text-xs uppercase tracking-wider w-14">Email</span>
                <a
                  href="mailto:rs6404@srmist.edu.in"
                  className="text-xeno hover:underline"
                >
                  rs6404@srmist.edu.in
                </a>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[var(--neu-text-subtle)] text-xs uppercase tracking-wider w-14">Phone</span>
                <a
                  href="tel:+917240424765"
                  className="text-xeno hover:underline"
                >
                  +91 72404 24765
                </a>
              </div>
            </div>
          </div>
        </section>

        {/* Project overview */}
        <section className="grid lg:grid-cols-3 gap-4">
          <div className="neu-card p-5">
            <div className="text-[10px] uppercase tracking-wider text-c-emerald font-semibold mb-2">
              What it does
            </div>
            <p className="text-sm text-[var(--neu-text-muted)] leading-relaxed">
              Ingests messy multi-source shopper data, resolves identities into canonical
              customers, segments them, launches consent-aware multi-channel campaigns through a
              stubbed channel simulator, and tracks the full async webhook lifecycle — with AI
              proposing at every step where AI actually helps.
            </p>
          </div>
          <div className="neu-card p-5">
            <div className="text-[10px] uppercase tracking-wider text-c-sky font-semibold mb-2">
              Core pattern
            </div>
            <p className="text-sm text-[var(--neu-text-muted)] leading-relaxed">
              <strong className="text-[var(--neu-text)]">AI proposes, deterministic systems execute.</strong>{" "}
              Five AI surfaces, each Pydantic-validated, with one retry against a fallback
              provider and a deterministic fallback if both fail. Every call lands as an
              auditable <code className="text-c-violet">ai_runs</code> row.
            </p>
          </div>
          <div className="neu-card p-5">
            <div className="text-[10px] uppercase tracking-wider text-c-amber font-semibold mb-2">
              Brand demoed
            </div>
            <p className="text-sm text-[var(--neu-text-muted)] leading-relaxed">
              <strong className="text-[var(--neu-text)]">Brewhouse Co.</strong> — a fictional Indian
              coffee & QSR chain. 1,600 canonical customers across 5 cities, 5,000 orders, multi-tier
              loyalty programme, TRAI DND-compliant consent. Seed data is realistic-looking, fully
              regenerable.
            </p>
          </div>
        </section>

        {/* Feature catalog */}
        <section>
          <h2 className="text-[11px] uppercase tracking-widest text-[var(--neu-text-subtle)] font-semibold mb-4">
            Feature catalog · click any to jump in
          </h2>
          <div className="space-y-6">
            {FEATURE_GROUPS.map((g) => (
              <div key={g.name}>
                <h3 className={`text-[11px] uppercase tracking-wider font-bold mb-2 ${g.tone}`}>
                  {g.name}
                </h3>
                <div className="grid md:grid-cols-2 gap-3">
                  {g.items.map((f) => (
                    <FeatureCard key={f.title} feature={f} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Stack */}
        <section>
          <h2 className="text-[11px] uppercase tracking-widest text-[var(--neu-text-subtle)] font-semibold mb-3">
            Tech stack
          </h2>
          <div className="neu-card p-5 space-y-2.5">
            {TECH.map((t) => (
              <div key={t.label} className="flex items-baseline gap-3 text-sm">
                <span className="text-[10px] uppercase tracking-wider text-c-violet font-semibold w-32 shrink-0">
                  {t.label}
                </span>
                <span className="text-[var(--neu-text-muted)] leading-relaxed">{t.value}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Footer */}
        <section className="text-center text-xs text-[var(--neu-text-subtle)] pt-4">
          Made with care for Xeno · June 2026
        </section>
      </div>
    </div>
  );
}

function FeatureCard({ feature }: { feature: Feature }) {
  const inner = (
    <div className="neu-raised-xs p-4 h-full transition hover:translate-y-[-1px]">
      <div className="flex items-start justify-between gap-3 mb-1.5">
        <div className="text-sm font-semibold text-[var(--neu-text)]">{feature.title}</div>
        {feature.badge && (
          <span
            className={`text-[9px] rounded border px-1.5 py-0.5 uppercase tracking-wider font-mono shrink-0 ${
              feature.badge.tone === "violet"
                ? "border-violet-500/40 bg-violet-500/10 text-c-violet"
                : "border-emerald-500/40 bg-emerald-500/10 text-c-emerald"
            }`}
          >
            {feature.badge.label}
          </span>
        )}
      </div>
      <p className="text-xs text-[var(--neu-text-muted)] leading-relaxed mb-2">{feature.blurb}</p>
      <ul className="text-[11px] text-[var(--neu-text-subtle)] space-y-0.5">
        {feature.highlights.map((h) => (
          <li key={h}>· {h}</li>
        ))}
      </ul>
    </div>
  );
  if (feature.href) {
    return (
      <Link href={feature.href} className="block">
        {inner}
      </Link>
    );
  }
  return inner;
}
