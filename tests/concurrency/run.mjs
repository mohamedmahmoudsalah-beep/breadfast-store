// REAL-concurrency check against a Supabase STAGING project (never production).
// The in-memory Postgres used by `npm test` runs one connection, so true parallel races must be proven on the real server.
//
//   SUPABASE_URL=... SUPABASE_ANON_KEY=... TEST_USERS="u1@x.com:pw,u2@x.com:pw,u3@x.com:pw" \
//   PRODUCT_ID=<uuid of a product with stock 5> SLOT_ID=<uuid of a slot with big capacity> npm run test:concurrency
//
// Prepare: 3+ verified employee accounts linked to HRIDs, one product with stock exactly 5 and no category limit,
// store open today, and each account with NO pending order.
import { createClient } from "@supabase/supabase-js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const { SUPABASE_URL, SUPABASE_ANON_KEY, TEST_USERS, PRODUCT_ID, SLOT_ID } = process.env;
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !TEST_USERS || !PRODUCT_ID || !SLOT_ID) { console.error("Missing env vars (see header)."); process.exit(1); }

async function login(cred) {
  const [email, password] = cred.split(":");
  const c = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { error } = await c.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`login failed for ${email}: ${error.message}`);
  return c;
}
const order = (c, qty, key = randomUUID()) => c.rpc("create_order", { p_items: [{ product_id: PRODUCT_ID, qty }], p_slot_id: SLOT_ID, p_idempotency_key: key, p_use_wallet: false });

const clients = await Promise.all(TEST_USERS.split(",").map(login));
const before = (await clients[0].from("products").select("stock_qty").eq("id", PRODUCT_ID).single()).data.stock_qty;
console.log(`stock before: ${before}, users: ${clients.length}`);

// 1) every user grabs 3 units of a product that only has 5, all at the same instant
const results = await Promise.all(clients.map((c) => order(c, 3)));
const won = results.filter((r) => !r.error);
const lost = results.filter((r) => r.error);
console.log(`orders created: ${won.length}, rejected: ${lost.length}`);
assert.equal(won.length, 1, "exactly one 3-unit order can fit into stock 5");
assert.ok(lost.every((r) => /INSUFFICIENT_STOCK|PENDING_ORDER_EXISTS/.test(r.error.message)));
const after = (await clients[0].from("products").select("stock_qty").eq("id", PRODUCT_ID).single()).data.stock_qty;
assert.equal(after, before - 3, "stock must drop by exactly 3");
assert.ok(after >= 0);

// 2) one user presses "confirm" 25 times in parallel with the same key => ONE order
const solo = clients[clients.length - 1];
const key = randomUUID();
const burst = await Promise.all(Array.from({ length: 25 }, () => order(solo, 1, key)));
const ids = new Set(burst.filter((r) => !r.error).map((r) => r.data.order_id));
console.log(`25 parallel clicks -> distinct orders: ${ids.size}`);
assert.ok(ids.size <= 1, "never more than one order for one key");

console.log("OK. Now cancel the test orders from the admin screen to restore stock.");
