import { test } from "node:test";
import { seed, orderOk, placeOrder, payOrder, assert } from "./helpers.mjs";

test("card refund worker: claim -> complete notifies the employee; failure -> retry; manual completion", async () => {
  const h = await seed();
  const o = await orderOk(h, "emp1", [{ product_id: h.chips, qty: 2 }]);
  await h.rpc("emp1", "cancel_order", o.order_id, false);                      // card refund created as 'pending'
  const claimed = (await h.asService("select * from refund_claim_pending(10)")).rows;
  assert.equal(claimed.length, 1);
  assert.equal(claimed[0].amount_piastres, 6151);
  assert.ok(claimed[0].provider_txn_id.startsWith("txn-"));
  assert.equal((await h.asService("select * from refund_claim_pending(10)")).rows.length, 0);   // not claimed twice
  await h.asService("select refund_fail($1, 'gateway said no')", [claimed[0].refund_id]);
  await h.rpcFails("emp1", "FORBIDDEN", "refund_retry", claimed[0].refund_id);
  await h.rpc("admin", "refund_retry", claimed[0].refund_id);
  const again = (await h.asService("select * from refund_claim_pending(10)")).rows;
  assert.equal(again.length, 1);
  await h.asService("select refund_complete($1, 'prov-1')", [again[0].refund_id]);
  assert.equal((await h.asPostgres("select status from refunds where id=$1", [again[0].refund_id])).rows[0].status, "completed");
  const n = (await h.asPostgres("select type from notifications where user_id=$1 and type='refund_completed'", [h.users.emp1])).rows;
  assert.equal(n.length, 1);
  await h.asService("select refund_complete($1, 'prov-1')", [again[0].refund_id]);                // idempotent: no second notification
  assert.equal((await h.asPostgres("select count(*)::int c from notifications where type='refund_completed'")).rows[0].c, 1);

  const o2 = await orderOk(h, "emp2", [{ product_id: h.chips, qty: 1 }]);
  await h.rpc("emp2", "cancel_order", o2.order_id, false);
  const r = (await h.asPostgres("select id from refunds where order_id=$1", [o2.order_id])).rows[0];
  await h.rpcFails("admin", "REASON_REQUIRED", "refund_mark_manual", r.id, "");
  await h.rpc("admin", "refund_mark_manual", r.id, "refunded by hand in Paymob dashboard");
  assert.equal((await h.asPostgres("select status from refunds where id=$1", [r.id])).rows[0].status, "completed");
});

test("provider-only functions cannot be called by signed-in users", async () => {
  const h = await seed();
  const o = await placeOrder(h, "emp1", [{ product_id: h.cola, qty: 1 }]);
  const prep = await h.rpc("emp1", "payment_prepare", o.order_id, "order");
  await assert.rejects(h.as("emp1", "select payment_process_event('x','{}'::jsonb,'payment',$1,'t',100,'EGP',true,false)", [prep.payment_id]), /permission denied/);
  await assert.rejects(h.as("emp1", "select confirm_order_paid($1)", [o.order_id]), /permission denied/);
  await assert.rejects(h.as("emp1", "select wallet_credit($1, 99999, 'x', null, null)", [h.users.emp1]), /permission denied/);
  await assert.rejects(h.as("emp1", "select assign_waiting_orders()"), /permission denied/);
  await assert.rejects(h.as("emp1", "select run_scheduled_jobs()"), /permission denied/);
  await assert.rejects(h.as("emp1", "select bootstrap_super_admin('emp1@breadfast.test')"), /permission denied/);
  await assert.rejects(h.as("emp1", "select refund_claim_pending(5)"), /permission denied/);
  assert.equal((await h.order(o.order_id)).status, "pending_payment");
});

test("an employee can only start payment for their own order", async () => {
  const h = await seed();
  const o = await placeOrder(h, "emp1", [{ product_id: h.cola, qty: 1 }]);
  await h.rpcFails("emp2", "ORDER_NOT_FOUND", "payment_prepare", o.order_id, "order");
  await h.rpcFails("emp1", "ORDER_NOT_PAYABLE", "payment_prepare", o.order_id, "extra");
  await h.rpcFails("emp2", "ORDER_NOT_FOUND", "cancel_order", o.order_id, false);
});

test("wallet + card mixed payment: wallet part is refunded to the wallet, card part to the card", async () => {
  const h = await seed();
  await h.credit("emp1", 2000);
  const o = await placeOrder(h, "emp1", [{ product_id: h.chips, qty: 2 }]);          // total 6151
  assert.equal(o.wallet_applied_piastres, 2000); assert.equal(o.card_due_piastres, 4151);
  await payOrder(h, "emp1", o.order_id);
  await h.rpc("emp1", "cancel_order", o.order_id, false);
  const refunds = (await h.asPostgres("select method, amount_piastres from refunds where order_id=$1 order by method", [o.order_id])).rows;
  assert.deepEqual(refunds.map((r) => [r.method, r.amount_piastres]), [["card", 4151], ["wallet", 2000]]);
  assert.equal((await h.asPostgres("select count(*)::int c from wallet_reconcile()")).rows[0].c, 0);
});

test("fully wallet-paid order is confirmed instantly without a card", async () => {
  const h = await seed();
  await h.credit("emp1", 100000);
  const o = await placeOrder(h, "emp1", [{ product_id: h.cola, qty: 1 }]);
  assert.equal(o.card_due_piastres, 0);
  assert.equal((await h.order(o.order_id)).status, "assigned");
  await h.rpcFails("emp1", "ORDER_NOT_PAYABLE", "payment_prepare", o.order_id, "order");
});

test("admin can link an admin-created account to a HRID, once", async () => {
  const h = await seed();
  await h.rpc("admin", "hrid_import", [{ hrid: "H9", name: "Omar Fathy" }]);
  await h.addUser("created");
  await h.rpcFails("emp1", "FORBIDDEN", "admin_link_hrid", h.users.created, "H9");
  assert.equal((await h.rpc("admin", "admin_link_hrid", h.users.created, "H9")).ok, true);
  await h.rpcFails("admin", "ALREADY_LINKED", "admin_link_hrid", h.users.created, "H9");
  assert.equal((await h.rpc("created", "my_access")).hrid, "H9");
});

test("HRID import: updates names, never deletes, rejects bad rows", async () => {
  const h = await seed();
  const r = await h.rpc("admin", "hrid_import", [{ hrid: "h1", name: "Ahmed A. Ali" }, { hrid: "", name: "x" }, { hrid: "H77", name: "New Person" }]);
  assert.deepEqual([r.new, r.updated, r.invalid], [1, 1, 1]);
  assert.equal((await h.asPostgres("select full_name from employees where hrid='H1'")).rows[0].full_name, "Ahmed A. Ali");
  assert.equal((await h.asPostgres("select count(*)::int c from employee_hrid_registry")).rows[0].c, 4);
  await h.rpcFails("emp1", "FORBIDDEN", "hrid_import", [{ hrid: "Z", name: "Z" }]);
});

test("roles: only a super admin changes roles/permissions; last super admin cannot demote themselves", async () => {
  const h = await seed();
  await h.addUser("limited"); await h.grantRole("limited", "admin"); await h.grantPerm("limited", "users.manage");
  await h.rpcFails("limited", "FORBIDDEN", "admin_set_roles", h.users.emp1, "{super_admin}");
  await h.rpcFails("limited", "FORBIDDEN", "admin_set_permissions", h.users.emp1, "{audit.view}");
  await h.rpc("admin", "admin_set_roles", h.users.emp1, "{employee,picker}");
  assert.ok((await h.asPostgres("select 1 from pickers where user_id=$1", [h.users.emp1])).rows.length === 1);
  await h.rpcFails("admin", "CANNOT_MODIFY_SELF", "admin_set_roles", h.users.admin, "{employee}");
  await h.rpcFails("limited", "FORBIDDEN", "admin_set_user_active", h.users.admin, false);     // cannot lock out a super admin
});
