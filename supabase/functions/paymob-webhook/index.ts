// Paymob "transaction processed callback". NOT called by browsers; deploy with --no-verify-jwt.
// Security: HMAC-SHA512 verified with the secret, amount+currency re-checked against OUR database,
// idempotent by event key, optional server-to-server inquiry. The browser redirect is never trusted.
import { env, PAYMOB_BASE, serviceClient } from "../_shared/common.ts";
import { parseCallback, verifyHmac } from "../_shared/paymob.ts";

async function inquiryConfirms(txnId: string, amountCents: number): Promise<boolean> {
  const apiKey = Deno.env.get("PAYMOB_API_KEY");
  if (!apiKey) return true;                                   // optional extra layer
  const auth = await fetch(`${PAYMOB_BASE()}/api/auth/tokens`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: apiKey }) });
  const { token } = await auth.json();
  const r = await fetch(`${PAYMOB_BASE()}/api/acceptance/transactions/${txnId}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`inquiry http ${r.status}`);       // 5xx => Paymob retries later
  const t = await r.json();
  return t.success === true && t.pending !== true && Number(t.amount_cents) === amountCents;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  try {
    const url = new URL(req.url);
    const body = await req.json();
    const hmac = url.searchParams.get("hmac");
    if (!(await verifyHmac(body?.obj, hmac, env("PAYMOB_HMAC_SECRET")))) {
      console.warn("paymob-webhook: bad HMAC");
      return new Response("invalid signature", { status: 401 });
    }
    const p = parseCallback(body);
    if (p.kind === "ignore") return new Response(JSON.stringify({ result: "ignored" }), { status: 200 });

    if (p.kind === "payment" && p.success && !p.pending) {
      if (!(await inquiryConfirms(p.txnId, p.amountCents))) {
        console.error("paymob-webhook: inquiry mismatch for txn", p.txnId);
        return new Response(JSON.stringify({ result: "inquiry_mismatch" }), { status: 200 });
      }
    }
    const { data, error } = await serviceClient().rpc("payment_process_event", {
      p_event_key: p.eventKey, p_payload: body, p_kind: p.kind, p_merchant_ref: p.merchantRef, p_txn_id: p.txnId,
      p_amount_cents: p.amountCents, p_currency: p.currency, p_success: p.success, p_pending: p.pending,
    });
    if (error) throw error;
    return new Response(JSON.stringify({ result: data }), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    console.error("paymob-webhook error", e);
    return new Response("error", { status: 500 });                 // Paymob retries
  }
});
