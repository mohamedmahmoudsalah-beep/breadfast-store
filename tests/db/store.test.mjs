import { test } from "node:test";
import { seed, placeOrder, payOrder, orderOk, key, assert } from "./helpers.mjs";

test("registration: verified email, valid HRID, uniqueness, immutability", async () => {
  const h = await seed();
  await h.addUser("unverified", { confirmed: false });
  await h.rpcFails("unverified", "EMAIL_NOT_VERIFIED", "link_hrid", "H1");
  await h.addUser("late");
  assert.equal((await h.rpc("late", "link_hrid", "NOPE")).error, "HRID_INVALID");
  assert.equal((await h.rpc("late", "link_hrid", "H1")).error, "HRID_TAKEN");   // one HRID -> one account
  await h.rpcFails("emp1", "ALREADY_LINKED", "link_hrid", "H3");             // one account -> one HRID
  await assert.rejects(h.as("emp1", "update employees set hrid='H3' where user_id=$1", [h.users.emp1]), /permission denied/);
  await assert.rejects(h.asPostgres("insert into employees(user_id,hrid,full_name) values ($1,'H1','x')", [h.users.late]), /duplicate key|unique/);
  const me = await h.rpc("emp1", "my_access");
  assert.equal(me.hrid, "H1");
  assert.equal((await h.asPostgres("select user_id from employee_hrid_registry where hrid='H1'")).rows[0].user_id, h.users.emp1);
});

test("HRID linking is rate limited", async () => {
  const h = await seed();
  await h.addUser("brute");
  for (let i = 0; i < 10; i++) assert.equal((await h.rpc("brute", "link_hrid", "X" + i)).error, "HRID_INVALID");
  await h.rpcFails("brute", "RATE_LIMITED", "link_hrid", "X99");
});

test("additive import: adds to stock, keeps untouched products, protects empty fields", async () => {
  const h = await seed();
  assert.equal(await h.stock("111"), 100);
  const b2 = await h.rpc("admin", "import_stage", "day2.csv", [
    { barcode: "111", name: "", category: "", price: "", qty: "50", image_url: "" },
    { barcode: "444", name: "Juice", category: "Drinks", price: "12", qty: "7" }]);
  assert.equal(b2.new_count, 1); assert.equal(b2.update_count, 1);
  await h.rpc("admin", "import_confirm", b2.batch_id, false);
  assert.equal(await h.stock("111"), 150);                                   // 100 + 50, NOT replaced
  assert.equal(await h.stock("222"), 20);                                    // missing from file => unchanged
  assert.equal(await h.stock("444"), 7);
  const p = (await h.asPostgres("select name, price_piastres from products where barcode='111'")).rows[0];
  assert.equal(p.name, "Cola"); assert.equal(p.price_piastres, 1000);       // empty name/price did not erase
  const mv = (await h.asPostgres("select qty_before, qty_delta, qty_after, actor_id from stock_movements where product_id=$1 and batch_id=$2", [h.cola, b2.batch_id])).rows[0];
  assert.deepEqual([mv.qty_before, mv.qty_delta, mv.qty_after], [100, 50, 150]);
  assert.equal(mv.actor_id, h.users.admin);
  // an in-stock product that never appears in files stays available
  assert.equal((await h.asPostgres("select is_active from products where barcode='222'")).rows[0].is_active, true);
});

test("import validation, duplicate batch protection, no double confirm", async () => {
  const h = await seed();
  const bad = await h.rpc("admin", "import_stage", "bad.xlsx", [
    { barcode: "900", name: "A", price: "1", qty: "1" }, { barcode: "900", name: "B", price: "2", qty: "2" },
    { barcode: "901", name: "", price: "", qty: "3" }, { barcode: "", name: "x", price: "1", qty: "1" }]);
  assert.equal(bad.invalid_count, 4);
  await h.rpcFails("admin", "BATCH_HAS_INVALID_ROWS", "import_confirm", bad.batch_id, false);

  const rows = [{ barcode: "111", qty: "5" }];
  const a = await h.rpc("admin", "import_stage", "same.xlsx", rows);
  await h.rpc("admin", "import_confirm", a.batch_id, false);
  await h.rpcFails("admin", "BATCH_NOT_PENDING", "import_confirm", a.batch_id, false);   // refresh / double click
  assert.equal(await h.stock("111"), 105);
  const again = await h.rpc("admin", "import_stage", "same-again.xlsx", rows);
  assert.ok(again.duplicate_of, "duplicate warning expected");
  await h.rpcFails("admin", "DUPLICATE_BATCH", "import_confirm", again.batch_id, false);
  assert.equal(await h.stock("111"), 105);
  await h.rpc("admin", "import_confirm", again.batch_id, true);                           // intentional repeat delivery
  assert.equal(await h.stock("111"), 110);
});

test("stock adjustment needs permission + reason, is logged, never negative", async () => {
  const h = await seed();
  await h.rpcFails("emp1", "FORBIDDEN", "stock_adjust", h.cola, 1, "oops");
  await h.rpcFails("admin", "REASON_REQUIRED", "stock_adjust", h.cola, 90, "");
  await h.rpc("admin", "stock_adjust", h.cola, 90, "recount");
  assert.equal(await h.stock("111"), 90);
  await h.rpcFails("admin", "INVALID_INPUT", "stock_adjust", h.cola, -5, "bad");
  const log = (await h.asPostgres("select count(*)::int c from audit_logs where action='stock_adjustment'")).rows[0].c;
  assert.equal(log, 1);
});

test("order totals: subtotal + EGP 10 bag + 1% fee, all integer maths", async () => {
  const h = await seed();
  const o = await placeOrder(h, "emp1", [{ product_id: h.chips, qty: 2 }]);       // 2 x 25.50 = 5100
  const row = await h.order(o.order_id);
  assert.equal(row.subtotal_piastres, 5100); assert.equal(row.bag_initial_piastres, 1000);
  assert.equal(row.fee_piastres, 51); assert.equal(row.total_piastres, 6151);
  assert.equal(row.status, "pending_payment");
  assert.equal(await h.stock("222"), 18);                                          // reserved immediately
});

test("25 rapid confirm clicks create exactly ONE order", async () => {
  const h = await seed();
  const k = key();
  const results = [];
  for (let i = 0; i < 25; i++) results.push(await placeOrder(h, "emp1", [{ product_id: h.cola, qty: 3 }], { k }));
  assert.equal(new Set(results.map((r) => r.order_id)).size, 1);
  assert.equal(results.filter((r) => r.replay).length, 24);
  assert.equal((await h.asPostgres("select count(*)::int c from orders")).rows[0].c, 1);
  assert.equal(await h.stock("111"), 97);                                          // stock reserved once
});

test("a different key while an unpaid order exists is refused (second tab / refresh)", async () => {
  const h = await seed();
  await placeOrder(h, "emp1", [{ product_id: h.cola, qty: 1 }]);
  await h.rpcFails("emp1", "PENDING_ORDER_EXISTS", "create_order", [{ product_id: h.cola, qty: 1 }], h.slot, key(), true);
});

test("stock: insufficient stock rejected, stock never negative", async () => {
  const h = await seed();
  await h.rpcFails("emp1", "INSUFFICIENT_STOCK", "create_order", [{ product_id: h.water, qty: 11 }], h.slot, key(), true);
  await orderOk(h, "emp1", [{ product_id: h.water, qty: 3 }]);                     // water limit is 5 (Soft Drinks)
  const o = await orderOk(h, "emp2", [{ product_id: h.water, qty: 5 }]);
  assert.ok(o.order_id);
  await h.rpcFails("emp3", "INSUFFICIENT_STOCK", "create_order", [{ product_id: h.water, qty: 3 }], h.slot, key(), true);
  assert.equal(await h.stock("333"), 2);
  await assert.rejects(h.asPostgres("update products set stock_qty = -1 where barcode='333'"), /check constraint/);
});

test("category daily limit is shared by ALL orders of the day and released on cancel", async () => {
  const h = await seed();                                                           // Soft Drinks limit = 5 per employee
  const a = await orderOk(h, "emp1", [{ product_id: h.cola, qty: 4 }]);
  await h.rpcFails("emp1", "CATEGORY_LIMIT_EXCEEDED", "create_order", [{ product_id: h.water, qty: 2 }], h.slot, key(), true);
  const u = (await h.as("emp1", "select * from my_category_usage()")).rows[0];
  assert.equal(u.used, 4); assert.equal(u.max_qty, 5);
  await orderOk(h, "emp1", [{ product_id: h.water, qty: 1 }]);                      // exactly one more is fine
  await h.rpcFails("emp1", "CATEGORY_LIMIT_EXCEEDED", "create_order", [{ product_id: h.cola, qty: 1 }], h.slot, key(), true);
  await h.rpc("emp1", "cancel_order", a.order_id, false);                           // releases 4
  await orderOk(h, "emp1", [{ product_id: h.cola, qty: 4 }]);
  // other employees are unaffected
  await orderOk(h, "emp2", [{ product_id: h.cola, qty: 5 }]);
});

test("time slots: capacity, past slots, disabled days", async () => {
  const h = await seed();                                                           // Slot 2 capacity = 2
  await orderOk(h, "emp1", [{ product_id: h.chips, qty: 1 }], { slot: h.slot2 });
  await orderOk(h, "emp2", [{ product_id: h.chips, qty: 1 }], { slot: h.slot2 });
  await h.rpcFails("emp3", "SLOT_FULL", "create_order", [{ product_id: h.chips, qty: 1 }], h.slot2, key(), true);
  const slots = (await h.as("emp3", "select * from available_slots()")).rows;
  assert.equal(slots.find((s) => s.label === "Slot 2").can_book, false);
  await h.setNow("2026-11-09T11:30:00Z");                                           // 13:30 Cairo: Slot 1 (13:00) is in the past
  await h.rpcFails("emp3", "SLOT_UNAVAILABLE", "create_order", [{ product_id: h.chips, qty: 1 }], h.slot, key(), true);
  assert.equal((await h.as("emp3", "select * from available_slots()")).rows.find((s) => s.label === "Slot 1"), undefined);
  await h.setNow("2026-11-10T07:00:00Z");                                           // Tuesday = disabled
  await h.rpcFails("emp3", "STORE_CLOSED", "create_order", [{ product_id: h.chips, qty: 1 }], h.slot, key(), true);
  await h.rpc("admin", "operating_day_set", 2, true);
  const ok = await placeOrder(h, "emp3", [{ product_id: h.chips, qty: 1 }]);
  assert.ok(ok.order_id);
});

test("unpaid orders expire and release stock, category quota, slot and wallet", async () => {
  const h = await seed();
  await h.rpc("admin", "admin_wallet_adjust", h.users.emp1, 2000, "gift");
  const o = await placeOrder(h, "emp1", [{ product_id: h.cola, qty: 5 }]);
  assert.equal(await h.stock("111"), 95);
  assert.equal(o.wallet_applied_piastres, 2000);
  await h.setNow("2026-11-09T07:20:00Z");                                           // > 15 min later
  const jobs = await h.asPostgres("select run_scheduled_jobs() r");
  assert.equal(jobs.rows[0].r.expired, 1);
  assert.equal(await h.stock("111"), 100);
  assert.equal((await h.order(o.order_id)).status, "expired");
  const w = (await h.asPostgres("select balance_piastres b from wallets where user_id=$1", [h.users.emp1])).rows[0].b;
  assert.equal(Number(w), 2000);                                                    // wallet restored
  assert.equal((await h.asPostgres("select status from slot_reservations where order_id=$1", [o.order_id])).rows[0].status, "released");
  await orderOk(h, "emp1", [{ product_id: h.cola, qty: 5 }]);                       // quota free again
});

test("payments: success confirms, duplicate webhook is idempotent, bad amount / failure do not confirm", async () => {
  const h = await seed();
  const o = await placeOrder(h, "emp1", [{ product_id: h.cola, qty: 1 }]);
  const prep = await h.rpc("emp1", "payment_prepare", o.order_id, "order");
  const call = (evt, amount, success = true, pending = false) => h.asService(
    "select payment_process_event($1,'{}'::jsonb,'payment',$2,$3,$4,'EGP',$5,$6) r", [evt, prep.payment_id, "t1", amount, success, pending]);
  assert.equal((await call("e0", 1, false)).rows[0].r, "payment_failed");                     // failed card
  assert.equal((await h.order(o.order_id)).status, "pending_payment");                       // retry still possible
  assert.equal((await call("e1", prep.amount_piastres - 1)).rows[0].r, "amount_mismatch");
  assert.equal((await h.order(o.order_id)).status, "pending_payment");
  const p2 = await h.rpc("emp1", "payment_prepare", o.order_id, "order");                    // retry = new attempt
  const ok = () => h.asService("select payment_process_event('e2','{}'::jsonb,'payment',$1,'t2',$2,'EGP',true,false) r", [p2.payment_id, p2.amount_piastres]);
  assert.equal((await ok()).rows[0].r, "order_paid");
  assert.equal((await ok()).rows[0].r, "duplicate_event");                                    // same webhook twice
  assert.equal((await h.order(o.order_id)).status, "assigned");                               // auto-assigned to picker1
  await h.rpcFails("emp1", "ORDER_NOT_PAYABLE", "payment_prepare", o.order_id, "order");
  // a second successful payment for the same order never double-charges: refund queued
  const stray = (await h.asPostgres("select id, amount_piastres from payments where id=$1", [prep.payment_id])).rows[0];
  const r = await h.asService("select payment_process_event('e3','{}'::jsonb,'payment',$1,'t3',$2,'EGP',true,false) r", [stray.id, stray.amount_piastres]);
  assert.equal(r.rows[0].r, "refund_queued");
  const ref = (await h.asPostgres("select method,status,kind,amount_piastres from refunds where order_id=$1", [o.order_id])).rows;
  assert.equal(ref.length, 1); assert.equal(ref[0].kind, "duplicate_payment");
});

test("late payment after expiry is refunded, order is not revived", async () => {
  const h = await seed();
  const o = await placeOrder(h, "emp1", [{ product_id: h.cola, qty: 1 }]);
  const prep = await h.rpc("emp1", "payment_prepare", o.order_id, "order");
  await h.setNow("2026-11-09T07:30:00Z"); await h.asPostgres("select run_scheduled_jobs()");
  const r = await h.asService("select payment_process_event('late','{}'::jsonb,'payment',$1,'tl',$2,'EGP',true,false) r", [prep.payment_id, prep.amount_piastres]);
  assert.equal(r.rows[0].r, "refund_queued");
  assert.equal((await h.order(o.order_id)).status, "expired");
});

test("cancellation: allowed until preparation starts; releases everything and creates a card refund", async () => {
  const h = await seed();
  const o = await orderOk(h, "emp1", [{ product_id: h.chips, qty: 2 }]);
  assert.equal(await h.stock("222"), 18);
  const c = await h.rpc("emp1", "cancel_order", o.order_id, false);
  assert.equal(c.status, "canceled");
  assert.equal(await h.stock("222"), 20);
  const ref = (await h.asPostgres("select method,status,amount_piastres,kind from refunds where order_id=$1", [o.order_id])).rows;
  assert.deepEqual(ref.map((x) => [x.method, x.status, x.amount_piastres]), [["card", "pending", 6151]]);
  await h.rpcFails("emp1", "CANCEL_NOT_ALLOWED", "cancel_order", o.order_id, false);

  const o2 = await orderOk(h, "emp1", [{ product_id: h.chips, qty: 1 }]);
  await h.rpc("picker1", "picker_start_order", o2.order_id);
  await h.rpcFails("emp1", "CANCEL_NOT_ALLOWED", "cancel_order", o2.order_id, false);     // preparation has started
  await h.rpc("admin", "admin_cancel_order", o2.order_id, "manager exception", true);     // admin exception, to wallet
  assert.equal((await h.order(o2.order_id)).status, "canceled");
});

test("cancellation can refund to the wallet instead of the card", async () => {
  const h = await seed();
  const o = await orderOk(h, "emp1", [{ product_id: h.chips, qty: 1 }]);
  await h.rpc("emp1", "cancel_order", o.order_id, true);
  const w = (await h.asPostgres("select balance_piastres b from wallets where user_id=$1", [h.users.emp1])).rows[0].b;
  assert.equal(Number(w), 2550 + 1000 + 26);                                               // subtotal + bag + 1% fee (rounded)
  assert.equal((await h.asPostgres("select count(*)::int c from refunds where order_id=$1 and method='card'", [o.order_id])).rows[0].c, 0);
});

test("ten-minute reassignment: only until preparation starts", async () => {
  const h = await seed();
  await h.rpc("picker2", "picker_set_status", "available");
  const o = await orderOk(h, "emp1", [{ product_id: h.cola, qty: 1 }]);
  const first = (await h.order(o.order_id)).picker_id;
  assert.ok(first);
  await h.setNow("2026-11-09T07:09:00Z"); await h.asPostgres("select run_scheduled_jobs()");
  assert.equal((await h.order(o.order_id)).picker_id, first);                              // not yet 10 min
  await h.setNow("2026-11-09T07:11:00Z"); await h.asPostgres("select run_scheduled_jobs()");
  const second = (await h.order(o.order_id)).picker_id;
  assert.notEqual(second, first);                                                          // moved to the other picker
  assert.equal((await h.order(o.order_id)).status, "assigned");
  // the new picker starts a product => rule stops applying
  await h.rpc(second === h.users.picker1 ? "picker1" : "picker2", "picker_scan", o.order_id, "111");
  await h.setNow("2026-11-09T08:00:00Z"); await h.asPostgres("select run_scheduled_jobs()");
  const o2 = await h.order(o.order_id);
  assert.equal(o2.picker_id, second); assert.equal(o2.status, "preparing");
  const hist = (await h.asPostgres("select end_reason from order_assignments where order_id=$1 order by assigned_at", [o.order_id])).rows;
  assert.equal(hist[0].end_reason, "reassigned_timeout");
});

test("waiting queue: no picker available => queue, then assigned when one comes online", async () => {
  const h = await seed();
  await h.rpc("picker1", "picker_set_status", "offline");
  const o = await orderOk(h, "emp1", [{ product_id: h.cola, qty: 1 }]);
  assert.equal((await h.order(o.order_id)).status, "waiting_picker");
  await h.rpc("picker2", "picker_set_status", "available");
  assert.equal((await h.order(o.order_id)).status, "assigned");
  assert.equal((await h.order(o.order_id)).picker_id, h.users.picker2);
});

test("load-aware distribution is balanced between pickers", async () => {
  const h = await seed();
  await h.rpc("picker2", "picker_set_status", "available");
  const counts = {};
  for (const u of ["emp1", "emp2", "emp3"]) { const o = await orderOk(h, u, [{ product_id: h.cola, qty: 1 }]); const p = (await h.order(o.order_id)).picker_id; counts[p] = (counts[p] ?? 0) + 1; }
  const v = Object.values(counts).sort();
  assert.deepEqual(v, [1, 2]);
});

test("full flow with partial out-of-stock, bag difference credit, pickup and collection", async () => {
  const h = await seed();
  const o = await orderOk(h, "emp1", [{ product_id: h.chips, qty: 2 }, { product_id: h.cola, qty: 3 }]);   // 5100 + 3000 = 8100
  const row0 = await h.order(o.order_id);
  assert.equal(row0.subtotal_piastres, 8100); assert.equal(row0.fee_piastres, 81); assert.equal(row0.total_piastres, 9181);
  await h.rpc("picker1", "picker_start_order", o.order_id);
  await h.rpcFails("emp1", "FORBIDDEN", "picker_scan", o.order_id, "111");
  await h.rpcFails("picker2", "NOT_ASSIGNED_TO_YOU", "picker_scan", o.order_id, "111");
  await h.rpcFails("picker1", "ITEM_NOT_IN_ORDER", "picker_scan", o.order_id, "999");
  const items = (await h.asPostgres("select id, barcode from order_items where order_id=$1", [o.order_id])).rows;
  const chips = items.find((i) => i.barcode === "222");
  for (let i = 0; i < 3; i++) await h.rpc("picker1", "picker_scan", o.order_id, "111");
  await h.rpcFails("picker1", "ITEM_ALREADY_DONE", "picker_scan", o.order_id, "111");
  await h.rpcFails("picker1", "ITEMS_NOT_FINISHED", "picker_complete_order", o.order_id, 1, 0);
  await h.rpc("picker1", "picker_set_item", o.order_id, chips.id, 1, 1);                  // 1 prepared, 1 OUT OF STOCK
  await h.rpcFails("picker1", "BAGS_REQUIRED", "picker_complete_order", o.order_id, null, 0);
  const done = await h.rpc("picker1", "picker_complete_order", o.order_id, 1, 0);          // 1 small bag = 3.00 < 10.00
  assert.equal(done.status, "ready_handover");
  const r = await h.order(o.order_id);
  assert.equal(r.prepared_subtotal_piastres, 2550 + 3000);
  assert.equal(r.final_fee_piastres, 56);                                                  // 1% of 5550 = 55.5 -> 56 (half up)
  assert.equal(r.bag_actual_piastres, 300);
  assert.equal(r.final_total_piastres, 5550 + 300 + 56);
  assert.equal(r.is_partial, true);
  // product refund (unavailable chips + fee difference) goes back to the card; bag difference to the wallet
  const refunds = (await h.asPostgres("select method, amount_piastres from refunds where order_id=$1", [o.order_id])).rows;
  assert.deepEqual(refunds.map((x) => [x.method, x.amount_piastres]), [["card", 2550 + (81 - 56)]]);
  const bag = (await h.asPostgres("select amount_piastres a, direction d, order_id from wallet_transactions where reason='bag_difference'")).rows[0];
  assert.deepEqual([bag.a, bag.d, bag.order_id], [700, "credit", o.order_id]);
  // money reconciles: paid = final total + card refund + wallet credit
  assert.equal(r.total_piastres, r.final_total_piastres + 2575 + 700);
  // category quota of the missing unit was released (cola 3 + chips 0 counted only for Soft Drinks)
  // pickup
  await h.rpcFails("pickup1", "NOT_READY", "pickup_collect", String(r.order_no));
  await h.rpcFails("emp1", "FORBIDDEN", "pickup_receive", o.order_id);
  const rec = await h.rpc("pickup1", "pickup_receive", o.order_id);
  assert.equal(rec.status, "ready_collection");
  const look = await h.rpc("pickup1", "pickup_lookup", r.pickup_code);
  assert.equal(look.order_no, Number(r.order_no));
  await h.rpc("pickup1", "pickup_collect", r.pickup_code);
  await h.rpcFails("pickup1", "ALREADY_COLLECTED", "pickup_collect", String(r.order_no));
  const hist = (await h.asPostgres("select to_status from order_status_history where order_id=$1 order by id", [o.order_id])).rows.map((x) => x.to_status);
  assert.deepEqual(hist, ["pending_payment", "confirmed", "waiting_picker", "assigned", "preparing", "ready_handover", "received_pickup", "ready_collection", "collected"]);
  const notes = (await h.asPostgres("select type from notifications where user_id=$1", [h.users.emp1])).rows.map((x) => x.type);
  for (const t of ["order_confirmed", "payment_received", "order_assigned", "preparation_started", "product_unavailable", "order_partial", "refund_initiated", "wallet_credited", "received_pickup", "order_ready", "order_collected"])
    assert.ok(notes.includes(t), "missing notification " + t);
});

test("bag cost above EUR 10: wallet first, remainder must be paid before collection", async () => {
  const h = await seed();
  await h.rpc("admin", "bag_price_set", "large", 1500);
  const o = await orderOk(h, "emp1", [{ product_id: h.cola, qty: 1 }]);
  await h.rpc("picker1", "picker_scan", o.order_id, "111");
  const done = await h.rpc("picker1", "picker_complete_order", o.order_id, 0, 1);          // 15.00 bag vs 10.00 collected => 5.00 due
  assert.equal(done.extra_due_piastres, 500);
  const rec = await h.rpc("pickup1", "pickup_receive", o.order_id);
  assert.equal(rec.status, "received_pickup");                                              // NOT ready for collection yet
  await h.rpcFails("pickup1", "EXTRA_PAYMENT_DUE", "pickup_collect", (await h.order(o.order_id)).pickup_code);
  await payOrder(h, "emp1", o.order_id, "extra");
  assert.equal((await h.order(o.order_id)).status, "ready_collection");
  await h.rpc("pickup1", "pickup_collect", (await h.order(o.order_id)).pickup_code);

  // with wallet credit available it is used first, no card needed
  await h.rpc("admin", "admin_wallet_adjust", h.users.emp2, 700, "credit");
  const o2 = await orderOk(h, "emp2", [{ product_id: h.cola, qty: 1 }], { wallet: false });
  await h.rpc("picker1", "picker_scan", o2.order_id, "111");
  const d2 = await h.rpc("picker1", "picker_complete_order", o2.order_id, 0, 1);
  assert.equal(d2.extra_due_piastres, 0);
  const w = (await h.asPostgres("select balance_piastres b from wallets where user_id=$1", [h.users.emp2])).rows[0].b;
  assert.equal(Number(w), 200);
});

test("all items unavailable cancels the order with a full refund", async () => {
  const h = await seed();
  const o = await orderOk(h, "emp1", [{ product_id: h.chips, qty: 1 }]);
  const it = (await h.asPostgres("select id from order_items where order_id=$1", [o.order_id])).rows[0];
  await h.rpc("picker1", "picker_set_item", o.order_id, it.id, 0, 1);
  const d = await h.rpc("picker1", "picker_complete_order", o.order_id, 0, 0);
  assert.equal(d.status, "canceled");
  const sum = (await h.asPostgres("select sum(amount_piastres)::int s from refunds where order_id=$1", [o.order_id])).rows[0].s;
  assert.equal(sum, (await h.order(o.order_id)).total_piastres);
});

test("wallet: immutable ledger, no direct balance edits, no overdraft, idempotent credits", async () => {
  const h = await seed();
  await h.rpc("admin", "admin_wallet_adjust", h.users.emp1, 500, "bonus");
  await assert.rejects(h.asPostgres("update wallets set balance_piastres = 999999 where user_id=$1", [h.users.emp1]), /WALLET_DIRECT_CHANGE_FORBIDDEN/);
  await assert.rejects(h.asPostgres("update wallet_transactions set amount_piastres = 1"), /IMMUTABLE/);
  await assert.rejects(h.asPostgres("delete from wallet_transactions"), /IMMUTABLE/);
  await assert.rejects(h.as("emp1", "insert into wallet_transactions(user_id,direction,amount_piastres,reason) values ($1,'credit',100000,'x')", [h.users.emp1]), /permission denied/);
  await h.rpcFails("admin", "INSUFFICIENT_WALLET", "admin_wallet_adjust", h.users.emp1, -600, "too much");
  await h.asPostgres("select wallet_credit($1, 100, 'refund', null, 'same-key')", [h.users.emp1]);
  await h.asPostgres("select wallet_credit($1, 100, 'refund', null, 'same-key')", [h.users.emp1]);   // duplicate ignored
  const w = (await h.asPostgres("select balance_piastres b from wallets where user_id=$1", [h.users.emp1])).rows[0].b;
  assert.equal(Number(w), 600);
  assert.equal((await h.asPostgres("select count(*)::int c from wallet_reconcile()")).rows[0].c, 0);
});

test("permissions and RLS: each role sees only what it must", async () => {
  const h = await seed();
  const o1 = await orderOk(h, "emp1", [{ product_id: h.cola, qty: 1 }]);
  const o2 = await orderOk(h, "emp2", [{ product_id: h.cola, qty: 1 }]);
  assert.equal((await h.as("emp1", "select id from orders")).rows.length, 1);
  assert.equal((await h.as("emp2", "select id from orders where id=$1", [o1.order_id])).rows.length, 0);
  assert.equal((await h.as("emp1", "select id from order_items")).rows.length, 1);
  assert.equal((await h.as("emp1", "select user_id from wallets")).rows.length, 0);
  assert.equal((await h.as("stranger", "select id from orders")).rows.length, 0);
  assert.equal((await h.as("admin", "select id from orders")).rows.length, 2);
  // pickers only see their own assigned orders
  const mine = (await h.as("picker1", "select id from orders")).rows.length;
  assert.equal(mine, 2); assert.equal((await h.as("picker2", "select id from orders")).rows.length, 0);
  // payment raw payload is hidden from everyone but the service role
  await assert.rejects(h.as("emp1", "select raw from payments"), /permission denied/);
  assert.ok((await h.as("emp1", "select id, status from payments")).rows.length >= 1);
  // writes are only possible through RPCs
  await assert.rejects(h.as("emp1", "update products set price_piastres = 1"), /permission denied/);
  await assert.rejects(h.as("admin", "insert into products(barcode,name) values ('x','y')"), /permission denied/);
  await assert.rejects(h.as("emp1", "delete from audit_logs"), /permission denied/);
  await h.rpcFails("emp1", "FORBIDDEN", "import_stage", "x", [{ barcode: "1" }]);
  await h.rpcFails("emp1", "FORBIDDEN", "dashboard_stats");
  await h.rpcFails("emp1", "FORBIDDEN", "report_sales", "2026-11-09", "2026-11-09");
  await h.rpcFails("emp1", "FORBIDDEN", "admin_wallet_adjust", h.users.emp1, 100000, "free money");
  await h.rpcFails("emp1", "FORBIDDEN", "setting_set", "fee_bp", "0");
  // an admin only gets what the super admin grants
  await h.addUser("limited"); await h.grantRole("limited", "admin");
  await h.rpcFails("limited", "FORBIDDEN", "stock_adjust", h.cola, 5, "no");
  await h.grantPerm("limited", "stock.adjust");
  await h.rpc("limited", "stock_adjust", h.cola, 5, "now allowed");
  // deactivated accounts are locked out everywhere
  await h.rpc("admin", "admin_set_user_active", h.users.emp2, false);
  await h.rpcFails("emp2", "ACCOUNT_DISABLED", "create_order", [{ product_id: h.cola, qty: 1 }], h.slot, key(), true);
  assert.ok(o2.order_id);
});

test("audit log records sensitive changes and cannot be edited", async () => {
  const h = await seed();
  await h.rpc("admin", "setting_set", "fee_bp", 150);
  await h.rpc("admin", "bag_price_set", "small", 400);
  await h.rpc("admin", "slot_save", { id: h.slot, label: "Slot 1", start_time: "13:00", end_time: "14:00", capacity: 40 });
  const acts = (await h.asPostgres("select entity_type from audit_logs")).rows.map((r) => r.entity_type);
  for (const t of ["app_settings", "bag_pricing", "time_slots", "products", "stock_import_batches", "employees"]) assert.ok(acts.includes(t), "audit missing " + t);
  const s = (await h.asPostgres("select actor_id, before, after from audit_logs where entity_type='app_settings' order by id desc limit 1")).rows[0];
  assert.equal(s.actor_id, h.users.admin);
  await assert.rejects(h.asPostgres("update audit_logs set action='x'"), /IMMUTABLE/);
  await assert.rejects(h.asPostgres("delete from audit_logs"), /IMMUTABLE/);
});

test("reports reconcile with orders, refunds and the dashboard", async () => {
  const h = await seed();
  const a = await orderOk(h, "emp1", [{ product_id: h.chips, qty: 2 }, { product_id: h.cola, qty: 3 }]);
  const items = (await h.asPostgres("select id, barcode from order_items where order_id=$1", [a.order_id])).rows;
  for (let i = 0; i < 3; i++) await h.rpc("picker1", "picker_scan", a.order_id, "111");
  await h.rpc("picker1", "picker_set_item", a.order_id, items.find((x) => x.barcode === "222").id, 1, 1);
  await h.rpc("picker1", "picker_complete_order", a.order_id, 1, 0);
  const b = await orderOk(h, "emp2", [{ product_id: h.cola, qty: 2 }]);
  const c = await orderOk(h, "emp3", [{ product_id: h.chips, qty: 1 }]);
  await h.rpc("emp3", "cancel_order", c.order_id, false);                                  // cancelled => not a sale
  await placeOrder(h, "stranger", [{ product_id: h.cola, qty: 1 }]).catch(() => null);   // unlinked user can't order
  const rep = await h.rpc("admin", "report_sales", "2026-11-09", "2026-11-09");
  assert.equal(rep.orders_summary.length, 3);                                              // paid orders only (incl. cancelled-after-paid)
  assert.equal(rep.order_items.length, 4);
  const s = rep.sales_summary;
  assert.equal(s.paid_orders, 3); assert.equal(s.canceled_orders, 1); assert.equal(s.partial_orders, 1);
  const sumFinal = rep.orders_summary.filter((o) => o.order_status !== "canceled").reduce((t, o) => t + o.final_total, 0);
  assert.equal(Math.round(s.net_sales * 100), Math.round(sumFinal * 100));
  assert.equal(Math.round((s.gross_product_sales + s.bag_charges + s.payment_fees - s.refunds) * 100), Math.round(s.net_sales * 100));
  const dash = await h.rpc("admin", "dashboard_stats", "2026-11-09", "2026-11-09");
  assert.equal(dash.sales_piastres, Math.round(s.net_sales * 100));
  assert.equal(dash.net_sales_piastres, dash.sales_piastres);                              // cash view == order view
  assert.ok(rep.product_performance.find((p) => p.barcode === "111").total_quantity_sold === 5);
  // historical prices stay: changing the price later does not change past orders
  await h.rpc("admin", "product_save", { id: h.cola, name: "Cola", price_piastres: 9999, is_active: true });
  const again = await h.rpc("admin", "report_sales", "2026-11-09", "2026-11-09");
  assert.deepEqual(again.sales_summary.net_sales, s.net_sales);
  assert.ok(b.order_id);
});

test("online users counter: distinct users, expires without heartbeat", async () => {
  const h = await seed();
  await h.rpc("emp1", "heartbeat"); await h.rpc("emp1", "heartbeat"); await h.rpc("emp2", "heartbeat");
  assert.equal((await h.rpc("admin", "online_users", false)).count, 2);
  await h.asPostgres("update presence_heartbeats set last_seen = now() - interval '5 minutes' where user_id=$1", [h.users.emp2]);
  assert.equal((await h.rpc("admin", "online_users", true)).count, 1);
});

test("operating-day and slot admin screens validate input", async () => {
  const h = await seed();
  await h.rpcFails("emp1", "FORBIDDEN", "operating_day_set", 3, true);
  await h.rpcFails("admin", "SLOT_BEFORE_BUSINESS_DAY_START", "slot_save", { label: "Early", start_time: "06:00", end_time: "07:00", capacity: 5 });
  await h.rpcFails("admin", "INVALID_INPUT", "slot_save", { label: "Bad", start_time: "15:00", end_time: "14:00", capacity: 5 });
  await h.rpcFails("admin", "INVALID_INPUT", "setting_set", "fee_bp", '"abc"');
});
