-- 0010: a separate PRICES sheet (barcode + product name + price). Products with no price stay hidden until priced.
alter table stock_import_batches drop constraint if exists stock_import_batches_mode_check;
alter table stock_import_batches add constraint stock_import_batches_mode_check check (mode in ('catalog','stock','price'));

create or replace function import_stage(p_file_name text, p_rows jsonb, p_mode text default 'stock') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_mode text := coalesce(p_mode, 'stock');
  v_batch uuid; v_row jsonb; v_n int := 0; v_barcode text; v_name text; v_cat text; v_img text;
  v_price int; v_qty int; v_err text; v_action text; v_prod products; v_hash text;
  v_new int := 0; v_upd int := 0; v_bad int := 0; v_dup uuid; v_dup_info jsonb; v_raw_price text; v_raw_qty text;
begin
  if v_mode not in ('catalog','stock','price') then raise exception 'INVALID_INPUT'; end if;
  perform require_permission(case when v_mode in ('catalog','price') then 'products.manage' else 'stock.import' end);
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
      if v_mode in ('catalog','price') and v_raw_price is not null then
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
      elsif v_mode = 'price' then
        if v_raw_price is null then v_err := 'PRICE_REQUIRED';
        elsif v_prod.id is null then v_err := 'PRODUCT_NOT_FOUND'; end if;
      else
        if v_raw_qty is null then v_err := 'QTY_REQUIRED';
        elsif v_prod.id is null then v_err := 'PRODUCT_NOT_FOUND'; end if;
      end if;
    end if;
    if v_mode in ('stock','price') then v_name := coalesce(v_prod.name, v_name); v_cat := null; v_img := null; end if;

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
  perform require_permission(case when v_b.mode in ('catalog','price') then 'products.manage' else 'stock.import' end);
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
               image_url = coalesce(it.image_url, image_url), price_piastres = coalesce(it.price_piastres, price_piastres),
               is_active = case when price_piastres = 0 and coalesce(it.price_piastres, 0) > 0 then true else is_active end
         where id = v_prod.id;
        v_upd := v_upd + 1;
        update stock_import_items set product_id = v_prod.id, action = 'update' where id = it.id;
      end if;
    elsif v_b.mode = 'price' then
      select * into v_prod from products where barcode = it.barcode for update;
      if not found then raise exception 'PRODUCT_NOT_FOUND'; end if;
      -- a product that had NO price becomes visible in the store as soon as it gets one
      update products set price_piastres = it.price_piastres,
             is_active = case when price_piastres = 0 then true else is_active end
       where id = v_prod.id;
      update stock_import_items set product_id = v_prod.id, old_price = v_prod.price_piastres, action = 'update' where id = it.id;
      v_upd := v_upd + 1;
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
