import { getSupabase } from "@/lib/supabase/client";

/** Asks the secure Edge Function to create a Paymob checkout, then sends the browser to Paymob's hosted page.
 *  Card data never touches this app. The browser's return from Paymob is NOT trusted: only the signed server webhook confirms payment. */
export async function startCardPayment(orderId: string, purpose: "order" | "extra" = "order"): Promise<void> {
  const { data, error } = await getSupabase().functions.invoke("paymob-init", { body: { order_id: orderId, purpose } });
  if (error) {
    let code = "PAYMENT_INIT_FAILED";
    try { const body = await (error as { context?: Response }).context?.json(); if (body?.error) code = body.error; } catch { /* ignore */ }
    throw Object.assign(new Error(code), { code });
  }
  const url = (data as { checkout_url?: string })?.checkout_url;
  if (!url) throw new Error("PAYMENT_INIT_FAILED");
  window.location.href = url;
}

/** Fire-and-forget: ask the worker to push pending card refunds to Paymob. */
export async function kickRefundWorker(): Promise<void> {
  try { await getSupabase().functions.invoke("process-refunds", { body: {} }); } catch { /* admins can retry later */ }
}
