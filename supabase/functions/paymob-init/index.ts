// Creates a Paymob checkout for an order the signed-in employee owns. Amounts come from the DATABASE, never from the browser.
import { cors, env, json, PAYMOB_BASE, serviceClient, userClient } from "../_shared/common.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  if (req.method !== "POST") return json(req, { error: "METHOD_NOT_ALLOWED" }, 405);
  try {
    const { order_id, purpose } = await req.json();
    if (typeof order_id !== "string" || !["order", "extra"].includes(purpose)) return json(req, { error: "INVALID_INPUT" }, 400);

    // 1) validates ownership/state with the caller's identity and creates the payment attempt row
    const { data: prep, error } = await userClient(req).rpc("payment_prepare", { p_order: order_id, p_purpose: purpose });
    if (error) return json(req, { error: (error.message.match(/^[A-Z_]+/) ?? ["PAYMENT_PREPARE_FAILED"])[0] }, 400);

    const fullName = String(prep.employee_name ?? "Employee").trim();
    const [first, ...rest] = fullName.split(/\s+/);
    const siteUrl = env("SITE_URL");
    const res = await fetch(`${PAYMOB_BASE()}/v1/intention/`, {
      method: "POST",
      headers: { Authorization: `Token ${env("PAYMOB_SECRET_KEY")}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        amount: prep.amount_piastres,                       // piastres == Paymob "cents" for EGP
        currency: "EGP",
        payment_methods: [Number(env("PAYMOB_INTEGRATION_ID"))],
        items: [{ name: `Order BF-${prep.order_no}`, amount: prep.amount_piastres, description: "Breadfast employee store", quantity: 1 }],
        billing_data: {
          first_name: first || "Employee", last_name: rest.join(" ") || "Breadfast", email: prep.email ?? "noreply@example.com",
          phone_number: Deno.env.get("PAYMOB_FALLBACK_PHONE") ?? "+201000000000",
          apartment: "NA", floor: "NA", street: "NA", building: "NA", shipping_method: "NA", postal_code: "NA", city: "Cairo", country: "EG", state: "Cairo",
        },
        special_reference: prep.payment_id,               // comes back as order.merchant_order_id in the callback
        notification_url: `${env("SUPABASE_URL")}/functions/v1/paymob-webhook`,
        redirection_url: `${siteUrl}/order/?id=${order_id}`,
        extras: { order_id, payment_id: prep.payment_id },
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.client_secret) {
      console.error("paymob intention failed", res.status, JSON.stringify(body).slice(0, 500));
      return json(req, { error: "PAYMENT_PROVIDER_ERROR" }, 502);
    }
    await serviceClient().rpc("payment_attach_provider", { p_payment: prep.payment_id, p_provider_order_id: String(body.id ?? body.intention_order_id ?? "") });
    const checkout_url = `${PAYMOB_BASE()}/unifiedcheckout/?publicKey=${encodeURIComponent(env("PAYMOB_PUBLIC_KEY"))}&clientSecret=${encodeURIComponent(body.client_secret)}`;
    return json(req, { checkout_url });
  } catch (e) {
    console.error("paymob-init", e);
    return json(req, { error: "INTERNAL" }, 500);
  }
});
