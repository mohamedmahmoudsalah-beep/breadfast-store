import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { computeHmac, verifyHmac, parseCallback, safeEqual } from "../../supabase/functions/_shared/paymob.ts";

const obj = {
  amount_cents: 6151, created_at: "2026-11-09T09:15:00.123456", currency: "EGP", error_occured: false, has_parent_transaction: false,
  id: 123456789, integration_id: 4001, is_3d_secure: true, is_auth: false, is_capture: false, is_refunded: false,
  is_standalone_payment: true, is_voided: false, order: { id: 987654, merchant_order_id: "11111111-2222-3333-4444-555555555555" },
  owner: 888, pending: false, source_data: { pan: "2346", sub_type: "MasterCard", type: "card" }, success: true,
};
const SECRET = "test-hmac-secret";
test("HMAC matches an independent implementation of the documented field order", async () => {
  const msg = [obj.amount_cents, obj.created_at, obj.currency, "false", "false", obj.id, obj.integration_id, "true", "false", "false", "false", "true", "false",
    obj.order.id, obj.owner, "false", "2346", "MasterCard", "card", "true"].join("");
  const expected = createHmac("sha512", SECRET).update(msg).digest("hex");
  assert.equal(await computeHmac(obj, SECRET), expected);
});

test("valid signature accepted; tampered amount, wrong secret, missing signature rejected", async () => {
  const good = await computeHmac(obj, SECRET);
  assert.equal(await verifyHmac(obj, good, SECRET), true);
  assert.equal(await verifyHmac(obj, good.toUpperCase(), SECRET), true);
  assert.equal(await verifyHmac({ ...obj, amount_cents: 1 }, good, SECRET), false);        // attacker lowers the amount
  assert.equal(await verifyHmac({ ...obj, success: false }, good, SECRET), false);
  assert.equal(await verifyHmac(obj, good, "other-secret"), false);
  assert.equal(await verifyHmac(obj, null, SECRET), false);
  assert.equal(await verifyHmac(obj, good, ""), false);
});

test("callback parsing: payment, refund transaction, flags and event keys", () => {
  const p = parseCallback({ obj });
  assert.deepEqual([p.kind, p.txnId, p.amountCents, p.currency, p.success, p.pending, p.merchantRef],
    ["payment", "123456789", 6151, "EGP", true, false, "11111111-2222-3333-4444-555555555555"]);
  const refund = parseCallback({ obj: { ...obj, id: 55, parent_transaction: 123456789, is_refunded: true } });
  assert.equal(refund.kind, "refund");
  assert.equal(parseCallback({ obj: { ...obj, is_voided: true } }).kind, "ignore");
  // the same transaction in a different state must produce a different event key (pending -> success)
  assert.notEqual(parseCallback({ obj: { ...obj, pending: true, success: false } }).eventKey, p.eventKey);
  assert.equal(parseCallback({ obj }).eventKey, p.eventKey);                                 // identical callback => identical key (dedupe)
});

test("safeEqual", () => { assert.equal(safeEqual("ab", "ab"), true); assert.equal(safeEqual("ab", "ac"), false); assert.equal(safeEqual("ab", "abc"), false); });
