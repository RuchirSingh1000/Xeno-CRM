"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";

type Theme = "light" | "dark";

type ThemeContextValue = {
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggle: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    return {
      theme: "light",
      setTheme: () => {},
      toggle: () => {},
    };
  }
  return ctx;
}

const STORAGE_KEY = "xeno_theme";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("light");

  // On mount: read persisted choice, default light. We intentionally do NOT
  // honour OS prefers-color-scheme — for a demo, every first-time visitor
  // should see the brand's primary palette (light) regardless of how their
  // OS is themed. Returning visitors who actively toggled keep their choice.
  useEffect(() => {
    const stored = (typeof window !== "undefined" && localStorage.getItem(STORAGE_KEY)) as Theme | null;
    const initial: Theme = stored === "light" || stored === "dark" ? stored : "light";
    applyTheme(initial, /* withTransition */ false);
    setThemeState(initial);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    applyTheme(t, /* withTransition */ true);
    if (typeof window !== "undefined") localStorage.setItem(STORAGE_KEY, t);
    setThemeState(t);
  }, []);

  const toggle = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme, setTheme]);

  return (
    <ThemeContext.Provider value={{ theme, setTheme, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

function applyTheme(t: Theme, withTransition: boolean) {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  if (withTransition) {
    html.classList.add("transition-theme");
    setTimeout(() => html.classList.remove("transition-theme"), 320);
  }
  if (t === "dark") {
    html.classList.add("dark");
  } else {
    html.classList.remove("dark");
  }
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  const { theme, toggle } = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      type="button"
      aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
      aria-pressed={isDark}
      onClick={toggle}
      className={`theme-toggle ${isDark ? "dark-mode" : ""} ${className}`}
    >
      <span className="toggle-thumb">
        {isDark ? (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
          </svg>
        ) : (
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="4" fill="currentColor" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
          </svg>
        )}
      </span>
    </button>
  );
}
