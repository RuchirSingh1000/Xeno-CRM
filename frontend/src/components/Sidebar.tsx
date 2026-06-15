"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ThemeToggle } from "@/components/ThemeProvider";

type NavItem = {
  label: string;
  href: string;
  phase: number;
  enabled: boolean;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

const GROUPS: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { label: "Overview", href: "/", phase: 0, enabled: true },
      { label: "Data sources", href: "/data-sources", phase: 1, enabled: true },
    ],
  },
  {
    label: "Ingestion",
    items: [
      { label: "Ingest", href: "/ingest", phase: 2, enabled: true },
      { label: "Identity resolution", href: "/identities", phase: 2, enabled: true },
    ],
  },
  {
    label: "Customers",
    items: [
      { label: "Customers", href: "/customers", phase: 2, enabled: true },
    ],
  },
  {
    label: "Engagement",
    items: [
      { label: "Segments", href: "/segments", phase: 3, enabled: true },
      { label: "Campaigns", href: "/campaigns", phase: 3, enabled: true },
      { label: "Event log", href: "/events", phase: 4, enabled: true },
      { label: "Reliability", href: "/reliability", phase: 4, enabled: true },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { label: "Analytics", href: "/analytics", phase: 6, enabled: true },
      { label: "AI runs", href: "/ai-runs", phase: 2, enabled: true },
      { label: "AI evals", href: "/evals", phase: 5, enabled: true },
      { label: "About", href: "/about", phase: 0, enabled: true },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside suppressHydrationWarning className="w-64 shrink-0 flex flex-col sticky top-0 h-screen pl-4 pr-7 py-4 gap-3">
      {/* Logo */}
      <Link
        href="/"
        suppressHydrationWarning
        className="neu-raised flex items-center gap-2.5 px-4 py-3 hover:scale-[1.01] transition"
      >
        <div
          suppressHydrationWarning
          className="h-9 w-9 rounded-xl bg-gradient-to-br from-[var(--xeno-blue)] to-[var(--xeno-blue-hover)] flex items-center justify-center shadow-[2px_2px_4px_var(--neu-shadow-dark-soft),-2px_-2px_4px_var(--neu-shadow-light-soft)]"
        >
          <span className="text-white text-sm font-bold">R</span>
        </div>
        <div suppressHydrationWarning>
          <div className="text-sm font-semibold leading-tight text-[var(--neu-text)]">Retail Activation</div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)] leading-tight">
            Console
          </div>
        </div>
      </Link>

      {/* Active brand — Xeno blue gradient panel */}
      <div className="neu-brand-panel px-3 py-2.5">
        <div className="text-[10px] uppercase tracking-wider opacity-80 mb-1">
          Active brand
        </div>
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-xs font-semibold">Brewhouse Co.</div>
            <div className="text-[10px] opacity-80">Coffee & QSR · India</div>
          </div>
          <span className="neu-pill">Demo</span>
        </div>
      </div>

      {/* Nav groups — scroll if viewport is too short so the footer stays pinned */}
      <nav className="sidebar-nav flex-1 min-h-0 overflow-y-auto -mx-2 px-2 space-y-4">
        {GROUPS.map((g) => (
          <div key={g.label} suppressHydrationWarning>
            <div
              className="text-[10px] uppercase tracking-wider text-[var(--neu-text-subtle)] px-2 mb-1.5"
              suppressHydrationWarning
            >
              {g.label}
            </div>
            <ul className="space-y-1" suppressHydrationWarning>
              {g.items.map((item) => {
                const active = pathname === item.href;
                if (!item.enabled) {
                  return (
                    <li key={item.href}>
                      <div className="flex items-center justify-between px-3 py-2 rounded-xl text-sm text-[var(--neu-text-faint)] cursor-default">
                        <span>{item.label}</span>
                        <span className="text-[9px] font-mono uppercase text-[var(--neu-text-faint)]">
                          P{item.phase}
                        </span>
                      </div>
                    </li>
                  );
                }
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`flex items-center justify-between px-3 py-2 rounded-xl text-sm transition ${
                        active
                          ? "neu-inset text-xeno font-semibold"
                          : "text-[var(--neu-text-muted)] hover:text-[var(--neu-text)]"
                      }`}
                    >
                      <span>{item.label}</span>
                      {active && (
                        <span className="h-1.5 w-1.5 rounded-full bg-[var(--xeno-blue)] animate-pulse-glow" />
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Footer — pinned at bottom, never shrinks */}
      <div className="neu-raised-sm shrink-0 px-3 py-2.5 mt-2 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-1.5 text-[10px] text-[var(--neu-text-muted)]">
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--c-emerald)] animate-pulse-glow" />
            <span>All systems healthy</span>
          </div>
          <div className="mt-0.5 text-[10px] font-mono text-[var(--neu-text-subtle)]">Retail Activation v1.0</div>
        </div>
        <ThemeToggle />
      </div>
    </aside>
  );
}
