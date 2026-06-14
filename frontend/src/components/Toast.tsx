"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";

type ToastKind = "success" | "error" | "info" | "warning";

type Toast = {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
};

type ToastContextValue = {
  toast: (kind: ToastKind, title: string, description?: string) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
  warning: (title: string, description?: string) => void;
};

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    const noop = () => {};
    return {
      toast: noop,
      success: noop,
      error: noop,
      info: noop,
      warning: noop,
    } satisfies ToastContextValue;
  }
  return ctx;
}

const DOT_CLS: Record<ToastKind, string> = {
  success: "bg-[var(--c-emerald)]",
  error: "bg-[var(--c-rose)]",
  info: "bg-[var(--c-sky)]",
  warning: "bg-[var(--c-amber)]",
};

const LABEL_CLS: Record<ToastKind, string> = {
  success: "text-c-emerald",
  error: "text-c-rose",
  info: "text-c-sky",
  warning: "text-c-amber",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback<ToastContextValue["toast"]>(
    (kind, title, description) => {
      const id = ++nextId.current;
      setToasts((prev) => [...prev, { id, kind, title, description }]);
      setTimeout(() => remove(id), 4500);
    },
    [remove]
  );

  const value: ToastContextValue = {
    toast,
    success: (t, d) => toast("success", t, d),
    error: (t, d) => toast("error", t, d),
    info: (t, d) => toast("info", t, d),
    warning: (t, d) => toast("warning", t, d),
  };

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto neu-raised px-4 py-3 animate-slide-in-right"
          >
            <div className="flex items-start gap-3">
              <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT_CLS[t.kind]}`} />
              <div className="min-w-0 flex-1">
                <div className={`text-xs font-semibold ${LABEL_CLS[t.kind]}`}>{t.title}</div>
                {t.description && (
                  <div className="text-[11px] text-[var(--neu-text-muted)] mt-0.5 leading-relaxed">
                    {t.description}
                  </div>
                )}
              </div>
              <button
                onClick={() => remove(t.id)}
                className="text-[var(--neu-text-subtle)] hover:text-[var(--neu-text)] text-sm leading-none"
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
