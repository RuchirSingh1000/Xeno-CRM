"use client";

/** Logical navigation stack for the back button.
 *
 * Why not router.back():
 * - Browser history pushes a new entry on every navigation, including ones
 *   that re-enter pages already visited. So Overview → Campaigns → Detail →
 *   Campaigns (via link) makes router.back() go to Detail, not Overview.
 * - We want "go to where I came from in terms of distinct pages," which is a
 *   deduplicated stack.
 *
 * Behaviour:
 * - On every route change, compare the new path against the stack:
 *   - If it equals the top, do nothing.
 *   - If it appears lower in the stack, TRUNCATE to it (the user navigated
 *     "back" via a link to an earlier page; the stack should reflect that).
 *   - Otherwise, push.
 * - back() pops the top and returns the new top; the caller navigates there.
 *
 * The stack lives in component state (not a ref) so consumers re-render
 * when it changes — critical for the back button visibility to update on
 * route change.
 */

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

type Stack = string[];

const KEY = "xeno_nav_stack";

function readStack(): Stack {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Stack) : [];
  } catch {
    return [];
  }
}

function writeStack(s: Stack) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* quota or disabled — non-fatal */
  }
}

type NavHistoryApi = {
  canGoBack: boolean;
  back: () => void;
};

const Ctx = createContext<NavHistoryApi | null>(null);

export function useNavHistory(): NavHistoryApi {
  const v = useContext(Ctx);
  if (!v) return { canGoBack: false, back: () => {} };
  return v;
}

export function NavHistoryProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  // CRITICAL: start with an empty stack so server-render and first
  // client-render produce identical HTML. sessionStorage doesn't exist on
  // the server, so reading it during render causes a hydration mismatch
  // (back button rendered on client but not server → React throws).
  // The first useEffect below hydrates from sessionStorage after mount.
  const [stack, setStack] = useState<Stack>([]);
  const [hydrated, setHydrated] = useState(false);

  // One-shot hydration from sessionStorage after mount. Runs before the
  // pathname effect because both are queued in render order.
  useEffect(() => {
    const stored = readStack();
    if (stored.length > 0) setStack(stored);
    setHydrated(true);
  }, []);

  // Update on every route change. Empty-stack rule: on the very first
  // navigation, if the user lands on any non-home page with no history
  // (direct load, refresh, deep link), seed "/" beneath it so back always
  // has somewhere sensible to go. Wait for hydration so we don't push
  // before the stored stack has loaded.
  useEffect(() => {
    if (!pathname || !hydrated) return;
    setStack((prev) => {
      // Bootstrap rule: if the stored stack is only the current non-home
      // page (direct load / refresh / stale session), seed "/" beneath it
      // so there's always a back target.
      if (
        prev.length <= 1 &&
        pathname !== "/" &&
        (prev[0] === pathname || prev.length === 0)
      ) {
        const next: Stack = ["/", pathname];
        writeStack(next);
        return next;
      }
      const top = prev[prev.length - 1];
      if (top === pathname) return prev;
      const existingIdx = prev.indexOf(pathname);
      let next: Stack;
      if (existingIdx >= 0) {
        next = prev.slice(0, existingIdx + 1);
      } else {
        next = [...prev, pathname].slice(-30);
      }
      writeStack(next);
      return next;
    });
  }, [pathname, hydrated]);

  const api = useMemo<NavHistoryApi>(
    () => ({
      canGoBack: stack.length > 1,
      back: () => {
        if (stack.length < 2) return;
        const next = stack.slice(0, -1);
        const target = next[next.length - 1];
        writeStack(next);
        setStack(next);
        if (target) router.push(target);
      },
    }),
    [stack, router],
  );

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}
