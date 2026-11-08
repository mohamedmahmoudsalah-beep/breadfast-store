-- =====================================================================
-- 0004_orders_payments.sql | Wallet ledger, notifications, orders, reservations,
-- payments, refunds. Lock order used everywhere (prevents deadlocks):
--   employee row -> order row -> time slot row -> product rows (by id) -> wallet row
-- =====================================================================

-- ---------- wallet (immutable ledger; balance moves ONLY through the ledger trigger) ----------
create table wallets (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  balance_piastres bigint not null default 0 check (balance_piastres >= 0),
  updated_at      timestamptz not null default now()
);

create table wallet_transactions (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id),
  order_id        uuid,
  direction       text not null check (direction in ('credit','debit')),
  amount_piastres int  not null check (amount_piastres > 0),
  reason          text not null,
  ref_type        text,
  ref_id          text,
  idempotency_key text unique,
  balance_after   bigint,
  created_by      uuid,
  created_at      timestamptz not null default now()
);
create index wallet_tx_user_idx on wallet_transactions(user_id, created_at desc);

create or replace function wallet_ledger_apply() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_bal bigint;
begin
  insert into wallets(user_id) values (new.user_id) on conflict do nothing;
  select balance_piastres into v_bal from wallets where user_id = new.user_id for update;
  v_bal := v_bal + case when new.direction = 'credit' then new.amount_piastres else -new.amount_piastres end;
  if v_bal < 0 then raise exception 'INSUFFICIENT_WALLET'; end if;
  new.balance_after := v_bal;
  perform set_config('app.wallet_write', '1', true);
  update wallets set balance_piastres = v_bal, updated_at = now() where user_id = new.user_id;
  perform set_config('app.wallet_write', '0', true);
  return new;
end $$;
create trigger wallet_tx_apply before insert on wallet_transactions
  for each row execute function wallet_ledger_apply();

create or replace function wallet_tx_immutable() returns trigger language plpgsql as $$
begin raise exception 'WALLET_LEDGER_IS_IMMUTABLE'; end $$;
create trigger wallet_tx_no_change before update or delete on wallet_transactions
  for each row execute function wallet_tx_immutable();

create or replace function wallet_direct_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'WALLET_DIRECT_CHANGE_FORBIDDEN'; end if;
  if tg_op = 'UPDATE' and coalesce(current_setting('app.wallet_write', true), '0') <> '1' then
    raise exception 'WALLET_DIRECT_CHANGE_FORBIDDEN'; end if;
  if tg_op = 'INSERT' and new.balance_piastres <> 0 then raise exception 'WALLET_DIRECT_CHANGE_FORBIDDEN'; end if;
  return coalesce(new, old);
end $$;
create trigger wallets_guard before insert or update or delete on wallets
  for each row execute function wallet_direct_guard();

-- internal helpers; return false when the idempotency key was already used
create or replace function wallet_credit(p_user uuid, p_amount int, p_reason text, p_order uuid, p_key text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_amount <= 0 then return false; end if;
  if p_key is not null and exists (select 1 from wallet_transactions where idempotency_key = p_key) then return false; end if;
  insert into wallet_transactions(user_id, order_id, direction, amount_piastres, reason, ref_type, ref_id, idempotency_key, created_by)
  values (p_user, p_order, 'credit', p_amount, p_reason, case when p_order is not null then 'order' end, p_order::text, p_key, auth.uid());
  return true;
end $$;

create or replace function wallet_debit(p_user uuid, p_amount int, p_reason text, p_order uuid, p_key text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_amount <= 0 then return false; end if;
  if p_key is not null and exists (select 1 from wallet_transactions where idempotency_key = p_key) then return false; end if;
  insert into wallet_transactions(user_id, order_id, direction, amount_piastres, reason, ref_type, ref_id, idempotency_key, created_by)
  values (p_user, p_order, 'debit', p_amount, p_reason, case when p_order is not null then 'order' end, p_order::text, p_key, auth.uid());
  return true;
end $$;
revoke all on function wallet_credit(uuid,int,text,uuid,text), wallet_debit(uuid,int,text,uuid,text)
  from public, anon, authenticated;

create or replace function admin_wallet_adjust(p_user uuid, p_amount int, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform require_permission('wallets.manage');
  if p_amount is null or p_amount = 0 or abs(p_amount) > 10000000 then raise exception 'INVALID_INPUT'; end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then raise exception 'REASON_REQUIRED'; end if;
  if not exists (select 1 from employees where user_id = p_user) then raise exception 'NOT_AN_EMPLOYEE'; end if;
  if p_amount > 0 then perform wallet_credit(p_user, p_amount, 'manual_adjustment', null, 'adj:' || gen_random_uuid());
  else perform wallet_debit(p_user, -p_amount, 'manual_adjustment', null, 'adj:' || gen_random_uuid()); end if;
  perform audit_write('wallet_manual_adjustment', 'wallets', p_user::text, null,
                      jsonb_build_object('amount_piastres', p_amount, 'reason', p_reason));
end $$;

-- ledger vs balance consistency check (should return zero rows)
create or replace function wallet_reconcile() returns table(user_id uuid, balance bigint, ledger_sum bigint)
language sql stable security definer set search_path = public, pg_temp as $$
  select w.user_id, w.balance_piastres,
         coalesce((select sum(case when direction='credit' then amount_piastres else -amount_piastres end)
                   from wallet_transactions t where t.user_id = w.user_id), 0)
  from wallets w
  where w.balance_piastres <> coalesce((select sum(case when direction='credit' then amount_piastres else -amount_piastres end)
                   from wallet_transactions t where t.user_id = w.user_id), 0)
$$;

-- ---------- notifications ----------
create table notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users(id) on delete cascade,
  type       text not null,
  title      text not null,
  body       text,
  order_id   uuid,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on notifications(user_id, created_at desc);

create or replace function notify(p_user uuid, p_type text, p_order uuid, p_body text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_title text;
begin
  v_title := case p_type
    when 'order_confirmed' then 'تم تأكيد طلبك'
    when 'payment_received' then 'تم استلام الدفع'
    when 'order_assigned' then 'تم تعيين مجهّز لطلبك'
    when 'preparation_started' then 'بدأ تجهيز طلبك'
    when 'product_unavailable' then 'منتج غير متاح في طلبك'
    when 'order_partial' then 'تم تجهيز طلبك جزئيًا'
    when 'order_ready' then 'طلبك جاهز للاستلام'
    when 'received_pickup' then 'وصل طلبك لنقطة الاستلام'
    when 'order_collected' then 'تم استلام طلبك'
    when 'order_canceled' then 'تم إلغاء الطلب'
    when 'refund_initiated' then 'بدأ استرداد المبلغ'
    when 'refund_completed' then 'تم استرداد المبلغ'
    when 'wallet_credited' then 'تمت إضافة رصيد لمحفظتك'
    when 'extra_payment_required' then 'مطلوب دفع مبلغ إضافي'
    else p_type end;
  insert into notifications(user_id, type, title, body, order_id) values (p_user, p_type, v_title, p_body, p_order);
end $$;
revoke all on function notify(uuid,text,uuid,text) from public, anon, authenticated;

create or replace function notifications_mark_read(p_ids uuid[] default null) returns void
language sql security definer set search_path = public, pg_temp as $$
  update notifications set read_at = now()
  where user_id = auth.uid() and read_at is null and (p_ids is null or id = any(p_ids))
$$;

-- ---------- orders ----------
create type order_status as enum ('pending_payment','confirmed','waiting_picker','assigned','preparing',
  'ready_handover','received_pickup','ready_collection','collected','canceled','expired');
create type item_status as enum ('pending','prepared','partial','out_of_stock');

create table orders (
  id              uuid primary key default gen_random_uuid(),
  order_no        bigint generated by default as identity (start with 1001) unique,
  user_id         uuid not null references auth.users(id),
  hrid            text not null,
  employee_name   text not null,
  status          order_status not null default 'pending_payment',
  idempotency_key text not null,
  business_date   date not null,
  slot_id         uuid,
  slot_date       date,
  slot_label      text,
  slot_start      timestamptz,
  -- amounts at checkout (integer piastres)
  subtotal_piastres     int not null check (subtotal_piastres >= 0),
  bag_initial_piastres  int not null check (bag_initial_piastres >= 0),
  fee_bp                int not null,
  fee_piastres          int not null check (fee_piastres >= 0),
  total_piastres        int not null check (total_piastres >= 0),
  wallet_applied_piastres int not null default 0 check (wallet_applied_piastres >= 0),
  card_due_piastres     int not null default 0 check (card_due_piastres >= 0),
  payment_expires_at    timestamptz,
  -- fulfilment
  picker_id             uuid,
  started_preparing_at  timestamptz,
  prepared_subtotal_piastres int,
  final_fee_piastres    int,
  bag_small_count       int,
  bag_large_count       int,
  bag_small_price       int,
  bag_large_price       int,
  bag_actual_piastres   int,
  final_total_piastres  int,
  extra_due_piastres    int not null default 0 check (extra_due_piastres >= 0),
  extra_paid_piastres   int not null default 0,
  is_partial            boolean not null default false,
  pickup_code           text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  pickup_user_id        uuid,
  pickup_received_at    timestamptz,
  collected_by          uuid,
  collected_at          timestamptz,
  paid_at               timestamptz,
  ready_at              timestamptz,
  canceled_at           timestamptz,
  cancel_reason         text,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (user_id, idempotency_key)
);
create index orders_user_idx on orders(user_id, created_at desc);
create index orders_status_idx on orders(status);
create index orders_bd_idx on orders(business_date);
create index orders_picker_idx on orders(picker_id) where status in ('assigned','preparing');
-- at most ONE unpaid order per employee at a time (blocks duplicates from refresh / multiple tabs)
create unique index orders_one_pending_per_user on orders(user_id) where status = 'pending_payment';
create trigger orders_touch before update on orders for each row execute function touch_updated_at();

create table order_items (
  id             uuid primary key default gen_random_uuid(),
  order_id       uuid not null references orders(id) on delete cascade,
  product_id     uuid not null references products(id),
  barcode        text not null,
  name           text not null,
  category_id    uuid,
  category_name  text,
  image_url      text,
  unit_price_piastres int not null check (unit_price_piastres >= 0),
  qty_ordered    int not null check (qty_ordered > 0),
  qty_prepared   int not null default 0 check (qty_prepared >= 0),
  qty_unavailable int not null default 0 check (qty_unavailable >= 0),
  status         item_status not null default 'pending',
  prepared_at    timestamptz,
  unique (order_id, product_id),
  check (qty_prepared + qty_unavailable <= qty_ordered)
);
create index order_items_order_idx on order_items(order_id);
create index order_items_product_idx on order_items(product_id);

create table order_status_history (
  id         bigint generated always as identity primary key,
  order_id   uuid not null references orders(id) on delete cascade,
  from_status order_status,
  to_status  order_status not null,
  actor_id   uuid,
  note       text,
  created_at timestamptz not null default now()
);
create index order_history_idx on order_status_history(order_id, created_at);

create table slot_reservations (
  id         uuid primary key default gen_random_uuid(),
  slot_id    uuid not null references time_slots(id),
  slot_date  date not null,
  order_id   uuid not null unique references orders(id) on delete cascade,
  status     text not null default 'held' check (status in ('held','confirmed','released')),
  created_at timestamptz not null default now()
);
create index slot_res_idx on slot_reservations(slot_id, slot_date) where status in ('held','confirmed');

create table employee_category_reservations (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id),
  category_id   uuid not null references categories(id),
  business_date date not null,
  order_id      uuid not null references orders(id) on delete cascade,
  qty           int not null check (qty >= 0),
  released      boolean not null default false,
  unique (order_id, category_id)
);
create index cat_res_idx on employee_category_reservations(user_id, category_id, business_date) where not released;

create or replace function order_log(p_order uuid, p_from order_status, p_to order_status, p_note text default null) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into order_status_history(order_id, from_status, to_status, actor_id, note) values (p_order, p_from, p_to, auth.uid(), p_note)
$$;
revoke all on function order_log(uuid,order_status,order_status,text) from public, anon, authenticated;

-- ---------- payments / refunds ----------
create table payments (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references orders(id),
  user_id         uuid not null references auth.users(id),
  purpose         text not null check (purpose in ('order','extra')),
  provider        text not null default 'paymob',
  amount_piastres int not null check (amount_piastres > 0),
  status          text not null default 'initiated'
                  check (status in ('initiated','pending','paid','failed','expired','mismatch')),
  provider_order_id text,
  provider_txn_id text,
  raw             jsonb,
  created_at      timestamptz not null default now(),
  paid_at         timestamptz
);
create index payments_order_idx on payments(order_id);
create unique index payments_txn_unique on payments(provider, provider_txn_id) where provider_txn_id is not null;

create table payment_webhook_events (
  event_key    text primary key,          -- dedupes provider callbacks (idempotent webhooks)
  payload      jsonb not null,
  result       text,
  received_at  timestamptz not null default now(),
  processed_at timestamptz
);

create table refunds (
  id               uuid primary key default gen_random_uuid(),
  order_id         uuid not null references orders(id),
  payment_id       uuid references payments(id),
  user_id          uuid not null references auth.users(id),
  method           text not null check (method in ('card','wallet')),
  amount_piastres  int not null check (amount_piastres > 0),
  status           text not null default 'pending' check (status in ('pending','processing','completed','failed')),
  kind             text not null,       -- cancellation | out_of_stock | duplicate_payment | late_payment | manual
  reason           text,
  provider_refund_id text,
  idempotency_key  text not null unique,
  attempts         int not null default 0,
  last_error       text,
  created_by       uuid,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  completed_at     timestamptz
);
create index refunds_order_idx on refunds(order_id);
create index refunds_pending_idx on refunds(status) where status in ('pending','processing');
create trigger refunds_touch before update on refunds for each row execute function touch_updated_at();
create trigger audit_refunds after insert or update on refunds for each row execute function audit_row_change('id');
create trigger audit_payments after insert or update on payments for each row execute function audit_row_change('id');

-- ---------- helpers ----------
create or replace function money_pct(p_base int, p_bp int) returns int
language sql immutable as $$ select ((p_base::bigint * p_bp + 5000) / 10000)::int $$;   -- half-up, integer maths

create or replace function order_result(p_order uuid, p_replay boolean) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('order_id', id, 'order_no', order_no, 'status', status, 'total_piastres', total_piastres,
    'wallet_applied_piastres', wallet_applied_piastres, 'card_due_piastres', card_due_piastres,
    'payment_expires_at', payment_expires_at, 'replay', p_replay) from orders where id = p_order
$$;

-- today's usage of each category limit for the signed-in employee
create or replace function my_category_usage() returns table(category_id uuid, used int, max_qty int)
language sql stable security definer set search_path = public, pg_temp as $$
  select l.category_id,
         coalesce((select sum(r.qty) from employee_category_reservations r
                   where r.user_id = auth.uid() and r.category_id = l.category_id
                     and r.business_date = business_date() and not r.released), 0)::int,
         l.max_qty_per_employee
  from category_daily_limits l where l.is_active
$$;

-- ---------- create_order: atomic, idempotent ----------
create or replace function create_order(p_items jsonb, p_slot_id uuid, p_idempotency_key text, p_use_wallet boolean default true)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_uid uuid := require_active(); v_emp employees; v_ex orders; v_pend orders; v_bd date := business_date();
  v_st jsonb; v_slot time_slots; v_booked int; v_n int; r record; v_prod products; v_subtotal int := 0;
  v_bag int; v_bp int; v_fee int; v_total int; v_bal bigint; v_wallet int := 0; v_card int; v_oid uuid := gen_random_uuid();
  v_expiry int := setting_int('reservation_expiry_minutes'); v_lim int; v_used int;
  v_ids uuid[]; v_qtys int[];
begin
  if p_idempotency_key is null or length(p_idempotency_key) < 8 or length(p_idempotency_key) > 100 then
    raise exception 'INVALID_INPUT'; end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then raise exception 'EMPTY_CART'; end if;
  perform rate_limit_check('create_order:' || v_uid, 30, 60);

  select * into v_ex from orders where user_id = v_uid and idempotency_key = p_idempotency_key;
  if found then return order_result(v_ex.id, true); end if;

  select * into v_emp from employees where user_id = v_uid for update;                -- serialises this employee
  if not found or not v_emp.is_active then raise exception 'NOT_AN_EMPLOYEE'; end if;

  select * into v_ex from orders where user_id = v_uid and idempotency_key = p_idempotency_key;
  if found then return order_result(v_ex.id, true); end if;

  select * into v_pend from orders where user_id = v_uid and status = 'pending_payment' for update;
  if found then
    if v_pend.payment_expires_at is not null and v_pend.payment_expires_at <= app_now() then
      perform release_order(v_pend.id, 'expired', 'payment window expired', true);
    else
      raise exception 'PENDING_ORDER_EXISTS' using detail = v_pend.id::text;
    end if;
  end if;

  -- store open + slot
  v_st := store_status();
  if not (v_st ->> 'open')::boolean then raise exception 'STORE_CLOSED' using detail = v_st ->> 'reason'; end if;
  select * into v_slot from time_slots where id = p_slot_id for update;
  if not found or not v_slot.is_active then raise exception 'SLOT_UNAVAILABLE'; end if;
  if ((v_bd + v_slot.start_time) at time zone 'Africa/Cairo') < app_now() + make_interval(mins => setting_int('min_lead_minutes')) then
    raise exception 'SLOT_UNAVAILABLE'; end if;
  select count(*) into v_booked from slot_reservations where slot_id = v_slot.id and slot_date = v_bd and status in ('held','confirmed');
  if v_booked >= v_slot.capacity then raise exception 'SLOT_FULL'; end if;

  -- aggregate cart lines (duplicates merged) into arrays ordered by product id
  select array_agg(s.product_id order by s.product_id), array_agg(s.qty order by s.product_id), count(*)
    into v_ids, v_qtys, v_n
    from (select x.product_id, sum(coalesce(x.qty, 0))::int as qty
          from jsonb_to_recordset(p_items) as x(product_id uuid, qty int) group by x.product_id) s;
  if v_n is null or v_n = 0 then raise exception 'EMPTY_CART'; end if;
  if v_n > setting_int('max_order_lines') then raise exception 'TOO_MANY_LINES'; end if;
  if exists (select 1 from unnest(v_ids, v_qtys) as c(pid, q) where pid is null or q < 1 or q > setting_int('max_item_qty')) then
    raise exception 'INVALID_QTY'; end if;

  -- lock products in a fixed order, validate stock
  for r in select c.pid as product_id, c.q as qty from unnest(v_ids, v_qtys) as c(pid, q) order by c.pid loop
    select * into v_prod from products where id = r.product_id for update;
    if not found or not v_prod.is_active then raise exception 'PRODUCT_UNAVAILABLE' using detail = r.product_id::text; end if;
    if v_prod.stock_qty < r.qty then raise exception 'INSUFFICIENT_STOCK' using detail = r.product_id::text; end if;
    v_subtotal := v_subtotal + v_prod.price_piastres * r.qty;
  end loop;

  -- category limits per employee per business day (shared by all orders)
  for r in select p.category_id, sum(c.q)::int as qty from unnest(v_ids, v_qtys) as c(pid, q) join products p on p.id = c.pid
           where p.category_id is not null group by p.category_id order by p.category_id loop
    select max_qty_per_employee into v_lim from category_daily_limits where category_id = r.category_id and is_active;
    if v_lim is not null then
      select coalesce(sum(qty), 0) into v_used from employee_category_reservations
       where user_id = v_uid and category_id = r.category_id and business_date = v_bd and not released;
      if v_used + r.qty > v_lim then raise exception 'CATEGORY_LIMIT_EXCEEDED' using detail = r.category_id::text; end if;
    end if;
  end loop;

  -- amounts
  v_bag := setting_int('bag_initial_piastres'); v_bp := setting_int('fee_bp');
  v_fee := money_pct(v_subtotal, v_bp); v_total := v_subtotal + v_bag + v_fee;
  if p_use_wallet then
    select balance_piastres into v_bal from wallets where user_id = v_uid;
    v_wallet := least(coalesce(v_bal, 0), v_total)::int;
  end if;
  v_card := v_total - v_wallet;

  insert into orders(id, user_id, hrid, employee_name, status, idempotency_key, business_date, slot_id, slot_date, slot_label, slot_start,
                     subtotal_piastres, bag_initial_piastres, fee_bp, fee_piastres, total_piastres,
                     wallet_applied_piastres, card_due_piastres, payment_expires_at)
  values (v_oid, v_uid, v_emp.hrid, v_emp.full_name, 'pending_payment', p_idempotency_key, v_bd, v_slot.id, v_bd,
          v_slot.label || ' (' || to_char(v_slot.start_time, 'HH24:MI') || '-' || to_char(v_slot.end_time, 'HH24:MI') || ')',
          (v_bd + v_slot.start_time) at time zone 'Africa/Cairo', v_subtotal, v_bag, v_bp, v_fee, v_total, v_wallet, v_card,
          app_now() + make_interval(mins => v_expiry));

  insert into order_items(order_id, product_id, barcode, name, category_id, category_name, image_url, unit_price_piastres, qty_ordered)
  select v_oid, p.id, p.barcode, p.name, p.category_id, cat.name, p.image_url, p.price_piastres, c.q
  from unnest(v_ids, v_qtys) as c(pid, q) join products p on p.id = c.pid left join categories cat on cat.id = p.category_id;

  for r in select c.pid as product_id, c.q as qty from unnest(v_ids, v_qtys) as c(pid, q) order by c.pid loop
    perform stock_move(r.product_id, -r.qty, 'order_reserve', null, v_oid, 'order reservation');
  end loop;

  insert into employee_category_reservations(user_id, category_id, business_date, order_id, qty)
  select v_uid, p.category_id, v_bd, v_oid, sum(c.q) from unnest(v_ids, v_qtys) as c(pid, q) join products p on p.id = c.pid
  where p.category_id is not null group by p.category_id;

  insert into slot_reservations(slot_id, slot_date, order_id) values (v_slot.id, v_bd, v_oid);
  perform order_log(v_oid, null, 'pending_payment', 'created');

  if v_wallet > 0 then
    perform wallet_debit(v_uid, v_wallet, 'order_payment', v_oid, 'ordpay:' || v_oid);
  end if;
  if v_card = 0 then perform confirm_order_paid(v_oid); end if;      -- fully paid from wallet
  return order_result(v_oid, false);
exception when unique_violation then
  -- concurrent duplicate with the same idempotency key: return the winner's order
  select * into v_ex from orders where user_id = v_uid and idempotency_key = p_idempotency_key;
  if found then return order_result(v_ex.id, true); end if;
  raise;
end $$;

-- ---------- paid / release ----------
create or replace function confirm_order_paid(p_order uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare o orders;
begin
  select * into o from orders where id = p_order for update;
  if o.status <> 'pending_payment' then return; end if;
  update orders set status = 'confirmed', paid_at = app_now() where id = p_order;
  perform order_log(p_order, 'pending_payment', 'confirmed', 'payment received');
  update slot_reservations set status = 'confirmed' where order_id = p_order and status = 'held';
  update orders set status = 'waiting_picker' where id = p_order;
  perform order_log(p_order, 'confirmed', 'waiting_picker', null);
  if o.card_due_piastres > 0 then perform notify(o.user_id, 'payment_received', p_order, 'رقم الطلب ' || o.order_no); end if;
  perform notify(o.user_id, 'order_confirmed', p_order, 'رقم الطلب ' || o.order_no);
  perform assign_waiting_orders();
end $$;
revoke all on function confirm_order_paid(uuid) from public, anon, authenticated;

-- release every reservation of an order (stock, category limit, slot) and set its final status
create or replace function release_order(p_order uuid, p_status order_status, p_reason text, p_restore_wallet boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare o orders; it record;
begin
  select * into o from orders where id = p_order for update;
  if o.status in ('canceled','expired','collected') then return; end if;
  if o.slot_id is not null then perform 1 from time_slots where id = o.slot_id for update; end if;
  for it in select product_id, qty_ordered - qty_unavailable as qty from order_items where order_id = p_order order by product_id loop
    if it.qty > 0 then perform stock_move(it.product_id, it.qty, 'order_release', null, p_order, p_reason); end if;
  end loop;
  update employee_category_reservations set released = true where order_id = p_order;
  update slot_reservations set status = 'released' where order_id = p_order;
  update payments set status = 'expired' where order_id = p_order and status in ('initiated','pending');
  if p_restore_wallet and o.wallet_applied_piastres > 0 and o.paid_at is null then
    perform wallet_credit(o.user_id, o.wallet_applied_piastres, 'order_unpaid_release', p_order, 'unpaid_rel:' || p_order);
  end if;
  update orders set status = p_status, canceled_at = app_now(), cancel_reason = p_reason where id = p_order;
  perform order_log(p_order, o.status, p_status, p_reason);
end $$;
revoke all on function release_order(uuid,order_status,text,boolean) from public, anon, authenticated;

create or replace function expire_unpaid_orders() returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare r record; n int := 0;
begin
  for r in select id from orders where status = 'pending_payment' and payment_expires_at <= app_now()
           order by payment_expires_at for update skip locked loop
    perform release_order(r.id, 'expired', 'payment window expired', true); n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function expire_unpaid_orders() from public, anon, authenticated;

-- ---------- refunds ----------
create or replace function order_net_paid(p_order uuid) returns int
language sql stable security definer set search_path = public, pg_temp as $$
  select (o.total_piastres + o.extra_paid_piastres
          + coalesce((select sum(amount_piastres) from wallet_transactions where order_id = o.id and reason = 'bag_extra'), 0)
          - coalesce((select sum(amount_piastres) from wallet_transactions where order_id = o.id and reason = 'bag_difference'), 0)
          - coalesce((select sum(amount_piastres) from refunds where order_id = o.id and status <> 'failed'), 0))::int
  from orders o where o.id = p_order
$$;

-- Money back: card first (original payment), remainder (wallet-paid part) to wallet. p_to_wallet forces wallet.
create or replace function issue_refund(p_order uuid, p_amount int, p_kind text, p_to_wallet boolean, p_reason text, p_key text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare o orders; v_left int := p_amount; v_take int; pay record; v_card boolean := false;
begin
  if p_amount is null or p_amount <= 0 then return; end if;
  if exists (select 1 from refunds where idempotency_key like p_key || ':%') then return; end if;
  select * into o from orders where id = p_order;
  if not coalesce(p_to_wallet, false) then
    for pay in select p.id, p.amount_piastres - coalesce((select sum(r.amount_piastres) from refunds r
                         where r.payment_id = p.id and r.status <> 'failed'), 0) as remaining
               from payments p where p.order_id = p_order and p.status = 'paid' order by p.paid_at loop
      exit when v_left <= 0;
      v_take := least(v_left, pay.remaining);
      if v_take > 0 then
        insert into refunds(order_id, payment_id, user_id, method, amount_piastres, kind, reason, idempotency_key, created_by)
        values (p_order, pay.id, o.user_id, 'card', v_take, p_kind, p_reason, p_key || ':card:' || pay.id, auth.uid());
        v_left := v_left - v_take; v_card := true;
      end if;
    end loop;
  end if;
  if v_left > 0 then
    perform wallet_credit(o.user_id, v_left, 'refund', p_order, 'refund:' || p_key);
    insert into refunds(order_id, user_id, method, amount_piastres, status, kind, reason, idempotency_key, created_by, completed_at)
    values (p_order, o.user_id, 'wallet', v_left, 'completed', p_kind, p_reason, p_key || ':wallet', auth.uid(), now());
    perform notify(o.user_id, 'wallet_credited', p_order, 'تمت إضافة ' || (v_left / 100.0)::numeric(12,2) || ' ج.م إلى محفظتك');
  end if;
  if v_card then perform notify(o.user_id, 'refund_initiated', p_order,
      'سيتم رد المبلغ إلى بطاقتك الأصلية'); end if;
end $$;
revoke all on function issue_refund(uuid,int,text,boolean,text,text) from public, anon, authenticated;

-- ---------- cancellation ----------
create or replace function cancel_order(p_order uuid, p_refund_to_wallet boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := require_active(); o orders;
begin
  perform 1 from employees where user_id = v_uid for update;
  select * into o from orders where id = p_order for update;
  if not found or o.user_id <> v_uid then raise exception 'ORDER_NOT_FOUND'; end if;
  if o.status not in ('pending_payment','waiting_picker','assigned') then raise exception 'CANCEL_NOT_ALLOWED'; end if;
  if o.status = 'pending_payment' then
    perform release_order(p_order, 'canceled', 'canceled by employee', true);
  else
    update order_assignments set ended_at = app_now(), end_reason = 'canceled' where order_id = p_order and ended_at is null;
    perform release_order(p_order, 'canceled', 'canceled by employee', false);
    perform issue_refund(p_order, o.total_piastres, 'cancellation', coalesce(p_refund_to_wallet, false), 'canceled by employee', 'cancel:' || p_order);
    if o.picker_id is not null then perform refresh_picker_busy(o.picker_id); end if;
  end if;
  perform notify(v_uid, 'order_canceled', p_order, 'رقم الطلب ' || o.order_no);
  return order_result(p_order, false);
end $$;

create or replace function admin_cancel_order(p_order uuid, p_reason text, p_refund_to_wallet boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o orders; v_net int;
begin
  perform require_permission('orders.manage');
  if p_reason is null or length(btrim(p_reason)) < 3 then raise exception 'REASON_REQUIRED'; end if;
  select * into o from orders where id = p_order for update;
  if not found then raise exception 'ORDER_NOT_FOUND'; end if;
  if o.status in ('canceled','expired','collected') then raise exception 'CANCEL_NOT_ALLOWED'; end if;
  update order_assignments set ended_at = app_now(), end_reason = 'canceled' where order_id = p_order and ended_at is null;
  if o.status = 'pending_payment' then
    perform release_order(p_order, 'canceled', 'admin: ' || p_reason, true);
  else
    v_net := order_net_paid(p_order);
    perform release_order(p_order, 'canceled', 'admin: ' || p_reason, false);
    perform issue_refund(p_order, v_net, 'cancellation', coalesce(p_refund_to_wallet, false), 'admin: ' || p_reason, 'admincancel:' || p_order);
    if o.picker_id is not null then perform refresh_picker_busy(o.picker_id); end if;
  end if;
  perform notify(o.user_id, 'order_canceled', p_order, 'رقم الطلب ' || o.order_no);
  perform audit_write('admin_cancel_order', 'orders', p_order::text, jsonb_build_object('status', o.status), jsonb_build_object('reason', p_reason));
  return order_result(p_order, false);
end $$;

-- ---------- payments (called by Edge Functions) ----------
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
  return jsonb_build_object('payment_id', v_pid, 'amount_piastres', v_amount, 'order_no', o.order_no,
                            'employee_name', o.employee_name, 'email', v_email, 'hrid', o.hrid);
end $$;

create or replace function payment_attach_provider(p_payment uuid, p_provider_order_id text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update payments set status = 'pending', provider_order_id = p_provider_order_id where id = p_payment and status = 'initiated'
$$;

create or replace function order_extra_paid(p_order uuid, p_amount int) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare o orders;
begin
  select * into o from orders where id = p_order for update;
  update orders set extra_paid_piastres = extra_paid_piastres + p_amount,
         extra_due_piastres = greatest(extra_due_piastres - p_amount, 0) where id = p_order;
  if o.status = 'received_pickup' and greatest(o.extra_due_piastres - p_amount, 0) = 0 then
    update orders set status = 'ready_collection' where id = p_order;
    perform order_log(p_order, 'received_pickup', 'ready_collection', 'extra payment settled');
    perform notify(o.user_id, 'order_ready', p_order, 'رقم الطلب ' || o.order_no || ' — كود الاستلام ' || o.pickup_code);
  end if;
end $$;
revoke all on function order_extra_paid(uuid,int) from public, anon, authenticated;

-- Provider callback (already HMAC-verified by the Edge Function). Idempotent by event key.
create or replace function payment_process_event(
  p_event_key text, p_payload jsonb, p_kind text, p_merchant_ref text, p_txn_id text,
  p_amount_cents int, p_currency text, p_success boolean, p_pending boolean) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_pay payments; o orders; v_result text;
begin
  insert into payment_webhook_events(event_key, payload) values (p_event_key, p_payload) on conflict do nothing;
  if not found then return 'duplicate_event'; end if;

  if p_kind = 'refund' then
    update refunds set status = 'completed', completed_at = now(), provider_refund_id = coalesce(provider_refund_id, p_txn_id)
     where (provider_refund_id = p_txn_id) and status <> 'completed';
    v_result := 'refund_recorded';
  else
    begin select * into v_pay from payments where id = p_merchant_ref::uuid for update;
    exception when invalid_text_representation then v_pay := null; end;
    if v_pay.id is null then v_result := 'unmatched';
    elsif p_pending then v_result := 'pending_ignored';
    elsif not p_success then
      update payments set status = 'failed', provider_txn_id = coalesce(provider_txn_id, p_txn_id) where id = v_pay.id and status <> 'paid';
      v_result := 'payment_failed';
    elsif v_pay.status = 'paid' then v_result := 'already_paid';
    elsif p_amount_cents is distinct from v_pay.amount_piastres or upper(coalesce(p_currency,'')) <> 'EGP' then
      update payments set status = 'mismatch', provider_txn_id = p_txn_id, raw = p_payload where id = v_pay.id;
      v_result := 'amount_mismatch';
    else
      select * into o from orders where id = v_pay.order_id for update;
      update payments set status = 'paid', paid_at = app_now(), provider_txn_id = p_txn_id, raw = p_payload where id = v_pay.id;
      if v_pay.purpose = 'order' and o.status = 'pending_payment' then
        perform confirm_order_paid(o.id); v_result := 'order_paid';
      elsif v_pay.purpose = 'extra' and o.extra_due_piastres > 0 then
        perform order_extra_paid(o.id, v_pay.amount_piastres); v_result := 'extra_paid';
      else
        -- duplicate / late payment: never double-charge, send it back to the card
        insert into refunds(order_id, payment_id, user_id, method, amount_piastres, kind, reason, idempotency_key)
        values (o.id, v_pay.id, o.user_id, 'card', v_pay.amount_piastres,
                case when o.paid_at is not null then 'duplicate_payment' else 'late_payment' end,
                'payment received when the order could not accept it', 'dup:' || v_pay.id || ':card:' || v_pay.id);
        v_result := 'refund_queued';
      end if;
    end if;
  end if;
  update payment_webhook_events set result = v_result, processed_at = now() where event_key = p_event_key;
  return v_result;
end $$;

-- card refunds worker
create or replace function refund_claim_pending(p_limit int default 10)
returns table(refund_id uuid, amount_piastres int, provider_txn_id text, order_id uuid)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update refunds set status = 'pending' where status = 'processing' and updated_at < now() - interval '10 minutes';
  return query
  with c as (select r.id from refunds r where r.method = 'card' and r.status = 'pending' order by r.created_at
             limit least(coalesce(p_limit, 10), 50) for update skip locked),
  u as (update refunds r set status = 'processing', attempts = r.attempts + 1 from c where r.id = c.id returning r.*)
  select u.id, u.amount_piastres, (select p.provider_txn_id from payments p where p.id = u.payment_id), u.order_id from u;
end $$;

create or replace function refund_complete(p_refund uuid, p_provider_refund_id text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r refunds;
begin
  update refunds set status = 'completed', completed_at = now(), provider_refund_id = p_provider_refund_id, last_error = null
   where id = p_refund and status <> 'completed' returning * into r;
  if found then perform notify(r.user_id, 'refund_completed', r.order_id,
        'تم رد ' || (r.amount_piastres / 100.0)::numeric(12,2) || ' ج.م إلى بطاقتك'); end if;
end $$;

create or replace function refund_fail(p_refund uuid, p_error text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update refunds set status = 'failed', last_error = left(p_error, 500) where id = p_refund and status <> 'completed'
$$;

create or replace function refund_retry(p_refund uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform require_permission('refunds.manage');
  update refunds set status = 'pending', last_error = null where id = p_refund and status = 'failed';
end $$;

revoke all on function payment_attach_provider(uuid,text), payment_process_event(text,jsonb,text,text,text,int,text,boolean,boolean),
  refund_claim_pending(int), refund_complete(uuid,text), refund_fail(uuid,text) from public, anon, authenticated;
