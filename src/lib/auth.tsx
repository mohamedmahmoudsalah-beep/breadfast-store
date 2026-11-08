"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabase, getSupabaseEnv } from "@/lib/supabase/client";
import { rpc } from "@/lib/rpc";

export type Access = {
  user_id: string; email: string; full_name: string | null; is_active: boolean; email_verified: boolean;
  hrid: string | null; employee_active: boolean | null; roles: string[]; permissions: string[];
};

type Ctx = {
  session: Session | null; access: Access | null; loading: boolean; configured: boolean;
  refresh: () => Promise<void>; signOut: () => Promise<void>;
  can: (perm: string) => boolean; hasRole: (role: string) => boolean;
};

const AuthContext = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const configured = Boolean(getSupabaseEnv().url && getSupabaseEnv().anonKey);
  const [session, setSession] = useState<Session | null>(null);
  const [access, setAccess] = useState<Access | null>(null);
  const [loading, setLoading] = useState(configured);

  const loadAccess = useCallback(async (s: Session | null) => {
    if (!s) { setAccess(null); return; }
    try { setAccess(await rpc<Access>("my_access")); } catch { setAccess(null); }
  }, []);

  useEffect(() => {
    if (!configured) return;
    const supabase = getSupabase();
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session); await loadAccess(data.session); setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => {
      setSession(s);
      setTimeout(() => { void loadAccess(s); }, 0);   // never await supabase calls inside this callback
    });
    return () => sub.subscription.unsubscribe();
  }, [configured, loadAccess]);

  // presence: one tiny heartbeat per minute while the app is open and the tab is visible
  useEffect(() => {
    if (!session || !access?.employee_active) return;
    const beat = () => { if (document.visibilityState === "visible") void rpc("heartbeat").catch(() => {}); };
    beat();
    const id = window.setInterval(beat, 60_000);
    document.addEventListener("visibilitychange", beat);
    return () => { window.clearInterval(id); document.removeEventListener("visibilitychange", beat); };
  }, [session, access?.employee_active]);

  const value = useMemo<Ctx>(() => ({
    session, access, loading, configured,
    refresh: async () => { const { data } = await getSupabase().auth.getSession(); await loadAccess(data.session); },
    signOut: async () => { await getSupabase().auth.signOut(); setAccess(null); },
    can: (perm) => Boolean(access?.roles.includes("super_admin") || access?.permissions.includes(perm)),
    hasRole: (role) => Boolean(access?.roles.includes(role)),
  }), [session, access, loading, configured, loadAccess]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
