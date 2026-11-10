import { newDb } from "./harness.mjs";
import assert from "node:assert/strict";

export const NOW_MON_9AM = "2026-11-09T07:00:00Z";      // Monday 09:00 Cairo (UTC+2 in November)
let seq = 0;

export async function seed() {
  const h = await newDb();
  await h.setNow(NOW_MON_9AM);
  for (const u of ["admin", "emp1", "emp2", "emp3", "picker1", "picker2", "pickup1", "stranger"]) await h.addUser(u);
  await h.grantRole("admin", "super_admin");
  await h.grantRole("picker1", "picker"); await h.grantRole("picker2", "picker"); await h.grantRole("pickup1", "pickup");
  await h.rpc("admin", "hrid_import", [{ hrid: "h1", name: "Ahmed Ali" }, { hrid: "H2", name: "Sara Omar" }, { hrid: "H3", name: "Mona Said" }]);
  await h.rpc("emp1", "link_hrid", "H1"); await h.rpc("emp2", "link_hrid", " h2 "); await h.rpc("emp3", "link_hrid", "H3");

  const cb = await h.rpc("admin", "import_stage", "catalog.xlsx", [
    { barcode: "111", name: "Cola", category: "Soft Drinks", price: "10" },
    { barcode: "222", name: "Chips", category: "Snacks", price: "25.50" },
    { barcode: "333", name: "Water", category: "Soft Drinks", price: "5" }], "catalog");
  await h.rpc("admin", "import_confirm", cb.batch_id, false);
  const sb = await h.rpc("admin", "import_stage", "stock1.xlsx", [
    { barcode: "111", name: "Cola", qty: "100" }, { barcode: "222", name: "Chips", qty: "20" }, { barcode: "333", name: "Water", qty: "10" }], "stock");
  await h.rpc("admin", "import_confirm", sb.batch_id, false);
  const cat = (await h.asPostgres("select id from categories where name='Soft Drinks'")).rows[0].id;
  await h.rpc("admin", "category_save", { id: cat, name: "Soft Drinks", daily_limit: 5 });
  h.slot = await h.rpc("admin", "slot_save", { label: "Slot 1", start_time: "13:00", end_time: "14:00", capacity: 30 });
  h.slot2 = await h.rpc("admin", "slot_save", { label: "Slot 2", start_time: "14:00", end_time: "15:00", capacity: 2 });
  await h.rpc("picker1", "picker_set_status", "available");
  h.credit = (user, amount) => h.asPostgres("select wallet_credit($1, $2, 'refund', null, $3)", [h.users[user], amount, "test-credit-" + Math.random()]);
  h.pid = async (barcode) => (await h.asPostgres("select id from products where barcode=$1", [barcode])).rows[0].id;
  h.stock = async (barcode) => (await h.asPostgres("select stock_qty from products where barcode=$1", [barcode])).rows[0].stock_qty;
  h.order = async (id) => (await h.asPostgres("select * from orders where id=$1", [id])).rows[0];
  h.cola = await h.pid("111"); h.chips = await h.pid("222"); h.water = await h.pid("333");
  return h;
}

export const key = () => `key-${Date.now()}-${++seq}`;

export async function placeOrder(h, user, items, { slot, k, wallet = true } = {}) {
  return h.rpc(user, "create_order", items, slot ?? h.slot, k ?? key(), wallet);
}

// Simulates the provider's verified "payment succeeded" callback (Edge Function does the HMAC check)
export async function payOrder(h, user, orderId, purpose = "order", eventKey) {
  const prep = await h.rpc(user, "payment_prepare", orderId, purpose);
  const res = await h.asService("select payment_process_event($1,$2::jsonb,'payment',$3,$4,$5,'EGP',true,false) as r",
    [eventKey ?? `evt-${prep.payment_id}`, JSON.stringify({ test: true }), prep.payment_id, `txn-${prep.payment_id}`, prep.amount_piastres]);
  return { prep, result: res.rows[0].r };
}

export async function orderOk(h, user, items, opts) {
  const o = await placeOrder(h, user, items, opts);
  if (o.card_due_piastres > 0) await payOrder(h, user, o.order_id);
  return o;
}

export { assert };
