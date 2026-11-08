// Pure helpers (no Deno-only APIs) so they can be unit-tested in Node.

/** Paymob "transaction processed callback" HMAC: concatenate these fields IN THIS ORDER, then HMAC-SHA512 (hex). */
export const HMAC_FIELDS = [
  "amount_cents", "created_at", "currency", "error_occured", "has_parent_transaction", "id", "integration_id",
  "is_3d_secure", "is_auth", "is_capture", "is_refunded", "is_standalone_payment", "is_voided", "order.id",
  "owner", "pending", "source_data.pan", "source_data.sub_type", "source_data.type", "success",
] as const;

type Json = Record<string, unknown>;

function pick(obj: unknown, path: string): string {
  const v = path.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as Json)[k]), obj);
  if (v === undefined || v === null) return "";
  return typeof v === "boolean" ? (v ? "true" : "false") : String(v);
}

export function hmacMessage(obj: unknown): string {
  return HMAC_FIELDS.map((f) => pick(obj, f)).join("");
}

const toHex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function computeHmac(obj: unknown, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(hmacMessage(obj))));
}

/** Constant-time comparison of two hex strings. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyHmac(obj: unknown, received: string | null, secret: string): Promise<boolean> {
  if (!received || !secret) return false;
  return safeEqual((await computeHmac(obj, secret)).toLowerCase(), received.toLowerCase());
}

export type ParsedCallback = {
  kind: "payment" | "refund" | "ignore"; eventKey: string; txnId: string; merchantRef: string;
  amountCents: number; currency: string; success: boolean; pending: boolean;
};

export function parseCallback(body: unknown): ParsedCallback {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const o = ((body as Json | null)?.obj ?? {}) as any; // deno-lint-ignore no-explicit-any
  const isRefundTxn = o.parent_transaction !== null && o.parent_transaction !== undefined && o.parent_transaction !== "";
  const flags = [o.success, o.pending, o.is_refunded, o.is_voided].map((x) => (x ? 1 : 0)).join("");
  const kind: ParsedCallback["kind"] = isRefundTxn ? "refund" : (o.is_refunded || o.is_voided) ? "ignore" : "payment";
  return {
    kind,
    eventKey: `${kind}:${o.id}:${flags}`,
    txnId: String(o.id ?? ""),
    merchantRef: String(o.order?.merchant_order_id ?? o.payment_key_claims?.extra?.payment_id ?? ""),
    amountCents: Number(o.amount_cents ?? 0),
    currency: String(o.currency ?? ""),
    success: o.success === true || o.success === "true",
    pending: o.pending === true || o.pending === "true",
  };
}
