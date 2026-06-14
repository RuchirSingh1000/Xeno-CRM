/** Inline + block AI loaders.
 *
 * The inline variant sits inside a button while an LLM call is in flight.
 * The block variant pops in like a Siri orb — rotating conic gradient halo
 * around a pulsing pill of wave bars in Xeno blue.
 */

/** Compact loader for inside buttons. ~5 wave bars over a pulsing pill. */
export function AILoader({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2" role="status" aria-live="polite">
      <span className="siri-inline" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
      </span>
      {label && <span>{label}</span>}
    </span>
  );
}

/** Block-level Siri-style AI orb. Use as a popup while generating. */
export function AILoaderBlock({
  label = "Generating with AI…",
  hint,
}: {
  label?: string;
  hint?: string;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center gap-4 py-6"
      role="status"
      aria-live="polite"
    >
      <div className="siri-block">
        <span className="siri-bars" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
          <span />
        </span>
      </div>
      <div className="text-center">
        <div className="text-sm font-semibold text-[var(--neu-text-strong)]">{label}</div>
        {hint && (
          <div className="text-xs text-[var(--neu-text-subtle)] mt-1 max-w-md mx-auto">
            {hint}
          </div>
        )}
      </div>
    </div>
  );
}

/** Even larger Siri orb — for full-page AI moments. */
export function AILoaderOrb({ label }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3" role="status" aria-live="polite">
      <div className="siri-orb">
        <span className="siri-bars" aria-hidden="true">
          <span style={{ height: 10 }} />
          <span style={{ height: 18 }} />
          <span style={{ height: 26 }} />
          <span style={{ height: 18 }} />
          <span style={{ height: 10 }} />
        </span>
      </div>
      {label && (
        <div className="text-xs font-medium text-[var(--neu-text-muted)]">{label}</div>
      )}
    </div>
  );
}
