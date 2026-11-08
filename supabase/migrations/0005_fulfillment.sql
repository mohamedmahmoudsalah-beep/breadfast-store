-- =====================================================================
-- 0005_fulfillment.sql | Pickers, automatic assignment (load-aware round robin),
-- the 10-minute reassignment rule, preparation, bag reconciliation, pickup handover.
-- =====================================================================

create table pickers (
  user_id           uuid primary key references auth.users(id) on delete cascade,
  status            text not null default 'offline' check (status in ('available','busy','offline','paused')),
  last_assigned_at  timestamptz,
  status_changed_at timestamptz not null default now()
);

create table order_assignments (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders(id) on delete cascade,
  picker_id   uuid not null references auth.users(id),
  assigned_at timestamptz not null default now(),
  started_at  timestamptz,
  ended_at    timestamptz,
  end_reason  text check (end_reason in ('reassigned_timeout','manual','completed','canceled')),
  assigned_by uuid                                   -- null = automatic
);
create unique index one_active_assignment_per_order on order_assignments(order_id) where ended_at is null;
create index assignments_picker_idx on order_assignments(picker_id, assigned_at desc);

create table picker_activity (
  id         bigint generated always as identity primary key,
  picker_id  uuid not null,
  order_id   uuid,
  action     text not null,
  detail     jsonb,
  created_at timestamptz not null default now()
);
create index picker_activity_order_idx on picker_activity(order_id, created_at);

create or replace function picker_log(p_picker uuid, p_order uuid, p_action text, p_detail jsonb default null) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into picker_activity(picker_id, order_id, action, detail) values (p_picker, p_order, p_action, p_detail)
$$;
revoke all on function picker_log(uuid,uuid,text,jsonb) from public, anon, authenticated;

-- picker profile row follows the 'picker' role
create or replace function sync_picker_row() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' and new.role = 'picker' then
    insert into pickers(user_id) values (new.user_id) on conflict do nothing;
  elsif tg_op = 'DELETE' and old.role = 'picker' then
    update pickers set status = 'offline', status_changed_at = now() where user_id = old.user_id;
  end if;
  return coalesce(new, old);
end $$;
create trigger user_roles_picker after insert or delete on user_roles for each row execute function sync_picker_row();

create or replace function picker_active_count(p_picker uuid) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select count(*)::int from orders where picker_id = p_picker and status in ('assigned','preparing')
$$;

create or replace function refresh_picker_busy(p_picker uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_active int := picker_active_count(p_picker); v_max int := setting_int('picker_max_active_orders');
begin
  update pickers set status = case when v_active >= v_max then 'busy' else 'available' end, status_changed_at = now()
   where user_id = p_picker and status in ('available','busy')
     and status <> case when v_active >= v_max then 'busy' else 'available' end;
end $$;
revoke all on function refresh_picker_busy(uuid) from public, anon, authenticated;

create or replace function picker_set_status(p_status text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := require_active();
begin
  if not has_permission('picker.work') then raise exception 'FORBIDDEN'; end if;
  if p_status not in ('available','paused','offline') then raise exception 'INVALID_INPUT'; end if;
  insert into pickers(user_id) values (v_uid) on conflict do nothing;
  update pickers set status = p_status, status_changed_at = now() where user_id = v_uid;
  perform picker_log(v_uid, null, 'status:' || p_status);
  if p_status = 'available' then perform refresh_picker_busy(v_uid); perform assign_waiting_orders(); end if;
end $$;

-- ---------- automatic distribution ----------
-- Picks the available picker with the fewest active orders, ties broken by who was served longest ago.
-- A picker who already lost this order by timeout is only chosen again if nobody else is free.
create or replace function assign_waiting_orders() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_order record; v_picker uuid; n int := 0; v_max int := setting_int('picker_max_active_orders');
begin
  perform pg_advisory_xact_lock(7001);
  loop
    select id, user_id, order_no into v_order from orders where status = 'waiting_picker'
      order by paid_at, created_at limit 1 for update skip locked;
    exit when not found;
    select p.user_id into v_picker from pickers p
      join profiles pr on pr.id = p.user_id and pr.is_active
     where p.status = 'available' and picker_active_count(p.user_id) < v_max
     order by exists (select 1 from order_assignments a where a.order_id = v_order.id and a.picker_id = p.user_id),
              picker_active_count(p.user_id), coalesce(p.last_assigned_at, 'epoch'::timestamptz), p.user_id
     limit 1;
    exit when v_picker is null;
    insert into order_assignments(order_id, picker_id, assigned_at, assigned_by) values (v_order.id, v_picker, app_now(), null);
    update orders set status = 'assigned', picker_id = v_picker where id = v_order.id;
    perform order_log(v_order.id, 'waiting_picker', 'assigned', 'auto-assigned');
    update pickers set last_assigned_at = app_now() where user_id = v_picker;
    perform refresh_picker_busy(v_picker);
    perform picker_log(v_picker, v_order.id, 'assigned');
    perform notify(v_order.user_id, 'order_assigned', v_order.id, 'رقم الطلب ' || v_order.order_no);
    n := n + 1;
  end loop;
  return n;
end $$;

-- TEN-MINUTE RULE: no product started within N minutes => back to queue. Stops once preparation starts.
create or replace function reassign_stale_assignments() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n int := 0; v_min int := setting_int('reassign_minutes');
begin
  for r in select a.id as aid, a.order_id, a.picker_id from order_assignments a
           join orders o on o.id = a.order_id
           where a.ended_at is null and a.started_at is null and o.status = 'assigned'
             and a.assigned_at <= app_now() - make_interval(mins => v_min)
           order by a.assigned_at for update of a skip locked loop
    update order_assignments set ended_at = app_now(), end_reason = 'reassigned_timeout' where id = r.aid;
    update orders set status = 'waiting_picker', picker_id = null where id = r.order_id and status = 'assigned';
    perform order_log(r.order_id, 'assigned', 'waiting_picker', 'no preparation started in ' || v_min || ' min');
    perform picker_log(r.picker_id, r.order_id, 'timeout_unassigned');
    perform refresh_picker_busy(r.picker_id);
    n := n + 1;
  end loop;
  perform assign_waiting_orders();
  return n;
end $$;

create or replace function admin_reassign_order(p_order uuid, p_picker uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare o orders; v_old uuid;
begin
  perform require_permission('orders.manage');
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if o.status not in ('waiting_picker','assigned','preparing') then raise exception 'REASSIGN_NOT_ALLOWED'; end if;
  if p_picker is not null and not exists (select 1 from pickers where user_id = p_picker) then raise exception 'PICKER_NOT_FOUND'; end if;
  v_old := o.picker_id;
  update order_assignments set ended_at = app_now(), end_reason = 'manual' where order_id = p_order and ended_at is null;
  if p_picker is null then
    update orders set status = 'waiting_picker', picker_id = null where id = p_order;
    if o.status <> 'waiting_picker' then perform order_log(p_order, o.status, 'waiting_picker', 'manual: back to queue'); end if;
  else
    insert into order_assignments(order_id, picker_id, assigned_at, started_at, assigned_by)
    values (p_order, p_picker, app_now(), case when o.started_preparing_at is not null then app_now() end, auth.uid());
    update orders set picker_id = p_picker,
           status = case when o.status = 'waiting_picker' then 'assigned'::order_status else o.status end where id = p_order;
    if o.status = 'waiting_picker' then perform order_log(p_order, 'waiting_picker', 'assigned', 'manual assignment'); end if;
    perform picker_log(p_picker, p_order, 'assigned_manually');
    perform refresh_picker_busy(p_picker);
  end if;
  if v_old is not null then perform refresh_picker_busy(v_old); end if;
  perform audit_write('order_reassigned', 'orders', p_order::text, jsonb_build_object('picker', v_old), jsonb_build_object('picker', p_picker));
  if p_picker is null then perform assign_waiting_orders(); end if;
end $$;

-- ---------- picker workflow ----------
create or replace function picker_check(p_order uuid) returns orders
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := require_active(); o orders;
begin
  if not has_permission('picker.work') then raise exception 'FORBIDDEN'; end if;
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if not exists (select 1 from order_assignments where order_id = p_order and picker_id = v_uid and ended_at is null) then
    raise exception 'NOT_ASSIGNED_TO_YOU'; end if;
  return o;
end $$;
revoke all on function picker_check(uuid) from public, anon, authenticated;

-- begin preparing (idempotent). Stops the 10-minute timer and blocks employee cancellation.
create or replace function picker_begin(p_order uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare o orders;
begin
  o := picker_check(p_order);
  if o.status = 'preparing' then return; end if;
  if o.status <> 'assigned' then raise exception 'INVALID_STATE'; end if;
  update orders set status = 'preparing', started_preparing_at = app_now() where id = p_order;
  update order_assignments set started_at = app_now() where order_id = p_order and ended_at is null and started_at is null;
  perform order_log(p_order, 'assigned', 'preparing', 'preparation started');
  perform picker_log(auth.uid(), p_order, 'start_preparing');
  perform notify(o.user_id, 'preparation_started', p_order, 'رقم الطلب ' || o.order_no);
end $$;
create or replace function picker_start_order(p_order uuid) returns void
language sql security definer set search_path = public, pg_temp as $$ select picker_begin(p_order) $$;

create or replace function item_finalize_status(p_ordered int, p_prepared int, p_unavail int) returns item_status
language sql immutable as $$
  select case when p_prepared + p_unavail < p_ordered then 'pending'::item_status
              when p_unavail = 0 then 'prepared'::item_status
              when p_prepared = 0 then 'out_of_stock'::item_status
              else 'partial'::item_status end
$$;

-- scan one unit by barcode
create or replace function picker_scan(p_order uuid, p_barcode text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o orders; it order_items;
begin
  o := picker_check(p_order);
  if o.status = 'assigned' then perform picker_begin(p_order); elsif o.status <> 'preparing' then raise exception 'INVALID_STATE'; end if;
  select * into it from order_items where order_id = p_order and barcode = btrim(p_barcode) for update;
  if not found then raise exception 'ITEM_NOT_IN_ORDER'; end if;
  if it.qty_prepared + it.qty_unavailable >= it.qty_ordered then raise exception 'ITEM_ALREADY_DONE'; end if;
  update order_items set qty_prepared = qty_prepared + 1,
         status = item_finalize_status(qty_ordered, qty_prepared + 1, qty_unavailable),
         prepared_at = case when item_finalize_status(qty_ordered, qty_prepared + 1, qty_unavailable) <> 'pending' then app_now() else prepared_at end
   where id = it.id returning * into it;
  perform picker_log(auth.uid(), p_order, 'scan', jsonb_build_object('barcode', it.barcode, 'prepared', it.qty_prepared));
  return jsonb_build_object('item_id', it.id, 'qty_prepared', it.qty_prepared, 'qty_unavailable', it.qty_unavailable, 'status', it.status);
end $$;

-- set prepared / unavailable quantities explicitly (partial fulfilment, OUT OF STOCK). Every change is logged.
create or replace function picker_set_item(p_order uuid, p_item uuid, p_prepared int, p_unavailable int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o orders; it order_items; v_extra int; v_new order_items;
begin
  o := picker_check(p_order);
  if o.status = 'assigned' then perform picker_begin(p_order); elsif o.status <> 'preparing' then raise exception 'INVALID_STATE'; end if;
  select * into it from order_items where id = p_item and order_id = p_order for update;
  if not found then raise exception 'ITEM_NOT_IN_ORDER'; end if;
  if p_prepared is null or p_unavailable is null or p_prepared < 0 or p_unavailable < 0
     or p_prepared + p_unavailable > it.qty_ordered then raise exception 'INVALID_QTY'; end if;
  if p_unavailable < it.qty_unavailable then raise exception 'CANNOT_REDUCE_UNAVAILABLE'; end if;
  v_extra := p_unavailable - it.qty_unavailable;
  if v_extra > 0 then
    -- release this employee's category-limit reservation for the missing units
    if it.category_id is not null then
      update employee_category_reservations set qty = greatest(qty - v_extra, 0), released = (qty - v_extra) <= 0
       where order_id = p_order and category_id = it.category_id;
    end if;
    -- stock: by default the missing units are NOT put back (they were not found); configurable
    if setting_bool('oos_return_to_stock') then
      perform stock_move(it.product_id, v_extra, 'order_release', null, p_order, 'out of stock at picking (returned)');
    else
      insert into stock_movements(product_id, movement_type, qty_delta, qty_before, qty_after, order_id, actor_id, note)
      select it.product_id, 'oos_reported', 0, stock_qty, stock_qty, p_order, auth.uid(), 'picker could not find ' || v_extra || ' unit(s)'
      from products where id = it.product_id;
    end if;
    update orders set is_partial = true where id = p_order;
    perform notify(o.user_id, 'product_unavailable', p_order, it.name);
  end if;
  update order_items set qty_prepared = p_prepared, qty_unavailable = p_unavailable,
         status = item_finalize_status(qty_ordered, p_prepared, p_unavailable),
         prepared_at = case when item_finalize_status(qty_ordered, p_prepared, p_unavailable) <> 'pending' then app_now() else null end
   where id = p_item returning * into v_new;
  perform picker_log(auth.uid(), p_order, 'set_item', jsonb_build_object('item', p_item, 'barcode', it.barcode,
      'prepared_before', it.qty_prepared, 'prepared_after', p_prepared,
      'unavailable_before', it.qty_unavailable, 'unavailable_after', p_unavailable));
  return jsonb_build_object('item_id', v_new.id, 'qty_prepared', v_new.qty_prepared, 'qty_unavailable', v_new.qty_unavailable, 'status', v_new.status);
end $$;

-- finish preparation: bag counts, final amounts, reconciliation of bags / fee / unavailable items
create or replace function picker_complete_order(p_order uuid, p_small int, p_large int) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  o orders; v_prep int; v_fee int; v_ps int; v_pl int; v_bag int; v_delta int; v_prod_refund int; v_bal bigint; v_use int; v_unfinished int;
begin
  o := picker_check(p_order);
  if o.status <> 'preparing' then raise exception 'INVALID_STATE'; end if;
  if p_small is null or p_large is null or p_small < 0 or p_large < 0 or p_small > 50 or p_large > 50 then raise exception 'BAGS_REQUIRED'; end if;
  select count(*) into v_unfinished from order_items where order_id = p_order and qty_prepared + qty_unavailable < qty_ordered;
  if v_unfinished > 0 then raise exception 'ITEMS_NOT_FINISHED'; end if;

  select coalesce(sum(unit_price_piastres * qty_prepared), 0)::int into v_prep from order_items where order_id = p_order;
  update order_assignments set ended_at = app_now(), end_reason = 'completed' where order_id = p_order and ended_at is null;
  perform picker_log(auth.uid(), p_order, 'complete', jsonb_build_object('small_bags', p_small, 'large_bags', p_large));

  if v_prep = 0 then                                   -- nothing could be prepared: cancel, refund everything
    perform release_order(p_order, 'canceled', 'all items unavailable', false);
    perform issue_refund(p_order, o.total_piastres, 'out_of_stock', false, 'all items unavailable', 'oos:' || p_order);
    perform notify(o.user_id, 'order_canceled', p_order, 'لم يتوفر أي منتج من طلبك');
    perform refresh_picker_busy(auth.uid());
    perform assign_waiting_orders();
    return jsonb_build_object('order_id', p_order, 'status', 'canceled', 'refund_piastres', o.total_piastres);
  end if;

  select price_piastres into v_ps from bag_pricing where bag_type = 'small';
  select price_piastres into v_pl from bag_pricing where bag_type = 'large';
  v_bag := p_small * v_ps + p_large * v_pl;
  v_fee := money_pct(v_prep, o.fee_bp);
  v_delta := v_bag - o.bag_initial_piastres;
  v_prod_refund := (o.subtotal_piastres - v_prep) + (o.fee_piastres - v_fee);

  update orders set status = 'ready_handover', ready_at = app_now(),
         prepared_subtotal_piastres = v_prep, final_fee_piastres = v_fee, bag_small_count = p_small, bag_large_count = p_large,
         bag_small_price = v_ps, bag_large_price = v_pl, bag_actual_piastres = v_bag,
         final_total_piastres = v_prep + v_bag + v_fee
   where id = p_order;
  perform order_log(p_order, 'preparing', 'ready_handover', 'preparation complete');

  if v_prod_refund > 0 then
    perform issue_refund(p_order, v_prod_refund, 'out_of_stock', false, 'unavailable items / fee adjustment', 'oos:' || p_order);
  end if;
  if v_delta < 0 then
    perform wallet_credit(o.user_id, -v_delta, 'bag_difference', p_order, 'bagdiff:' || p_order);
    perform notify(o.user_id, 'wallet_credited', p_order, 'فرق الأكياس أُضيف إلى محفظتك');
  elsif v_delta > 0 then
    select coalesce(balance_piastres, 0) into v_bal from wallets where user_id = o.user_id;
    v_use := least(coalesce(v_bal, 0), v_delta)::int;
    if v_use > 0 then perform wallet_debit(o.user_id, v_use, 'bag_extra', p_order, 'bagextra:' || p_order); end if;
    if v_delta - v_use > 0 then
      update orders set extra_due_piastres = v_delta - v_use where id = p_order;
      perform notify(o.user_id, 'extra_payment_required', p_order, 'المبلغ المطلوب ' || ((v_delta - v_use) / 100.0)::numeric(12,2) || ' ج.م');
    end if;
  end if;
  if exists (select 1 from order_items where order_id = p_order and qty_unavailable > 0) then
    perform notify(o.user_id, 'order_partial', p_order, 'رقم الطلب ' || o.order_no);
  end if;
  perform refresh_picker_busy(auth.uid());
  perform assign_waiting_orders();
  return jsonb_build_object('order_id', p_order, 'status', 'ready_handover', 'final_total_piastres', v_prep + v_bag + v_fee,
                            'extra_due_piastres', (select extra_due_piastres from orders where id = p_order));
end $$;

-- ---------- pickup counter ----------
create or replace function pickup_check() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_uid uuid := require_active();
begin
  if not has_permission('pickup.work') then raise exception 'FORBIDDEN'; end if;
  return v_uid;
end $$;

create or replace function pickup_find(p_code text) returns orders
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare o orders; v text := upper(btrim(coalesce(p_code, '')));
begin
  perform pickup_check();
  if v = '' then raise exception 'INVALID_INPUT'; end if;
  select * into o from orders where pickup_code = v or (v ~ '^\d+$' and order_no = v::bigint) limit 1;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  return o;
end $$;

create or replace function pickup_lookup(p_code text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare o orders;
begin
  o := pickup_find(p_code);
  return jsonb_build_object('order_id', o.id, 'order_no', o.order_no, 'status', o.status, 'employee_name', o.employee_name,
    'hrid', o.hrid, 'extra_due_piastres', o.extra_due_piastres, 'bag_small', o.bag_small_count, 'bag_large', o.bag_large_count,
    'items', coalesce((select jsonb_agg(jsonb_build_object('name', name, 'barcode', barcode, 'qty_prepared', qty_prepared,
              'qty_unavailable', qty_unavailable, 'image_url', image_url) order by name) from order_items where order_id = o.id), '[]'));
end $$;

-- pickup employee confirms receiving the order from the picker
create or replace function pickup_receive(p_order uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := pickup_check(); o orders;
begin
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if o.status <> 'ready_handover' then raise exception 'INVALID_STATE'; end if;
  update orders set status = 'received_pickup', pickup_user_id = v_uid, pickup_received_at = app_now() where id = p_order;
  perform order_log(p_order, 'ready_handover', 'received_pickup', 'received at pickup counter');
  perform notify(o.user_id, 'received_pickup', p_order, 'رقم الطلب ' || o.order_no);
  if o.extra_due_piastres = 0 then
    update orders set status = 'ready_collection' where id = p_order;
    perform order_log(p_order, 'received_pickup', 'ready_collection', null);
    perform notify(o.user_id, 'order_ready', p_order, 'رقم الطلب ' || o.order_no || ' — كود الاستلام ' || o.pickup_code);
  end if;
  return jsonb_build_object('order_id', p_order, 'status', (select status from orders where id = p_order));
end $$;

-- final collection by the employee (order number or QR code)
create or replace function pickup_collect(p_code text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := pickup_check(); o orders;
begin
  o := pickup_find(p_code);
  select * into o from orders where id = o.id for update;
  if o.status = 'collected' then raise exception 'ALREADY_COLLECTED'; end if;
  if o.extra_due_piastres > 0 then raise exception 'EXTRA_PAYMENT_DUE'; end if;
  if o.status <> 'ready_collection' then raise exception 'NOT_READY'; end if;
  update orders set status = 'collected', collected_by = v_uid, collected_at = app_now() where id = o.id;
  perform order_log(o.id, 'ready_collection', 'collected', 'collected by employee');
  perform notify(o.user_id, 'order_collected', o.id, 'رقم الطلب ' || o.order_no);
  return jsonb_build_object('order_id', o.id, 'order_no', o.order_no, 'status', 'collected');
end $$;

-- ---------- scheduled jobs entry point ----------
create or replace function run_scheduled_jobs() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_exp int; v_re int;
begin
  v_exp := expire_unpaid_orders();
  v_re := reassign_stale_assignments();
  perform assign_waiting_orders();
  return jsonb_build_object('expired', v_exp, 'reassigned', v_re);
end $$;
revoke all on function run_scheduled_jobs(), reassign_stale_assignments() from public, anon, authenticated;
