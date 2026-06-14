"use client";

import { useEffect, useState } from "react";
import { useNavHistory } from "@/components/NavHistory";

type Props = {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: React.ReactNode;
};

export function PageHeader({ eyebrow, title, description, actions }: Props) {
  const nav = useNavHistory();
  // Only consider the back button after client mount, so the SSR HTML
  // (no button) matches the first client render (no button). After mount,
  // canGoBack reflects the real nav stack.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const canGoBack = mounted && nav.canGoBack;

  return (
    <div className="sticky top-0 z-10 px-8 py-6 bg-[var(--neu-bg)]/85 backdrop-blur" suppressHydrationWarning>
      <div className="flex items-start justify-between gap-6 max-w-7xl" suppressHydrationWarning>
        <div className="min-w-0 flex items-start gap-3" suppressHydrationWarning>
          {canGoBack && (
            <button
              type="button"
              onClick={() => nav.back()}
              aria-label="Go back"
              title="Go back to previous page"
              className="page-back mt-1 shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-lg leading-none"
            >
              ←
            </button>
          )}
          <div className="min-w-0" suppressHydrationWarning>
            {eyebrow && (
              <div className="text-[10px] uppercase tracking-widest text-[var(--neu-text-subtle)] mb-2" suppressHydrationWarning>
                {eyebrow}
              </div>
            )}
            <h1 className="text-3xl font-bold tracking-tight text-[var(--neu-text)]">{title}</h1>
            {description && (
              <p className="mt-2 text-sm text-[var(--neu-text-muted)] max-w-2xl leading-relaxed">{description}</p>
            )}
          </div>
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
    </div>
  );
}
