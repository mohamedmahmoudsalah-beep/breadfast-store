import { getSupabase } from "@/lib/supabase/client";

/** Calls a Postgres function. Throws the Supabase error (use errorMessage() to show it). */
export async function rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await getSupabase().rpc(fn, args ?? {});
  if (error) throw error;
  return data as T;
}
