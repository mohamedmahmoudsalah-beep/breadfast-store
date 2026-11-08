import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let browserClient: SupabaseClient | null = null;

/** Accepts the URL even if it was pasted with a path (e.g. ".../rest/v1/") or a trailing slash. */
function cleanUrl(raw: string): string {
  return raw.trim().replace(/\/(rest|auth|functions|storage|realtime)\/v1.*$/i, "").replace(/\/+$/, "");
}

export function getSupabaseEnv() {
  return {
    url: cleanUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""),
    anonKey: (process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "").trim(),
  };
}

/**
 * Browser Supabase client. Uses ONLY the public anon key.
 * Real protection comes from Row Level Security and database functions,
 * never from hiding this key. The service-role key must never appear in this project.
 */
export function getSupabase(): SupabaseClient {
  const { url, anonKey } = getSupabaseEnv();
  if (!url || !anonKey) {
    throw new Error("Supabase environment variables are missing (see docs/SETUP.md).");
  }
  if (!browserClient) {
    browserClient = createClient(url, anonKey, {
      auth: { persistSession: true, autoRefreshToken: true },
    });
  }
  return browserClient;
}
