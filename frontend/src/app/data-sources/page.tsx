"use client";

import { useEffect, useState } from "react";
import { PageHeader } from "@/components/PageHeader";
import {
  fetchDataSources,
  fetchPreview,
  downloadUrl,
  type DataSourcesManifest,
  type DataSource,
  type CsvPreview,
} from "@/lib/api";

export default function DataSourcesPage() {
  const [manifest, setManifest] = useState<DataSourcesManifest | null>(null);
  const [loading, setLoading] = useState(true);
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [preview, setPreview] = useState<CsvPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    fetchDataSources().then((m) => {
      setManifest(m);
      setLoading(false);
    });
  }, []);

  const openPreview = async (filename: string) => {
    if (previewFor === filename) {
      setPreviewFor(null);
      setPreview(null);
      return;
    }
    setPreviewFor(filename);
    setPreview(null);
    setPreviewLoading(true);
    const p = await fetchPreview(filename, 8);
    setPreview(p);
    setPreviewLoading(false);
  };

  return (
    <div className="min-h-screen animate-fade-in">
      <PageHeader
        eyebrow="Workspace"
        title="Data sources"
        description="Three source systems that a real Indian D2C retail brand would run separately: POS, ecommerce, and loyalty. Each captures the same customer differently — and inconsistently. Identity resolution unifies them into one canonical customer view."
      />

      <div className="px-8 py-8 max-w-6xl space-y-8">
        {loading && <div className="text-sm text-neutral-500">Loading sources…</div>}

        {manifest && (
          <>
            <BrandPanel manifest={manifest} />

            <section>
              <h2 className="text-[11px] uppercase tracking-widest text-neutral-500 mb-3">
                Source systems
              </h2>
              <div className="grid gap-3">
                {manifest.sources.map((s) => (
                  <SourceCard
                    key={s.key}
                    source={s}
                    onPreview={() => openPreview(s.filename)}
                    isPreviewing={previewFor === s.filename}
                    preview={previewFor === s.filename ? preview : null}
                    previewLoading={previewFor === s.filename && previewLoading}
                  />
                ))}
              </div>
            </section>

            <OrdersPanel manifest={manifest} />

            <NoteCard />
          </>
        )}
      </div>
    </div>
  );
}

function BrandPanel({ manifest }: { manifest: DataSourcesManifest }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-gradient-to-br from-neutral-900/60 to-neutral-900/10 p-6">
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-emerald-400 mb-1.5">
            Demo brand
          </div>
          <div className="text-xl font-semibold">{manifest.brand.name}</div>
          <div className="text-xs text-neutral-500 mt-0.5">
            {manifest.brand.industry} · {manifest.brand.country}
          </div>
          <p className="mt-3 text-sm text-neutral-400 max-w-2xl">
            {manifest.brand.description}
          </p>
        </div>
        <div className="hidden sm:grid grid-cols-3 gap-2 shrink-0">
          <SmallStat label="Underlying" value={manifest.underlying_customers.toLocaleString()} />
          <SmallStat label="In 2 sources" value={manifest.overlap.in_two_sources.toLocaleString()} />
          <SmallStat label="In all 3" value={manifest.overlap.in_all_three_sources.toLocaleString()} />
        </div>
      </div>
    </div>
  );
}

function SmallStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-center min-w-[88px]">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div className="text-base font-semibold mt-0.5">{value}</div>
    </div>
  );
}

function SourceCard({
  source,
  onPreview,
  isPreviewing,
  preview,
  previewLoading,
}: {
  source: DataSource;
  onPreview: () => void;
  isPreviewing: boolean;
  preview: CsvPreview | null;
  previewLoading: boolean;
}) {
  const palette: Record<string, string> = {
    pos: "from-amber-500/15 to-amber-500/5 text-amber-300 border-amber-500/30",
    ecommerce: "from-emerald-500/15 to-emerald-500/5 text-emerald-300 border-emerald-500/30",
    loyalty: "from-sky-500/15 to-sky-500/5 text-sky-300 border-sky-500/30",
  };
  const badgeClass = palette[source.key] ?? "from-neutral-800 to-neutral-800 text-neutral-300 border-neutral-700";

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 overflow-hidden">
      <div className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <span
                className={`inline-flex items-center rounded border bg-gradient-to-br px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider ${badgeClass}`}
              >
                {source.key}
              </span>
              <h3 className="text-base font-semibold">{source.label}</h3>
            </div>
            <div className="text-xs text-neutral-500 mt-0.5">{source.system}</div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onPreview}
              className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs hover:bg-neutral-800 transition"
            >
              {isPreviewing ? "Hide preview" : "Preview"}
            </button>
            <a
              href={downloadUrl(source.filename)}
              className="rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 px-3 py-1.5 text-xs hover:bg-emerald-500/20 transition"
            >
              Download CSV
            </a>
          </div>
        </div>

        <div className="grid sm:grid-cols-3 gap-3 mt-5">
          <Field label="Rows" value={source.row_count.toLocaleString()} mono />
          <Field label="Primary identifier" value={source.primary_identifier} />
          <Field label="Filename" value={source.filename} mono small />
        </div>

        <div className="mt-5">
          <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5">
            Fields
          </div>
          <div className="flex flex-wrap gap-1.5">
            {source.fields.map((f) => (
              <span
                key={f}
                className="text-[11px] font-mono rounded bg-neutral-800/80 px-1.5 py-0.5 text-neutral-300"
              >
                {f}
              </span>
            ))}
          </div>
        </div>

        {source.quirks.length > 0 && (
          <div className="mt-5">
            <div className="text-[10px] uppercase tracking-widest text-neutral-500 mb-1.5">
              Quirks to handle
            </div>
            <ul className="space-y-1">
              {source.quirks.map((q, i) => (
                <li key={i} className="text-xs text-neutral-400 flex gap-2">
                  <span className="text-amber-500/80">›</span>
                  <span>{q}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {isPreviewing && (
        <div className="border-t border-neutral-800 bg-neutral-950/60 overflow-x-auto">
          {previewLoading && (
            <div className="px-5 py-4 text-sm text-neutral-500">Loading preview…</div>
          )}
          {preview && (
            <table className="w-full text-xs">
              <thead className="bg-neutral-900/80">
                <tr>
                  {preview.headers.map((h) => (
                    <th
                      key={h}
                      className="text-left font-mono text-[10px] uppercase tracking-wider text-neutral-500 px-3 py-2 whitespace-nowrap"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, i) => (
                  <tr key={i} className="border-t border-neutral-800/60">
                    {preview.headers.map((h) => (
                      <td
                        key={h}
                        className="px-3 py-2 font-mono text-[11px] text-neutral-300 whitespace-nowrap"
                      >
                        {row[h]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {preview && (
            <div className="px-5 py-2 text-[10px] text-neutral-500 border-t border-neutral-800/60">
              Showing first {preview.rows.length} of {source.row_count.toLocaleString()} rows
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  mono,
  small,
}: {
  label: string;
  value: string;
  mono?: boolean;
  small?: boolean;
}) {
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-950/40 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div
        className={`mt-0.5 ${small ? "text-xs" : "text-sm"} ${
          mono ? "font-mono" : "font-medium"
        } text-neutral-200 truncate`}
      >
        {value}
      </div>
    </div>
  );
}

function OrdersPanel({ manifest }: { manifest: DataSourcesManifest }) {
  return (
    <section>
      <h2 className="text-[11px] uppercase tracking-widest text-neutral-500 mb-3">
        Order history
      </h2>
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/30 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="text-base font-semibold">Cross-source order timeline</div>
            <div className="text-xs text-neutral-500 mt-0.5">
              {manifest.orders.row_count.toLocaleString()} orders ·
              {" "}
              {manifest.orders.window_days}-day window · spanning all three source systems
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {manifest.orders.categories.map((c) => (
                <span
                  key={c}
                  className="text-[11px] rounded-full border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-neutral-300"
                >
                  {c}
                </span>
              ))}
            </div>
          </div>
          <a
            href={downloadUrl(manifest.orders.filename)}
            className="shrink-0 rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-300 px-3 py-1.5 text-xs hover:bg-emerald-500/20 transition"
          >
            Download orders.csv
          </a>
        </div>
      </div>
    </section>
  );
}

function NoteCard() {
  return (
    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-4 text-sm text-amber-200/90">
      <div className="font-medium mb-1">Why this seed data is shaped this way</div>
      <p className="text-amber-200/70 text-xs leading-relaxed">
        Real Indian D2C brands run POS, ecommerce, and loyalty as separate systems with
        separate teams — and the same customer appears differently in each. We seeded ~1,500
        underlying people with realistic noise (phone format variance, name spelling drift,
        single-character email typos in ~8% of duplicates) so that identity resolution
        has actual work to do, not theatrical work. The first &ldquo;wow&rdquo; in the demo is
        the moment three messy CSVs become one trustworthy customer view.
      </p>
    </div>
  );
}
