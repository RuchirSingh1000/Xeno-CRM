"use client";

/** Floating chat copilot.
 *
 * A small launcher button in the bottom-right corner opens a slide-in panel.
 * The marketer types natural-language questions; the backend runs a ReAct-style
 * tool-use loop over the CRM's read APIs and returns an answer plus the trace
 * of tool calls used to build it (collapsed by default — power users can
 * inspect, casual users see only the answer).
 */

import { useEffect, useRef, useState } from "react";
import { askCopilot, type CopilotTraceStep } from "@/lib/api";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
  trace?: CopilotTraceStep[];
  meta?: { provider: string; model: string; latency_ms: number };
};

const SUGGESTIONS = [
  "Which campaign converted best?",
  "How is WhatsApp doing vs SMS?",
  "Top 5 customers in Mumbai?",
  "What's our delivery failure rate?",
];

export function Copilot() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (open && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, open, busy]);

  const send = async (q?: string) => {
    const question = (q ?? input).trim();
    if (!question || busy) return;
    setInput("");
    const userMsg: ChatMessage = { role: "user", content: question };
    setMessages((m) => [...m, userMsg]);
    setBusy(true);
    const history = messages.map(({ role, content }) => ({ role, content }));
    const r = await askCopilot({ question, history });
    setBusy(false);
    if (!r) {
      setMessages((m) => [
        ...m,
        { role: "assistant", content: "Sorry — the copilot is unreachable. Check /ai-runs." },
      ]);
      return;
    }
    setMessages((m) => [
      ...m,
      {
        role: "assistant",
        content: r.answer || "(no answer)",
        trace: r.trace,
        meta: { provider: r.provider, model: r.model, latency_ms: r.latency_ms },
      },
    ]);
  };

  return (
    <>
      {/* Launcher */}
      <button
        type="button"
        aria-label="Open Xeno copilot"
        onClick={() => setOpen((v) => !v)}
        className="copilot-launcher fixed bottom-4 right-4 z-40 rounded-full flex items-center justify-center"
        title="Ask Xeno"
      >
        {open ? "×" : "✦"}
      </button>

      {/* Panel */}
      <div
        className={`copilot-panel fixed bottom-20 right-4 z-40 flex flex-col rounded-2xl overflow-hidden ${
          open ? "copilot-panel--open" : ""
        }`}
        role="dialog"
        aria-hidden={!open}
      >
        <div className="copilot-header px-4 py-3 flex items-center gap-2">
          <span className="text-xeno text-lg">✦</span>
          <div className="flex-1">
            <div className="text-sm font-semibold">Ask Xeno</div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)]">
              copilot · reads your CRM in real time
            </div>
          </div>
          <button
            onClick={() => setMessages([])}
            disabled={messages.length === 0 || busy}
            className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)] hover:text-[var(--neu-text)] disabled:opacity-40"
            title="Clear conversation"
          >
            clear
          </button>
        </div>

        <div ref={scrollRef} className="copilot-body flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {messages.length === 0 && (
            <div className="space-y-3">
              <div className="text-xs text-[var(--neu-text-muted)] leading-relaxed">
                Ask anything about your customers, campaigns, channels, or revenue. I'll call live
                CRM endpoints and answer with real numbers.
              </div>
              <div className="space-y-1.5">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => send(s)}
                    className="copilot-suggestion w-full text-left text-xs px-3 py-2 rounded-lg"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <Message key={i} msg={m} />
          ))}

          {busy && (
            <div className="flex items-center gap-2 text-xs text-[var(--neu-text-subtle)]">
              <span className="copilot-dots">
                <span></span>
                <span></span>
                <span></span>
              </span>
              thinking…
            </div>
          )}
        </div>

        <div className="copilot-input-row px-3 py-3 flex gap-2 items-center">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Ask about your CRM…"
            disabled={busy}
            className="flex-1 text-sm px-3 py-2 rounded-full"
          />
          <button
            onClick={() => send()}
            disabled={busy || !input.trim()}
            className="copilot-send px-4 py-2 rounded-full text-sm font-semibold"
            aria-label="Send"
          >
            ↑
          </button>
        </div>
      </div>
    </>
  );
}

function Message({ msg }: { msg: ChatMessage }) {
  const [traceOpen, setTraceOpen] = useState(false);
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="copilot-bubble copilot-bubble--user text-sm">{msg.content}</div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5">
      <div className="copilot-bubble copilot-bubble--assistant text-sm leading-relaxed whitespace-pre-wrap">
        {msg.content}
      </div>
      {msg.trace && msg.trace.length > 0 && (
        <button
          className="text-[10px] uppercase tracking-wider text-xeno/80 hover:text-xeno text-left ml-1"
          onClick={() => setTraceOpen((v) => !v)}
        >
          {traceOpen ? "▾" : "▸"} {msg.trace.length} tool call{msg.trace.length === 1 ? "" : "s"}
          {msg.meta && (
            <span className="ml-2 text-[var(--neu-text-subtle)] normal-case tracking-normal">
              · {msg.meta.provider}/{msg.meta.model} · {msg.meta.latency_ms}ms
            </span>
          )}
        </button>
      )}
      {traceOpen && msg.trace && (
        <div className="space-y-1.5 ml-1">
          {msg.trace.map((t, i) => (
            <div key={i} className="copilot-trace text-[10px] font-mono px-2.5 py-1.5 rounded-md">
              <div className="text-xeno">→ {t.tool}({Object.keys(t.args).length ? JSON.stringify(t.args) : ""})</div>
              {t.thought && <div className="text-[var(--neu-text-subtle)] italic mt-0.5">why: {t.thought}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
