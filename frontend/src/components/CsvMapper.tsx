"use client";

/** Messy-CSV ingest with AI column mapping.
 *
 * FDE workflow in one panel:
 *   1. Paste raw CSV (any headers, any encoding within reason).
 *   2. AI proposes a column → canonical-field mapping with per-column confidence.
 *   3. Operator reviews, edits any amber-confidence rows.
 *   4. Apply — Customers + Identities created with source_system='csv_upload'.
 *
 * The operator is in the loop; AI just removes the rote part.
 */

import { useState } from "react";
import { previewCsv, applyCsv, type CsvPreviewResponse, type CsvMappingItem } from "@/lib/api";
import { useToast } from "@/components/Toast";
import { AILoader } from "@/components/AILoader";
import { useAIThinking } from "@/components/AIThinking";

const SAMPLE_CSV =
  "Cust Name,mobile,e-mail,City Name,Tier,LTV (Rs.),# Orders\n" +
  "Ravi Kumar,9876543210,ravi@example.com,Mumbai,gold,12500,8\n" +
  "Priya M,9123456789,priya@test.in,Bengaluru,silver,4500.50,3\n" +
  "Aditya Nair,9988776655,aditya@brewhouse.in,Chennai,platinum,18900,15";

export function CsvMapper({ onApplied, bare = false }: { onApplied?: () => void; bare?: boolean }) {
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<CsvPreviewResponse | null>(null);
  const [mapping, setMapping] = useState<CsvMappingItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [applying, setApplying] = useState(false);
  const toast = useToast();
  const ai = useAIThinking();

  const onPreview = async () => {
    if (!csv.trim()) return;
    setBusy(true);
    const r = await ai.run("AI mapping CSV columns…", () => previewCsv(csv));
    setBusy(false);
    if (!r) {
      toast.error("CSV preview failed", "Check /ai-runs for the failed run.");
      return;
    }
    setPreview(r);
    setMapping(r.mapping);
    toast.success(
      "Mapping proposed",
      `${r.mapping.filter((m) => m.target_field).length} of ${r.headers.length} columns mapped · ${r.provider}/${r.model} · ${r.latency_ms}ms`,
    );
  };

  const onApply = async () => {
    if (!preview || !mapping) return;
    setApplying(true);
    const mapDict: Record<string, string | null> = {};
    for (const m of mapping) mapDict[m.source_column] = m.target_field;
    const r = await applyCsv({ csv_text: csv, mapping: mapDict });
    setApplying(false);
    if (!r) {
      toast.error("CSV apply failed");
      return;
    }
    toast.success(
      "CSV ingested",
      `${r.ingested} customers created · ${r.skipped} rows skipped`,
    );
    setPreview(null);
    setMapping([]);
    setCsv("");
    onApplied?.();
  };

  const updateTarget = (idx: number, target: string | null) => {
    setMapping((m) =>
      m.map((item, i) => (i === idx ? { ...item, target_field: target, confidence: 1.0, reason: "operator override" } : item)),
    );
  };

  const confidenceColor = (c: number, hasTarget: boolean) => {
    if (!hasTarget) return "text-[var(--neu-text-subtle)]";
    if (c >= 0.85) return "text-c-emerald";
    if (c >= 0.6) return "text-c-sky";
    return "text-c-amber";
  };

  const body = (
    <>
      {!bare && (
        <div className="flex items-baseline justify-between mb-3">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-c-violet font-semibold mb-1">
              AI · messy-CSV ingest
            </div>
            <p className="text-sm text-[var(--neu-text-muted)] max-w-2xl">
              Paste any customer CSV — POS, loyalty, e-commerce, whatever. The model
              proposes a column → canonical-field mapping with per-column confidence;
              you confirm or override. Bad rows are flagged before ingest, not after.
            </p>
          </div>
          <button
            onClick={() => setCsv(SAMPLE_CSV)}
            className="text-[11px] text-[var(--neu-text-subtle)] hover:text-c-violet"
          >
            load sample
          </button>
        </div>
      )}
      {bare && (
        <div className="flex items-baseline justify-between mb-3">
          <p className="text-sm text-[var(--neu-text-muted)] max-w-2xl">
            Paste any customer CSV — POS, loyalty, e-commerce, whatever. The model proposes a
            column → canonical-field mapping with per-column confidence; you confirm or override.
            Bad rows are flagged before ingest, not after.
          </p>
          <button
            onClick={() => setCsv(SAMPLE_CSV)}
            className="text-[11px] text-[var(--neu-text-subtle)] hover:text-c-violet shrink-0 ml-3"
          >
            load sample
          </button>
        </div>
      )}

      <textarea
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
        rows={6}
        placeholder="Paste CSV here — headers on first line, comma-separated. Try the sample CSV for a messy real-world example."
        className="w-full text-xs font-mono p-3 mb-3"
      />

      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="text-[11px] text-[var(--neu-text-subtle)]">
          {csv.split("\n").filter((l) => l.trim()).length} non-empty lines pasted
        </div>
        <button
          onClick={onPreview}
          disabled={busy || !csv.trim()}
          className="neu-btn neu-btn-primary px-4 py-2 text-sm min-w-[200px]"
        >
          {busy ? <AILoader label="AI mapping…" /> : "Propose mapping with AI"}
        </button>
      </div>

      {preview && (
        <div className="mt-4 space-y-4">
          {/* Mapping table */}
          <div className="neu-inset-sm p-3">
            <div className="flex items-baseline justify-between mb-2">
              <div className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)] font-semibold">
                Column mapping ({mapping.filter((m) => m.target_field).length} of {mapping.length} mapped)
              </div>
              <div className="text-[10px] font-mono text-[var(--neu-text-subtle)]">
                {preview.provider}/{preview.model} · {preview.latency_ms}ms
              </div>
            </div>
            <table className="w-full text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)]">
                <tr>
                  <th className="text-left py-1.5 pr-3">Source column</th>
                  <th className="text-left py-1.5 pr-3">→ Canonical field</th>
                  <th className="text-left py-1.5 pr-3">Confidence</th>
                  <th className="text-left py-1.5">AI reasoning</th>
                </tr>
              </thead>
              <tbody>
                {mapping.map((m, i) => (
                  <tr key={m.source_column} className="border-t border-[var(--neu-shadow-dark-soft)]">
                    <td className="py-1.5 pr-3 font-mono text-[var(--neu-text)]">{m.source_column}</td>
                    <td className="py-1.5 pr-3">
                      <select
                        value={m.target_field ?? ""}
                        onChange={(e) => updateTarget(i, e.target.value || null)}
                        className="text-xs px-2 py-1 rounded"
                      >
                        <option value="">(discard)</option>
                        {preview.canonical_fields.map((f) => (
                          <option key={f} value={f}>{f}</option>
                        ))}
                      </select>
                    </td>
                    <td className={`py-1.5 pr-3 font-mono tabular-nums ${confidenceColor(m.confidence, !!m.target_field)}`}>
                      {(m.confidence * 100).toFixed(0)}%
                    </td>
                    <td className="py-1.5 text-[var(--neu-text-muted)] italic">{m.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.overall_notes && (
              <p className="text-[11px] text-[var(--neu-text-subtle)] mt-3 italic border-t border-[var(--neu-shadow-dark-soft)] pt-2">
                {preview.overall_notes}
              </p>
            )}
          </div>

          {/* Sample row preview with issues */}
          <div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)] font-semibold mb-2">
              Sample rows · first {preview.sample_rows.length} of {preview.row_count}
            </div>
            <div className="space-y-1.5">
              {preview.sample_rows.map((sr, i) => (
                <div
                  key={i}
                  className={`text-[11px] font-mono px-3 py-2 rounded-md ${
                    sr.issues.length > 0
                      ? "neu-inset-sm border-l-2 border-c-amber"
                      : "neu-inset-sm border-l-2 border-c-emerald"
                  }`}
                >
                  <div className="text-[var(--neu-text-muted)] truncate">
                    {Object.entries(sr.row)
                      .filter(([k]) => mapping.find((m) => m.source_column === k && m.target_field))
                      .map(([k, v]) => `${k}=${v}`)
                      .join(" · ")}
                  </div>
                  {sr.issues.length > 0 && (
                    <div className="text-c-amber mt-1">
                      ⚠ {sr.issues.join(" · ")}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* Apply */}
          <div className="flex items-center justify-between gap-3 pt-2 border-t border-[var(--neu-shadow-dark-soft)]">
            <div className="text-xs text-[var(--neu-text-muted)]">
              Apply will create {preview.row_count} Customer rows
              {preview.discarded_columns.length > 0 && (
                <span className="text-[var(--neu-text-subtle)]">
                  {" "}· discarding columns: {preview.discarded_columns.join(", ")}
                </span>
              )}
              . Rows with unusable phone+email are skipped.
            </div>
            <button
              onClick={onApply}
              disabled={applying || busy}
              className="neu-btn neu-btn-primary px-4 py-2 text-sm"
            >
              {applying ? <AILoader label="Ingesting…" /> : "Apply mapping & ingest →"}
            </button>
          </div>
        </div>
      )}
    </>
  );

  if (bare) return body;
  return <section className="neu-card accent-violet p-5 animate-fade-in">{body}</section>;
}
