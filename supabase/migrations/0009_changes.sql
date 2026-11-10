-- =====================================================================
-- 0009_changes.sql
--  1) No admin wallet editing (money only moves through orders/refunds)
--  2) System category "null" (fixed limit 2/day) for products without a category
--  3) Order number is assigned only when the order is PAID (unpaid checkouts are not "orders")
--  4) Two import modes: catalog (name/barcode/category/image[/price]) and stock (name/barcode/qty)
--  5) Category limits import
--  6) Card refunds are pushed to Paymob automatically (pg_net -> Edge Function)
-- =====================================================================

-- ---------- 1) wallet can no longer be edited by admins ----------
drop function if exists admin_wallet_adjust(uuid, int, text);

-- ---------- 2) system category "null" ----------
alter table categories add column is_system boolean not null default false;
insert into categories(name, sort_order, is_system) values ('null', 9999, true)
  on conflict (name) do update set is_system = true;
insert into category_daily_limits(category_id, max_qty_per_employee)
  select id, 2 from categories where is_system
  on conflict (category_id) do update set max_qty_per_employee = 2, is_active = true;

create or replace function null_category_id() returns uuid
language sql stable security definer set search_path = public, pg_temp as $$ select id from categories where is_system limit 1 $$;

create or replace function products_default_category() returns trigger language plpgsql as $$
begin if new.category_id is null then new.category_id := null_category_id(); end if; return new; end $$;
create trigger products_default_category before insert or update of category_id on products
  for each row execute function products_default_category();
update products set category_id = null_category_id() where category_id is null;

create or replace function category_system_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'SYSTEM_CATEGORY'; end if;
  if new.name <> old.name or new.is_active = false or new.is_system = false then raise exception 'SYSTEM_CATEGORY'; end if;
  return new;
end $$;
create trigger categories_system_guard before update or delete on categories
  for each row when (old.is_system) execute function category_system_guard();

create or replace function limit_system_guard() returns trigger language plpgsql as $$
begin
  if not exists (select 1 from categories c where c.id = old.category_id and c.is_system) then return coalesce(new, old); end if;
  if tg_op = 'DELETE' or new.max_qty_per_employee <> 2 or not new.is_active then raise exception 'SYSTEM_CATEGORY'; end if;
  return new;
end $$;
create trigger limits_system_guard before update or delete on category_daily_limits
  for each row execute function limit_system_guard();

-- an active product must have a price (nothing can be sold for free by mistake)
update products set is_active = false where price_piastres <= 0;
alter table products add constraint products_active_needs_price check (not is_active or price_piastres > 0);

-- ---------- 3) order number only when paid ----------
alter table orders alter column order_no drop identity;
alter table orders alter column order_no drop not null;
create sequence if not exists order_no_seq start with 1001;
select setval('order_no_seq', greatest(coalesce((select max(order_no) from orders), 1000), 1000), true);

create or replace function confirm_order_paid(p_order uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare o orders; v_no bigint;
begin
  select * into o from orders where id = p_order for update;
  if o.status <> 'pending_payment' then return; end if;
  v_no := coalesce(o.order_no, nextval('order_no_seq'));
  update orders set status = 'confirmed', paid_at = app_now(), order_no = v_no where id = p_order;
  perform order_log(p_order, 'pending_payment', 'confirmed', 'payment received');
  update slot_reservations set status = 'confirmed' where order_id = p_order and status = 'held';
  update orders set status = 'waiting_picker' where id = p_order;
  perform order_log(p_order, 'confirmed', 'waiting_picker', null);
  if o.card_due_piastres > 0 then perform notify(o.user_id, 'payment_received', p_order, 'رقم الطلب ' || v_no); end if;
  perform notify(o.user_id, 'order_confirmed', p_order, 'رقم الطلب ' || v_no);
  perform assign_waiting_orders();
end $$;

create or replace function payment_prepare(p_order uuid, p_purpose text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := require_active(); o orders; v_amount int; v_pid uuid; v_email text; v_attempts int;
begin
  perform rate_limit_check('payment_prepare:' || v_uid, 10, 60);
  select * into o from orders where id = p_order for update;
  if not found or o.user_id <> v_uid then raise exception 'ORDER_NOT_FOUND'; end if;
  if p_purpose = 'order' then
    if o.status <> 'pending_payment' then raise exception 'ORDER_NOT_PAYABLE'; end if;
    if o.payment_expires_at <= app_now() then raise exception 'PAYMENT_WINDOW_EXPIRED'; end if;
    v_amount := o.card_due_piastres;
  elsif p_purpose = 'extra' then
    if o.extra_due_piastres <= 0 or o.status not in ('ready_handover','received_pickup','ready_collection') then
      raise exception 'ORDER_NOT_PAYABLE'; end if;
    v_amount := o.extra_due_piastres;
  else raise exception 'INVALID_INPUT'; end if;
  if v_amount <= 0 then raise exception 'ORDER_NOT_PAYABLE'; end if;
  if exists (select 1 from payments where order_id = p_order and purpose = p_purpose and status = 'paid') then
    raise exception 'ALREADY_PAID'; end if;
  select count(*) into v_attempts from payments where order_id = p_order;
  if v_attempts >= 10 then raise exception 'TOO_MANY_ATTEMPTS'; end if;
  select email into v_email from profiles where id = v_uid;
  insert into payments(order_id, user_id, purpose, amount_piastres) values (p_order, v_uid, p_purpose, v_amount) returning id into v_pid;
  return jsonb_build_object('payment_id', v_pid, 'amount_piastres', v_amount,
                            'order_ref', coalesce('BF-' || o.order_no, 'CHK-' || upper(substr(o.id::text, 1, 6))),
                            'employee_name', o.employee_name, 'email', v_email, 'hrid', o.hrid);
end $$;

-- admin order search: unpaid checkouts are hidden unless explicitly filtered
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
    where (o.paid_at is not null or coalesce(p ->> 'status', '') in ('pending_payment','expired','canceled'))
      and (p ->> 'from' is null or o.business_date >= (p ->> 'from')::date)
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

-- ---------- 4) import modes ----------
alter table stock_import_batches add column mode text not null default 'stock' check (mode in ('catalog','stock'));
drop function if exists import_stage(text, jsonb);

create or replace function import_stage(p_file_name text, p_rows jsonb, p_mode text default 'stock') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_mode text := coalesce(p_mode, 'stock');
  v_batch uuid; v_row jsonb; v_n int := 0; v_barcode text; v_name text; v_cat text; v_img text;
  v_price int; v_qty int; v_err text; v_action text; v_prod products; v_hash text;
  v_new int := 0; v_upd int := 0; v_bad int := 0; v_dup uuid; v_dup_info jsonb; v_raw_price text; v_raw_qty text;
begin
  if v_mode not in ('catalog','stock') then raise exception 'INVALID_INPUT'; end if;
  perform require_permission(case when v_mode = 'catalog' then 'products.manage' else 'stock.import' end);
  perform rate_limit_check('import_stage:' || auth.uid(), 30, 3600);
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'EMPTY_FILE'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'FILE_TOO_LARGE'; end if;

  insert into stock_import_batches(file_name, content_hash, created_by, mode)
  values (left(coalesce(p_file_name, ''), 200), 'pending', auth.uid(), v_mode) returning id into v_batch;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_n := v_n + 1; v_err := null; v_price := null; v_qty := null; v_prod := null;
    v_barcode := nullif(btrim(coalesce(v_row ->> 'barcode', '')), '');
    v_name := nullif(btrim(coalesce(v_row ->> 'name', '')), '');
    v_cat  := nullif(btrim(coalesce(v_row ->> 'category', '')), '');
    v_img  := nullif(btrim(coalesce(v_row ->> 'image_url', '')), '');
    v_raw_price := nullif(btrim(coalesce(v_row ->> 'price', '')), '');
    v_raw_qty   := nullif(btrim(coalesce(v_row ->> 'qty', '')), '');
    begin
      if v_mode = 'catalog' and v_raw_price is not null then
        v_price := round(v_raw_price::numeric * 100)::int;
        if v_price < 0 then v_err := 'PRICE_NEGATIVE'; elsif v_price = 0 then v_err := 'PRICE_MUST_BE_POSITIVE'; end if;
      end if;
      if v_mode = 'stock' and v_raw_qty is not null then
        if v_raw_qty::numeric <> trunc(v_raw_qty::numeric) or v_raw_qty::numeric < 0 then v_err := 'QTY_INVALID';
        else v_qty := v_raw_qty::numeric::int; end if;
      end if;
    exception when others then v_err := 'NUMBER_INVALID'; end;
    if v_barcode is null then v_err := 'BARCODE_MISSING'; end if;
    if v_img is not null and v_img !~* '^https?://' then v_err := coalesce(v_err, 'IMAGE_URL_INVALID'); end if;

    if v_barcode is not null then select * into v_prod from products where barcode = v_barcode; end if;
    if v_err is null then
      if v_mode = 'catalog' then
        if v_prod.id is null and v_name is null then v_err := 'NAME_REQUIRED_FOR_NEW'; end if;
      else
        if v_raw_qty is null then v_err := 'QTY_REQUIRED';
        elsif v_prod.id is null then v_err := 'PRODUCT_NOT_FOUND'; end if;
      end if;
    end if;
    if v_mode = 'stock' then v_name := coalesce(v_prod.name, v_name); v_cat := null; v_img := null; end if;

    v_action := case when v_err is not null then 'invalid' when v_prod.id is null then 'new' else 'update' end;
    insert into stock_import_items(batch_id, row_no, barcode, name, category_name, image_url, price_piastres, qty, action,
                                   error, product_id, old_qty, new_qty, old_price)
    values (v_batch, v_n, v_barcode, v_name, v_cat, v_img, v_price, coalesce(v_qty, 0), v_action, v_err, v_prod.id,
            coalesce(v_prod.stock_qty, 0), coalesce(v_prod.stock_qty, 0) + coalesce(v_qty, 0), v_prod.price_piastres);
  end loop;

  update stock_import_items i set action = 'invalid', error = 'DUPLICATE_BARCODE_IN_FILE'
  where i.batch_id = v_batch and i.barcode is not null and i.barcode in (
    select barcode from stock_import_items where batch_id = v_batch and barcode is not null group by barcode having count(*) > 1);

  select count(*) filter (where action = 'new'), count(*) filter (where action = 'update'), count(*) filter (where action = 'invalid')
    into v_new, v_upd, v_bad from stock_import_items where batch_id = v_batch;

  select v_mode || ':' || encode(sha256(convert_to(coalesce(string_agg(
      coalesce(barcode,'') || '|' || coalesce(qty,0) || '|' || coalesce(price_piastres::text,'') || '|' || coalesce(name,'') || '|' || coalesce(category_name,'') || '|' || coalesce(image_url,''),
      ';' order by barcode, row_no), ''), 'UTF8')), 'hex') into v_hash from stock_import_items where batch_id = v_batch;

  select id into v_dup from stock_import_batches where content_hash = v_hash and status = 'confirmed' order by confirmed_at desc limit 1;
  if v_dup is not null then
    select jsonb_build_object('batch_id', id, 'file_name', file_name, 'confirmed_at', confirmed_at) into v_dup_info from stock_import_batches where id = v_dup;
  end if;
  update stock_import_batches set content_hash = v_hash, total_rows = v_n, new_count = v_new, update_count = v_upd,
         invalid_count = v_bad, duplicate_of = v_dup where id = v_batch;
  return jsonb_build_object('batch_id', v_batch, 'mode', v_mode, 'total_rows', v_n, 'new_count', v_new, 'update_count', v_upd,
                            'invalid_count', v_bad, 'duplicate_of', v_dup_info);
end $$;

create or replace function import_confirm(p_batch uuid, p_allow_duplicate boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_b stock_import_batches; it stock_import_items; v_prod products; v_cat uuid; v_new int := 0; v_upd int := 0; v_dup uuid;
begin
  select * into v_b from stock_import_batches where id = p_batch for update;
  if not found then raise exception 'BATCH_NOT_FOUND'; end if;
  perform require_permission(case when v_b.mode = 'catalog' then 'products.manage' else 'stock.import' end);
  if v_b.status <> 'preview' then raise exception 'BATCH_NOT_PENDING'; end if;
  if v_b.invalid_count > 0 then raise exception 'BATCH_HAS_INVALID_ROWS'; end if;
  select id into v_dup from stock_import_batches where content_hash = v_b.content_hash and status = 'confirmed' and id <> v_b.id limit 1;
  if v_dup is not null and not coalesce(p_allow_duplicate, false) then raise exception 'DUPLICATE_BATCH'; end if;

  for it in select * from stock_import_items where batch_id = p_batch order by barcode loop
    if v_b.mode = 'catalog' then
      v_cat := null;
      if it.category_name is not null and lower(it.category_name) <> 'null' then
        insert into categories(name) values (it.category_name) on conflict (name) do nothing;
        select id into v_cat from categories where name = it.category_name;
      end if;
      select * into v_prod from products where barcode = it.barcode for update;
      if not found then
        insert into products(barcode, name, category_id, image_url, price_piastres, stock_qty, is_active)
        values (it.barcode, it.name, v_cat, it.image_url, coalesce(it.price_piastres, 0), 0, coalesce(it.price_piastres, 0) > 0)
        returning * into v_prod;
        v_new := v_new + 1;
        update stock_import_items set product_id = v_prod.id, action = 'new' where id = it.id;
      else
        update products set name = coalesce(it.name, name), category_id = coalesce(v_cat, category_id),
               image_url = coalesce(it.image_url, image_url), price_piastres = coalesce(it.price_piastres, price_piastres)
         where id = v_prod.id;
        v_upd := v_upd + 1;
        update stock_import_items set product_id = v_prod.id, action = 'update' where id = it.id;
      end if;
    else
      select * into v_prod from products where barcode = it.barcode for update;
      if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
      update stock_import_items set product_id = v_prod.id, old_qty = v_prod.stock_qty,
             new_qty = v_prod.stock_qty + coalesce(it.qty, 0), action = 'update' where id = it.id;
      if coalesce(it.qty, 0) > 0 then perform stock_move(v_prod.id, it.qty, 'import', p_batch, null, 'Excel/CSV stock import'); end if;
      v_upd := v_upd + 1;
    end if;
  end loop;

  update stock_import_batches set status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = app_now(),
         new_count = v_new, update_count = v_upd, duplicate_of = v_dup where id = p_batch;
  perform audit_write('import_confirmed', 'stock_import_batches', p_batch::text, null,
      jsonb_build_object('mode', v_b.mode, 'new', v_new, 'updated', v_upd, 'file', v_b.file_name, 'duplicate_allowed', v_dup is not null));
  return jsonb_build_object('batch_id', p_batch, 'mode', v_b.mode, 'new_count', v_new, 'update_count', v_upd);
end $$;

grant execute on function import_stage(text, jsonb, text) to authenticated;
revoke execute on function import_stage(text, jsonb, text) from anon, public;

-- ---------- 5) category limits import ----------
create or replace function limits_import(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb; v_name text; v_lim text; c categories; v_upd int := 0; v_rem int := 0; v_bad int := 0; v_sys int := 0; v_unknown text[] := '{}';
begin
  perform require_permission('limits.manage');
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 or jsonb_array_length(p_rows) > 2000 then raise exception 'EMPTY_FILE'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_name := btrim(coalesce(r ->> 'category', '')); v_lim := btrim(coalesce(r ->> 'limit', ''));
    if v_name = '' then v_bad := v_bad + 1; continue; end if;
    select * into c from categories where name = v_name;
    if not found then select * into c from categories where lower(name) = lower(v_name) limit 1; end if;
    if not found then v_unknown := array_append(v_unknown, v_name); continue; end if;
    if c.is_system then v_sys := v_sys + 1; continue; end if;
    if v_lim = '' then
      delete from category_daily_limits where category_id = c.id; v_rem := v_rem + 1;
    elsif v_lim ~ '^\d+$' and v_lim::int > 0 then
      insert into category_daily_limits(category_id, max_qty_per_employee, updated_by) values (c.id, v_lim::int, auth.uid())
      on conflict (category_id) do update set max_qty_per_employee = excluded.max_qty_per_employee, updated_by = auth.uid(), updated_at = now(), is_active = true;
      v_upd := v_upd + 1;
    else v_bad := v_bad + 1; end if;
  end loop;
  perform audit_write('limits_import', 'category_daily_limits', null, null,
    jsonb_build_object('updated', v_upd, 'removed', v_rem, 'invalid', v_bad, 'unknown', v_unknown));
  return jsonb_build_object('updated', v_upd, 'removed', v_rem, 'invalid', v_bad, 'skipped_system', v_sys, 'unknown', to_jsonb(v_unknown));
end $$;
grant execute on function limits_import(jsonb) to authenticated;
revoke execute on function limits_import(jsonb) from anon, public;

-- ---------- 6) automatic card refunds ----------
-- A small private config table (no policies, no grants => unreachable from the API). Filled once by the admin (see docs/DEPLOY.md):
--   functions_url = https://YOUR_REF.supabase.co/functions/v1      cron_secret = same value as the Edge Function secret CRON_SECRET
create table if not exists app_private_config (key text primary key, value text not null);
alter table app_private_config enable row level security;
revoke all on app_private_config from anon, authenticated;

do $$ begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    begin create extension if not exists pg_net; exception when others then raise notice 'pg_net not enabled: %', sqlerrm; end;
  end if;
end $$;

create or replace function kick_refund_worker() returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_url text; v_secret text;
begin
  if to_regnamespace('net') is null then return; end if;
  select value into v_url from app_private_config where key = 'functions_url';
  select value into v_secret from app_private_config where key = 'cron_secret';
  if v_url is null or v_secret is null then return; end if;
  perform net.http_post(url := rtrim(v_url, '/') || '/process-refunds',
                        headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
                        body := '{}'::jsonb);
exception when others then
  raise notice 'kick_refund_worker failed: %', sqlerrm;     -- never block the transaction that created the refund
end $$;
revoke all on function kick_refund_worker() from public, anon, authenticated;

create or replace function refunds_kick_trigger() returns trigger language plpgsql as $$
begin perform kick_refund_worker(); return new; end $$;
create trigger refunds_auto_process after insert or update of status on refunds
  for each row when (new.method = 'card' and new.status = 'pending') execute function refunds_kick_trigger();

create or replace function run_scheduled_jobs() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_exp int; v_re int;
begin
  v_exp := expire_unpaid_orders();
  v_re := reassign_stale_assignments();
  perform assign_waiting_orders();
  if exists (select 1 from refunds where method = 'card' and status in ('pending','processing')) then
    perform refund_requeue_stuck();
    perform kick_refund_worker();
  end if;
  return jsonb_build_object('expired', v_exp, 'reassigned', v_re);
end $$;

create or replace function refund_requeue_stuck() returns void
language sql security definer set search_path = public, pg_temp as $$
  update refunds set status = 'pending' where status = 'processing' and updated_at < now() - interval '10 minutes'
$$;
revoke all on function refund_requeue_stuck() from public, anon, authenticated;
