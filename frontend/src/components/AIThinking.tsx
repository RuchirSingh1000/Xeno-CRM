"use client";

/** Global "AI is thinking" floating loader.
 *
 * Sits at the bottom-center of the viewport, fades in when any AI call is in
 * flight, fades out when done. Loader visual is the andrew-manzyk Uiverse
 * orb (orange→red, hue-rotating). State is exposed via React context — any
 * caller can wrap an async AI call with `runWithAIThinking(label, fn)`.
 */

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

type AIThinkingState = {
  start: (label?: string) => () => void; // returns a stop() handle
  run: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
};

const Ctx = createContext<AIThinkingState | null>(null);

export function useAIThinking(): AIThinkingState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAIThinking must be used inside AIThinkingProvider");
  return v;
}

export function AIThinkingProvider({ children }: { children: React.ReactNode }) {
  const [count, setCount] = useState(0);
  const [label, setLabel] = useState<string>("AI is thinking…");
  const labelStack = useRef<string[]>([]);

  const start = useCallback((lbl?: string) => {
    if (lbl) {
      labelStack.current.push(lbl);
      setLabel(lbl);
    }
    setCount((c) => c + 1);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      if (lbl) {
        const idx = labelStack.current.lastIndexOf(lbl);
        if (idx >= 0) labelStack.current.splice(idx, 1);
        const top = labelStack.current[labelStack.current.length - 1];
        if (top) setLabel(top);
      }
      setCount((c) => Math.max(0, c - 1));
    };
  }, []);

  const run = useCallback(
    async <T,>(lbl: string, fn: () => Promise<T>): Promise<T> => {
      const stop = start(lbl);
      try {
        return await fn();
      } finally {
        stop();
      }
    },
    [start]
  );

  const value = useMemo(() => ({ start, run }), [start, run]);
  const visible = count > 0;

  return (
    <Ctx.Provider value={value}>
      {children}
      <AIThinkingOverlay visible={visible} label={label} />
    </Ctx.Provider>
  );
}

function AIThinkingOverlay({ visible, label }: { visible: boolean; label: string }) {
  return (
    <div
      className={`ai-thinking-dock ${visible ? "is-visible" : ""}`}
      role="status"
      aria-live="polite"
      aria-hidden={!visible}
    >
      <div className="ai-thinking-pill">
        <div className="loader-andrew" aria-hidden="true">
          <svg width="100" height="100" viewBox="0 0 100 100">
            <defs>
              <mask id="ai-thinking-clip">
                <polygon points="0,0 100,0 100,100 0,100" fill="black" />
                <polygon points="25,25 75,25 50,75" fill="white" />
                <polygon points="50,25 75,75 25,75" fill="white" />
                <polygon points="35,35 65,35 50,65" fill="white" />
                <polygon points="35,35 65,35 50,65" fill="white" />
                <polygon points="35,35 65,35 50,65" fill="white" />
                <polygon points="35,35 65,35 50,65" fill="white" />
              </mask>
            </defs>
          </svg>
          <div className="box" />
        </div>
        <div className="ai-thinking-label">
          <div className="ai-thinking-title">{label}</div>
          <div className="ai-thinking-sub">model is generating · this may take a few seconds</div>
        </div>
      </div>
    </div>
  );
}
