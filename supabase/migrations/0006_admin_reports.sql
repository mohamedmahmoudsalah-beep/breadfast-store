-- =====================================================================
-- 0006_admin_reports.sql | Presence (online employees), dashboard, order search,
-- Excel report data, scheduled jobs, realtime publication.
-- =====================================================================

-- ---------- online employees counter ----------
-- Supabase Free allows ~200 concurrent Realtime connections, but up to ~300 employees can be online at once.
-- So presence is a lightweight heartbeat (one tiny upsert/minute/user) instead of one WebSocket per user.
-- Distinct users by definition (one row per user); disconnects/expired sessions drop out after 2 minutes.
create table presence_heartbeats (
  user_id   uuid primary key references auth.users(id) on delete cascade,
  last_seen timestamptz not null default now()
);

create or replace function heartbeat() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := require_active();
begin
  insert into presence_heartbeats(user_id, last_seen) values (v_uid, now())
  on conflict (user_id) do update set last_seen = now();
end $$;

create or replace function online_users(p_details boolean default false) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_count int; v_list jsonb := '[]';
begin
  perform require_permission('dashboard.view');
  select count(*) into v_count from presence_heartbeats where last_seen > now() - interval '2 minutes';
  if p_details and has_permission('users.manage') then
    select coalesce(jsonb_agg(jsonb_build_object('name', coalesce(e.full_name, p.email), 'hrid', e.hrid) order by e.full_name), '[]')
      into v_list from presence_heartbeats h join profiles p on p.id = h.user_id left join employees e on e.user_id = h.user_id
     where h.last_seen > now() - interval '2 minutes';
  end if;
  return jsonb_build_object('count', v_count, 'users', v_list);
end $$;

-- ---------- dashboard ----------
create or replace function dashboard_stats(p_from date default null, p_to date default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_from date := coalesce(p_from, business_date()); v_to date := coalesce(p_to, coalesce(p_from, business_date()));
        v jsonb; v_sales bigint; v_cnt int; v_paid bigint; v_ref bigint; v_bagcredit bigint; v_bagextra bigint;
begin
  perform require_permission('dashboard.view');
  select coalesce(sum(coalesce(final_total_piastres, total_piastres)), 0), count(*) into v_sales, v_cnt
    from orders where business_date between v_from and v_to and status not in ('pending_payment','expired','canceled');
  select coalesce(sum(total_piastres + extra_paid_piastres), 0) into v_paid
    from orders where business_date between v_from and v_to and paid_at is not null;
  select coalesce(sum(r.amount_piastres), 0) into v_ref from refunds r join orders o on o.id = r.order_id
    where o.business_date between v_from and v_to and r.status <> 'failed';
  select coalesce(sum(t.amount_piastres) filter (where t.reason = 'bag_difference'), 0),
         coalesce(sum(t.amount_piastres) filter (where t.reason = 'bag_extra'), 0)
    into v_bagcredit, v_bagextra from wallet_transactions t join orders o on o.id = t.order_id
    where o.business_date between v_from and v_to;
  select jsonb_build_object(
    'from', v_from, 'to', v_to,
    'sales_piastres', v_sales, 'orders_count', v_cnt,
    'paid_piastres', v_paid, 'refunds_piastres', v_ref,
    'net_sales_piastres', v_paid - v_ref - v_bagcredit + v_bagextra,
    'avg_order_value_piastres', case when v_cnt = 0 then 0 else (v_sales / v_cnt) end,
    'online_users', (select count(*) from presence_heartbeats where last_seen > now() - interval '2 minutes'),
    'available_pickers', (select count(*) from pickers where status = 'available'),
    'orders_waiting', (select count(*) from orders where business_date between v_from and v_to and status in ('waiting_picker','assigned')),
    'orders_preparing', (select count(*) from orders where business_date between v_from and v_to and status = 'preparing'),
    'orders_ready', (select count(*) from orders where business_date between v_from and v_to and status in ('ready_handover','received_pickup','ready_collection')),
    'orders_completed', (select count(*) from orders where business_date between v_from and v_to and status = 'collected'),
    'out_of_stock_items', (select count(*) from products where is_active and stock_qty = 0),
    'low_stock_items', coalesce((select jsonb_agg(row_to_json(l)) from (select barcode, name, stock_qty from products
        where is_active and stock_qty between 1 and 5 order by stock_qty, name limit 20) l), '[]'),
    'top_products', coalesce((select jsonb_agg(row_to_json(t)) from (
        select i.barcode, i.name, sum(i.qty_prepared + case when o.final_total_piastres is null then i.qty_ordered - i.qty_unavailable - i.qty_prepared else 0 end)::int as qty,
               sum(i.unit_price_piastres * (case when o.final_total_piastres is null then i.qty_ordered - i.qty_unavailable else i.qty_prepared end))::bigint as revenue_piastres
        from order_items i join orders o on o.id = i.order_id
        where o.business_date between v_from and v_to and o.status not in ('pending_payment','expired','canceled')
        group by i.barcode, i.name order by qty desc nulls last limit 10) t), '[]'),
    'orders_per_slot', coalesce((select jsonb_agg(row_to_json(s)) from (
        select slot_label, count(*)::int as orders from orders
        where business_date between v_from and v_to and status not in ('pending_payment','expired','canceled')
        group by slot_label order by slot_label) s), '[]'),
    'picker_performance', coalesce((select jsonb_agg(row_to_json(pp)) from (
        select coalesce(pr.full_name, pr.email) as picker, p.status,
               (select count(*) from order_assignments a where a.picker_id = p.user_id and a.end_reason = 'completed'
                  and (a.ended_at at time zone 'Africa/Cairo')::date between v_from and v_to)::int as completed,
               (select round(avg(extract(epoch from (a.ended_at - a.started_at)) / 60.0)::numeric, 1) from order_assignments a
                 where a.picker_id = p.user_id and a.end_reason = 'completed' and a.started_at is not null
                   and (a.ended_at at time zone 'Africa/Cairo')::date between v_from and v_to) as avg_minutes,
               picker_active_count(p.user_id) as active_now
        from pickers p join profiles pr on pr.id = p.user_id order by completed desc) pp), '[]')
  ) into v;
  return v;
end $$;

-- ---------- order monitoring with filters ----------
create or replace function admin_search_orders(p jsonb default '{}') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v jsonb;
begin
  perform require_permission('orders.view');
  select coalesce(jsonb_agg(row_to_json(t)), '[]') into v from (
    select o.id, o.order_no, o.status, o.hrid, o.employee_name, o.business_date, o.slot_label, o.created_at,
           coalesce(o.final_total_piastres, o.total_piastres) as total_piastres, o.is_partial,
           o.extra_due_piastres, o.wallet_applied_piastres, o.card_due_piastres,
           (select coalesce(pr.full_name, pr.email) from profiles pr where pr.id = o.picker_id) as picker_name,
           (select coalesce(pr.full_name, pr.email) from profiles pr where pr.id = o.pickup_user_id) as pickup_name,
           case when o.wallet_applied_piastres > 0 and o.card_due_piastres > 0 then 'mixed'
                when o.wallet_applied_piastres > 0 then 'wallet' else 'card' end as payment_method
    from orders o
    where (p ->> 'from' is null or o.business_date >= (p ->> 'from')::date)
      and (p ->> 'to' is null or o.business_date <= (p ->> 'to')::date)
      and (p ->> 'status' is null or o.status::text = p ->> 'status')
      and (p ->> 'hrid' is null or o.hrid ilike '%' || btrim(p ->> 'hrid') || '%')
      and (p ->> 'employee' is null or o.employee_name ilike '%' || btrim(p ->> 'employee') || '%')
      and (p ->> 'order_no' is null or o.order_no = (p ->> 'order_no')::bigint)
      and (p ->> 'picker_id' is null or o.picker_id = (p ->> 'picker_id')::uuid)
      and (p ->> 'barcode' is null or exists (select 1 from order_items i where i.order_id = o.id and i.barcode = p ->> 'barcode'))
      and (p ->> 'category_id' is null or exists (select 1 from order_items i where i.order_id = o.id and i.category_id = (p ->> 'category_id')::uuid))
      and (p ->> 'payment_method' is null or
           (case when o.wallet_applied_piastres > 0 and o.card_due_piastres > 0 then 'mixed'
                 when o.wallet_applied_piastres > 0 then 'wallet' else 'card' end) = p ->> 'payment_method')
    order by o.created_at desc limit 300) t;
  return v;
end $$;

-- ---------- Excel report data (4 sheets) ----------
create or replace function report_sales(p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_orders jsonb; v_items jsonb; v_summary jsonb; v_products jsonb;
begin
  perform require_permission('reports.export');
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then raise exception 'INVALID_INPUT'; end if;

  -- Sheet 1: orders that were paid at some point (unpaid / expired attempts are not sales)
  select coalesce(jsonb_agg(row_to_json(t) order by t.order_id), '[]') into v_orders from (
    select o.order_no as order_id, o.employee_name, o.hrid, pr.email as employee_email,
      to_char(o.created_at at time zone 'Africa/Cairo', 'YYYY-MM-DD') as order_date,
      to_char(o.created_at at time zone 'Africa/Cairo', 'HH24:MI:SS') as order_time,
      o.slot_label as time_slot, o.status::text as order_status,
      case when coalesce(rf.amt, 0) = 0 then 'paid'
           when rf.amt >= o.total_piastres + o.extra_paid_piastres then 'refunded' else 'partially_refunded' end as payment_status,
      round(coalesce(o.prepared_subtotal_piastres, o.subtotal_piastres) / 100.0, 2) as products_subtotal,
      round(coalesce(o.bag_actual_piastres, o.bag_initial_piastres) / 100.0, 2) as bag_charge,
      round(coalesce(o.final_fee_piastres, o.fee_piastres) / 100.0, 2) as payment_processing_fee,
      round(coalesce(o.final_total_piastres, o.total_piastres) / 100.0, 2) as final_total,
      round(coalesce(rf.amt, 0) / 100.0, 2) as refunded_amount,
      pk.full_name as picker_name, pu.full_name as pickup_employee_name,
      to_char(o.collected_at at time zone 'Africa/Cairo', 'YYYY-MM-DD HH24:MI:SS') as completion_timestamp
    from orders o
    join profiles pr on pr.id = o.user_id
    left join profiles pk on pk.id = o.picker_id
    left join profiles pu on pu.id = o.pickup_user_id
    left join lateral (select sum(amount_piastres) amt from refunds r where r.order_id = o.id and r.status <> 'failed') rf on true
    where o.business_date between p_from and p_to and o.paid_at is not null) t;

  -- Sheet 2: every product line
  select coalesce(jsonb_agg(row_to_json(t) order by t.order_id, t.product_name), '[]') into v_items from (
    select o.order_no as order_id, i.barcode, i.name as product_name, i.category_name as category,
      i.qty_ordered as ordered_quantity, i.qty_prepared as prepared_quantity, i.qty_unavailable as unavailable_quantity,
      round(i.unit_price_piastres / 100.0, 2) as unit_price,
      round(i.unit_price_piastres * i.qty_prepared / 100.0, 2) as item_total, i.status::text as item_status
    from order_items i join orders o on o.id = i.order_id
    where o.business_date between p_from and p_to and o.paid_at is not null) t;

  -- Sheet 3: summary. Sales = paid orders that were not cancelled.
  select jsonb_build_object(
    'total_orders', count(*),
    'paid_orders', count(*) filter (where paid_at is not null),
    'completed_orders', count(*) filter (where status = 'collected'),
    'canceled_orders', count(*) filter (where status in ('canceled','expired')),
    'partial_orders', count(*) filter (where is_partial and status not in ('canceled','expired')),
    'gross_product_sales', round(coalesce(sum(subtotal_piastres) filter (where paid_at is not null and status <> 'canceled'), 0) / 100.0, 2),
    'bag_charges', round(coalesce(sum(coalesce(bag_actual_piastres, bag_initial_piastres)) filter (where paid_at is not null and status <> 'canceled'), 0) / 100.0, 2),
    'payment_fees', round(coalesce(sum(fee_piastres) filter (where paid_at is not null and status <> 'canceled'), 0) / 100.0, 2),
    'refunds', round(coalesce(sum(
        (subtotal_piastres - coalesce(prepared_subtotal_piastres, subtotal_piastres)) + (fee_piastres - coalesce(final_fee_piastres, fee_piastres)))
        filter (where paid_at is not null and status <> 'canceled'), 0) / 100.0, 2),
    'net_sales', round(coalesce(sum(coalesce(final_total_piastres, total_piastres)) filter (where paid_at is not null and status <> 'canceled'), 0) / 100.0, 2),
    'cancellation_refunds', round(coalesce((select sum(r.amount_piastres) from refunds r join orders o2 on o2.id = r.order_id
        where o2.business_date between p_from and p_to and o2.status = 'canceled' and r.status <> 'failed'), 0) / 100.0, 2),
    'note', 'Net = Gross product sales + Bag charges + Payment fees - Refunds (unavailable items and fee adjustments). Cancelled orders are excluded from sales; their money is shown under cancellation_refunds.')
    into v_summary from orders where business_date between p_from and p_to;

  -- Sheet 4: product performance (paid, not cancelled)
  select coalesce(jsonb_agg(row_to_json(t) order by t.total_revenue desc), '[]') into v_products from (
    select i.barcode, max(i.name) as product_name, max(i.category_name) as category,
      sum(case when o.final_total_piastres is null then i.qty_ordered - i.qty_unavailable else i.qty_prepared end)::int as total_quantity_sold,
      round(sum(i.unit_price_piastres * (case when o.final_total_piastres is null then i.qty_ordered - i.qty_unavailable else i.qty_prepared end)) / 100.0, 2) as total_revenue,
      count(distinct o.id)::int as number_of_orders
    from order_items i join orders o on o.id = i.order_id
    where o.business_date between p_from and p_to and o.paid_at is not null and o.status <> 'canceled'
    group by i.barcode) t;

  perform audit_write('report_exported', 'reports', null, null, jsonb_build_object('from', p_from, 'to', p_to));
  return jsonb_build_object('orders_summary', v_orders, 'order_items', v_items, 'sales_summary', v_summary, 'product_performance', v_products);
end $$;

-- ---------- scheduled jobs (pg_cron when available) ----------
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    begin
      create extension if not exists pg_cron;
      perform cron.schedule('breadfast-jobs', '* * * * *', 'select public.run_scheduled_jobs()');
    exception when others then
      raise notice 'pg_cron could not be enabled automatically (%). Enable it from Database > Extensions, then run supabase/seed/schedule_jobs.sql', sqlerrm;
    end;
  end if;
end $$;

-- ---------- realtime publication ----------
do $$
declare t text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    foreach t in array array['orders','order_items','notifications','pickers'] loop
      begin execute format('alter publication supabase_realtime add table public.%I', t);
      exception when duplicate_object then null; end;
    end loop;
  end if;
end $$;
