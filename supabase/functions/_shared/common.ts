import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

export const env = (k: string, fallback?: string) => {
  const v = Deno.env.get(k) ?? fallback;
  if (v === undefined || v === "") throw new Error(`Missing secret: ${k}`);
  return v;
};

export const PAYMOB_BASE = () => (Deno.env.get("PAYMOB_BASE_URL") ?? "https://accept.paymob.com").replace(/\/$/, "");

export function cors(req: Request): Record<string, string> {
  const site = Deno.env.get("SITE_URL") ?? "*";
  const origin = req.headers.get("origin");
  return {
    "Access-Control-Allow-Origin": site === "*" || origin === site ? (origin ?? site) : site,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export const json = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), "Content-Type": "application/json" } });

/** Client acting as the signed-in user (RLS + auth.uid() apply). */
export function userClient(req: Request): SupabaseClient {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
}

/** Service-role client. Lives ONLY inside Edge Functions, never in the website. */
export const serviceClient = () =>
  createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
