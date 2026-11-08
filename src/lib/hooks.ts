"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabase } from "@/lib/supabase/client";
import { errorMessage } from "@/lib/errors";

/** Loads data (re-runs when deps change). Keeps the previous data visible while reloading. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const fnRef = useRef(fn);
  useEffect(() => { fnRef.current = fn; });
  const depsKey = JSON.stringify(deps);
  const [tick, setTick] = useState(0);
  const key = `${depsKey}#${tick}`;
  const [state, setState] = useState<{ key: string; data: T | null; error: string | null } | null>(null);

  useEffect(() => {
    let off = false;
    fnRef.current()
      .then((data) => { if (!off) setState({ key, data, error: null }); })
      .catch((e) => { if (!off) setState((s) => ({ key, data: s?.data ?? null, error: errorMessage(e) })); });
    return () => { off = true; };
  }, [key]);

  const reload = useCallback(async () => { setTick((t) => t + 1); }, []);
  return { data: state?.data ?? null, error: state?.error ?? null, loading: state === null || state.key !== key, reload };
}

/** Subscribes to Postgres changes (RLS applies) and also polls as a safety net. */
export function useRealtime(table: string, filter: string | undefined, onChange: () => void, pollMs = 20_000) {
  const cb = useRef(onChange);
  useEffect(() => { cb.current = onChange; });
  useEffect(() => {
    const supabase = getSupabase();
    const name = `rt-${table}-${filter ?? "all"}-${Math.random().toString(36).slice(2)}`;
    const channel = supabase.channel(name)
      .on("postgres_changes", { event: "*", schema: "public", table, ...(filter ? { filter } : {}) }, () => cb.current())
      .subscribe();
    const id = window.setInterval(() => { if (document.visibilityState === "visible") cb.current(); }, pollMs);
    return () => { window.clearInterval(id); void supabase.removeChannel(channel); };
  }, [table, filter, pollMs]);
}

export function useDebounced<T>(value: T, ms = 350) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
