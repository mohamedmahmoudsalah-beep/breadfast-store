-- =====================================================================
-- 0002_catalog.sql | Categories, daily limits, products, stock history,
--                    ADDITIVE Excel/CSV imports with preview + duplicate protection.
-- =====================================================================

create table categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  sort_order int not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table category_daily_limits (
  category_id          uuid primary key references categories(id) on delete cascade,
  max_qty_per_employee int not null check (max_qty_per_employee > 0),
  is_active            boolean not null default true,
  updated_by           uuid,
  updated_at           timestamptz not null default now()
);

create table products (
  id            uuid primary key default gen_random_uuid(),
  barcode       text not null unique,
  name          text not null,
  category_id   uuid references categories(id),
  image_url     text,
  price_piastres int not null default 0 check (price_piastres >= 0),
  stock_qty     int not null default 0 check (stock_qty >= 0),   -- NEVER negative
  is_active     boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index products_category_idx on products(category_id) where is_active;
create index products_name_idx on products(lower(name));

create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger products_touch before update on products for each row execute function touch_updated_at();

create trigger audit_categories after insert or update or delete on categories
  for each row execute function audit_row_change('id');
create trigger audit_category_limits after insert or update or delete on category_daily_limits
  for each row execute function audit_row_change('category_id');
create trigger audit_products after insert or update or delete on products
  for each row execute function audit_row_change('id');

create table stock_movements (
  id          bigint generated always as identity primary key,
  product_id  uuid not null references products(id),
  movement_type text not null check (movement_type in
                ('import','adjustment','order_reserve','order_release','oos_reported')),
  qty_delta   int not null,
  qty_before  int not null,
  qty_after   int not null,
  batch_id    uuid,
  order_id    uuid,
  actor_id    uuid,
  note        text,
  created_at  timestamptz not null default now()
);
create index stock_movements_product_idx on stock_movements(product_id, created_at desc);
create index stock_movements_batch_idx on stock_movements(batch_id);

-- internal: move stock with a history row (caller must hold the product row lock)
create or replace function stock_move(p_product uuid, p_delta int, p_type text, p_batch uuid,
                                      p_order uuid, p_note text) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_before int; v_after int;
begin
  select stock_qty into v_before from products where id = p_product for update;
  v_after := v_before + p_delta;
  if v_after < 0 then raise exception 'INSUFFICIENT_STOCK'; end if;
  update products set stock_qty = v_after where id = p_product;
  insert into stock_movements(product_id, movement_type, qty_delta, qty_before, qty_after, batch_id, order_id, actor_id, note)
  values (p_product, p_type, p_delta, v_before, v_after, p_batch, p_order, auth.uid(), p_note);
  return v_after;
end $$;
revoke all on function stock_move(uuid,int,text,uuid,uuid,text) from public, anon, authenticated;

-- ---------- import batches ----------
create table stock_import_batches (
  id            uuid primary key default gen_random_uuid(),
  file_name     text,
  content_hash  text not null,
  status        text not null default 'preview' check (status in ('preview','confirmed','cancelled')),
  total_rows    int not null default 0,
  new_count     int not null default 0,
  update_count  int not null default 0,
  invalid_count int not null default 0,
  duplicate_of  uuid references stock_import_batches(id),
  created_by    uuid,
  created_at    timestamptz not null default now(),
  confirmed_by  uuid,
  confirmed_at  timestamptz
);
create index stock_import_hash_idx on stock_import_batches(content_hash) where status = 'confirmed';

create table stock_import_items (
  id             bigint generated always as identity primary key,
  batch_id       uuid not null references stock_import_batches(id) on delete cascade,
  row_no         int not null,
  barcode        text,
  name           text,
  category_name  text,
  image_url      text,
  price_piastres int,
  qty            int,
  action         text not null check (action in ('new','update','invalid')),
  error          text,
  product_id     uuid,
  old_qty        int,
  new_qty        int,
  old_price      int,
  unique (batch_id, row_no)
);

-- Step 1: stage + validate + preview (no stock is touched)
create or replace function import_stage(p_file_name text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_batch uuid; v_row jsonb; v_n int := 0; v_barcode text; v_name text; v_cat text; v_img text;
  v_price int; v_qty int; v_err text; v_action text; v_prod products; v_hash text;
  v_new int := 0; v_upd int := 0; v_bad int := 0; v_dup uuid; v_dup_info jsonb;
  v_raw_price text; v_raw_qty text;
begin
  perform require_permission('stock.import');
  perform rate_limit_check('import_stage:' || auth.uid(), 30, 3600);
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then raise exception 'EMPTY_FILE'; end if;
  if jsonb_array_length(p_rows) > 5000 then raise exception 'FILE_TOO_LARGE'; end if;

  insert into stock_import_batches(file_name, content_hash, created_by)
  values (left(coalesce(p_file_name, ''), 200), 'pending', auth.uid()) returning id into v_batch;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_n := v_n + 1; v_err := null; v_price := null; v_qty := null; v_prod := null;
    v_barcode := nullif(btrim(coalesce(v_row ->> 'barcode', '')), '');
    v_name := nullif(btrim(coalesce(v_row ->> 'name', '')), '');
    v_cat  := nullif(btrim(coalesce(v_row ->> 'category', '')), '');
    v_img  := nullif(btrim(coalesce(v_row ->> 'image_url', '')), '');
    v_raw_price := nullif(btrim(coalesce(v_row ->> 'price', '')), '');
    v_raw_qty   := nullif(btrim(coalesce(v_row ->> 'qty', '')), '');
    begin
      if v_raw_price is not null then
        v_price := round(v_raw_price::numeric * 100)::int;
        if v_price < 0 then v_err := 'PRICE_NEGATIVE'; end if;
      end if;
      if v_raw_qty is not null then
        if v_raw_qty::numeric <> trunc(v_raw_qty::numeric) or v_raw_qty::numeric < 0 then v_err := 'QTY_INVALID';
        else v_qty := v_raw_qty::numeric::int; end if;
      end if;
    exception when others then v_err := 'NUMBER_INVALID'; end;
    if v_barcode is null then v_err := 'BARCODE_MISSING'; end if;
    if v_img is not null and v_img !~* '^https?://' then v_err := coalesce(v_err, 'IMAGE_URL_INVALID'); end if;

    if v_barcode is not null then select * into v_prod from products where barcode = v_barcode; end if;
    if v_err is null then
      if v_prod.id is null then
        if v_name is null then v_err := 'NAME_REQUIRED_FOR_NEW'; end if;
        if v_price is null then v_err := coalesce(v_err, 'PRICE_REQUIRED_FOR_NEW'); end if;
      end if;
    end if;

    v_action := case when v_err is not null then 'invalid' when v_prod.id is null then 'new' else 'update' end;
    insert into stock_import_items(batch_id, row_no, barcode, name, category_name, image_url, price_piastres, qty, action,
                                   error, product_id, old_qty, new_qty, old_price)
    values (v_batch, v_n, v_barcode, v_name, v_cat, v_img, v_price, coalesce(v_qty, 0), v_action, v_err, v_prod.id,
            coalesce(v_prod.stock_qty, 0), coalesce(v_prod.stock_qty, 0) + coalesce(v_qty, 0), v_prod.price_piastres);
  end loop;

  -- duplicate barcodes inside the file: mark every occurrence invalid
  update stock_import_items i set action = 'invalid', error = 'DUPLICATE_BARCODE_IN_FILE'
  where i.batch_id = v_batch and i.barcode is not null and i.barcode in (
    select barcode from stock_import_items where batch_id = v_batch and barcode is not null
    group by barcode having count(*) > 1);

  select count(*) filter (where action = 'new'), count(*) filter (where action = 'update'),
         count(*) filter (where action = 'invalid')
    into v_new, v_upd, v_bad from stock_import_items where batch_id = v_batch;

  select encode(sha256(convert_to(coalesce(string_agg(
      coalesce(barcode,'') || '|' || coalesce(qty,0) || '|' || coalesce(price_piastres::text,''), ';' order by barcode, row_no), ''),
      'UTF8')), 'hex') into v_hash from stock_import_items where batch_id = v_batch;

  select id into v_dup from stock_import_batches
   where content_hash = v_hash and status = 'confirmed' order by confirmed_at desc limit 1;
  if v_dup is not null then
    select jsonb_build_object('batch_id', id, 'file_name', file_name, 'confirmed_at', confirmed_at, 'confirmed_by', confirmed_by)
      into v_dup_info from stock_import_batches where id = v_dup;
  end if;

  update stock_import_batches set content_hash = v_hash, total_rows = v_n, new_count = v_new, update_count = v_upd,
         invalid_count = v_bad, duplicate_of = v_dup where id = v_batch;

  return jsonb_build_object('batch_id', v_batch, 'total_rows', v_n, 'new_count', v_new, 'update_count', v_upd,
                            'invalid_count', v_bad, 'duplicate_of', v_dup_info);
end $$;

-- Step 2: confirm. ADDITIVE: new quantity is added to existing stock, never replaced.
create or replace function import_confirm(p_batch uuid, p_allow_duplicate boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_b stock_import_batches; it stock_import_items; v_prod products; v_cat uuid; v_new int := 0; v_upd int := 0;
  v_dup uuid; v_created boolean;
begin
  perform require_permission('stock.import');
  select * into v_b from stock_import_batches where id = p_batch for update;
  if not found then raise exception 'BATCH_NOT_FOUND'; end if;
  if v_b.status <> 'preview' then raise exception 'BATCH_NOT_PENDING'; end if;     -- no silent double import
  if v_b.invalid_count > 0 then raise exception 'BATCH_HAS_INVALID_ROWS'; end if;

  select id into v_dup from stock_import_batches
   where content_hash = v_b.content_hash and status = 'confirmed' and id <> v_b.id limit 1;
  if v_dup is not null and not coalesce(p_allow_duplicate, false) then raise exception 'DUPLICATE_BATCH'; end if;

  v_new := 0; v_upd := 0;
  for it in select * from stock_import_items where batch_id = p_batch order by barcode loop
    v_cat := null; v_created := false;
    if it.category_name is not null then
      insert into categories(name) values (it.category_name) on conflict (name) do nothing;
      select id into v_cat from categories where name = it.category_name;
    end if;
    select * into v_prod from products where barcode = it.barcode for update;
    if not found then
      insert into products(barcode, name, category_id, image_url, price_piastres, stock_qty)
      values (it.barcode, it.name, v_cat, it.image_url, it.price_piastres, 0) returning * into v_prod;
      v_new := v_new + 1; v_created := true;
    else
      update products set
        name = coalesce(it.name, name), category_id = coalesce(v_cat, category_id),
        image_url = coalesce(it.image_url, image_url), price_piastres = coalesce(it.price_piastres, price_piastres)
      where id = v_prod.id;
      v_upd := v_upd + 1;
    end if;
    update stock_import_items set product_id = v_prod.id, old_qty = v_prod.stock_qty,
           new_qty = v_prod.stock_qty + coalesce(it.qty, 0),
           action = case when v_created then 'new' else 'update' end
     where id = it.id;
    if coalesce(it.qty, 0) > 0 then
      perform stock_move(v_prod.id, it.qty, 'import', p_batch, null, 'Excel/CSV import');
    else
      insert into stock_movements(product_id, movement_type, qty_delta, qty_before, qty_after, batch_id, actor_id, note)
      values (v_prod.id, 'import', 0, v_prod.stock_qty, v_prod.stock_qty, p_batch, auth.uid(), 'Import (info update only)');
    end if;
  end loop;

  update stock_import_batches set status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = app_now(),
         new_count = v_new, update_count = v_upd, duplicate_of = v_dup where id = p_batch;
  perform audit_write('stock_import_confirmed', 'stock_import_batches', p_batch::text, null,
      jsonb_build_object('new', v_new, 'updated', v_upd, 'file', v_b.file_name, 'duplicate_allowed', v_dup is not null));
  return jsonb_build_object('batch_id', p_batch, 'new_count', v_new, 'update_count', v_upd);
end $$;

create or replace function import_cancel(p_batch uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform require_permission('stock.import');
  update stock_import_batches set status = 'cancelled' where id = p_batch and status = 'preview';
end $$;

-- Separate, restricted correction tool (can reduce stock). Always logged.
create or replace function stock_adjust(p_product uuid, p_new_qty int, p_reason text) returns int
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_old int; v_after int;
begin
  perform require_permission('stock.adjust');
  if p_new_qty is null or p_new_qty < 0 then raise exception 'INVALID_INPUT'; end if;
  if p_reason is null or length(btrim(p_reason)) < 3 then raise exception 'REASON_REQUIRED'; end if;
  select stock_qty into v_old from products where id = p_product for update;
  if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  v_after := stock_move(p_product, p_new_qty - v_old, 'adjustment', null, null, btrim(p_reason));
  perform audit_write('stock_adjustment', 'products', p_product::text,
                      jsonb_build_object('qty', v_old), jsonb_build_object('qty', v_after, 'reason', p_reason));
  return v_after;
end $$;

-- ---------- product / category admin ----------
create or replace function product_save(p jsonb) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid := nullif(p ->> 'id', '')::uuid; v_barcode text := nullif(btrim(coalesce(p ->> 'barcode','')), '');
        v_name text := nullif(btrim(coalesce(p ->> 'name','')), ''); v_price int := (p ->> 'price_piastres')::int;
        v_img text := nullif(btrim(coalesce(p ->> 'image_url','')), '');
        v_cat uuid := nullif(p ->> 'category_id', '')::uuid; v_active boolean := coalesce((p ->> 'is_active')::boolean, true);
begin
  perform require_permission('products.manage');
  if v_name is null or v_price is null or v_price < 0 then raise exception 'INVALID_INPUT'; end if;
  if v_img is not null and v_img !~* '^https?://' then raise exception 'IMAGE_URL_INVALID'; end if;
  if v_id is null then
    if v_barcode is null then raise exception 'INVALID_INPUT'; end if;
    insert into products(barcode, name, category_id, image_url, price_piastres, is_active)
    values (v_barcode, v_name, v_cat, v_img, v_price, v_active) returning id into v_id;
  else
    update products set name = v_name, category_id = v_cat, image_url = v_img, price_piastres = v_price, is_active = v_active
    where id = v_id;
    if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
  end if;
  return v_id;
end $$;

create or replace function category_save(p jsonb) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid := nullif(p ->> 'id', '')::uuid; v_name text := nullif(btrim(coalesce(p ->> 'name','')), '');
        v_limit int := nullif(p ->> 'daily_limit', '')::int;
begin
  perform require_permission('categories.manage');
  if v_name is null then raise exception 'INVALID_INPUT'; end if;
  if v_id is null then
    insert into categories(name, sort_order, is_active) values (v_name, coalesce((p ->> 'sort_order')::int, 0),
           coalesce((p ->> 'is_active')::boolean, true)) returning id into v_id;
  else
    update categories set name = v_name, sort_order = coalesce((p ->> 'sort_order')::int, sort_order),
           is_active = coalesce((p ->> 'is_active')::boolean, is_active) where id = v_id;
  end if;
  if p ? 'daily_limit' then
    perform require_permission('limits.manage');
    if v_limit is null then delete from category_daily_limits where category_id = v_id;
    else
      if v_limit <= 0 then raise exception 'INVALID_INPUT'; end if;
      insert into category_daily_limits(category_id, max_qty_per_employee, updated_by) values (v_id, v_limit, auth.uid())
      on conflict (category_id) do update set max_qty_per_employee = excluded.max_qty_per_employee,
             updated_by = auth.uid(), updated_at = now(), is_active = true;
    end if;
  end if;
  return v_id;
end $$;
