// Sends pending CARD refunds to Paymob. Callable by signed-in users (after a cancellation) or by a scheduler with x-cron-secret.
import { cors, env, json, PAYMOB_BASE, serviceClient } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  try {
    const svc = serviceClient();
    const cron = req.headers.get("x-cron-secret");
    const cronOk = Boolean(cron) && cron === Deno.env.get("CRON_SECRET");
    if (!cronOk) {
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer /i, "");
      const { data } = await svc.auth.getUser(token);
      if (!data?.user) return json(req, { error: "NOT_AUTHENTICATED" }, 401);   // the public anon key alone is not enough
    }
    const { data: claimed, error } = await svc.rpc("refund_claim_pending", { p_limit: 10 });
    if (error) throw error;
    const results: unknown[] = [];
    for (const r of (claimed ?? []) as { refund_id: string; amount_piastres: number; provider_txn_id: string | null }[]) {
      if (!r.provider_txn_id) { await svc.rpc("refund_fail", { p_refund: r.refund_id, p_error: "original transaction id missing" }); continue; }
      try {
        const res = await fetch(`${PAYMOB_BASE()}/api/acceptance/void_refund/refund`, {
          method: "POST",
          headers: { Authorization: `Token ${env("PAYMOB_SECRET_KEY")}`, "Content-Type": "application/json" },
          body: JSON.stringify({ transaction_id: Number(r.provider_txn_id), amount_cents: r.amount_piastres }),
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.success !== false && !body.detail && body.id) {
          await svc.rpc("refund_complete", { p_refund: r.refund_id, p_provider_refund_id: String(body.id) });
          results.push({ id: r.refund_id, ok: true });
        } else {
          const msg = JSON.stringify(body).slice(0, 300);
          await svc.rpc("refund_fail", { p_refund: r.refund_id, p_error: `paymob ${res.status}: ${msg}` });
          results.push({ id: r.refund_id, ok: false });
        }
      } catch (e) {
        await svc.rpc("refund_fail", { p_refund: r.refund_id, p_error: `network: ${(e as Error).message}` });
      }
    }
    return json(req, { processed: results.length, results });
  } catch (e) {
    console.error("process-refunds", e);
    return json(req, { error: "INTERNAL" }, 500);
  }
});
