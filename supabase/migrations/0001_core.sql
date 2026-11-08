-- =====================================================================
-- 0001_core.sql  |  Core: settings, roles/permissions, audit, rate limits,
--                   profiles, HRID registry and employee linking.
-- All writes happen through SECURITY DEFINER functions (RPC). Tables are
-- read-only for clients (see 0007_rls.sql).
-- Money is always integer piastres (1 EGP = 100).
-- =====================================================================

-- ---------- time helper (tests can set app.test_now; unset in production) ----------
create or replace function app_now() returns timestamptz
language sql stable as $$
  select coalesce(nullif(current_setting('app.test_now', true), '')::timestamptz, now())
$$;

-- ---------- settings ----------
create table app_settings (
  key         text primary key,
  value       jsonb not null,
  description text,
  updated_by  uuid,
  updated_at  timestamptz not null default now()
);

insert into app_settings(key, value, description) values
  ('business_day_start',         '"08:00"',  'Start of the business day (Cairo time). Daily category limits reset here.'),
  ('bag_initial_piastres',       '1000',     'Initial shopping bag charge collected at checkout (1000 = EGP 10).'),
  ('fee_bp',                     '100',      'Payment processing fee in basis points on products subtotal (100 = 1%).'),
  ('reassign_minutes',           '10',       'Minutes before an assigned order with no preparation started is re-queued.'),
  ('reservation_expiry_minutes', '15',       'Minutes an unpaid order keeps its stock/slot reserved.'),
  ('min_lead_minutes',           '30',       'Minimum minutes between now and a time slot start.'),
  ('booking_cutoff_time',        '"23:59"',  'Latest Cairo time of day to accept orders.'),
  ('picker_max_active_orders',   '3',        'Max simultaneous active orders per picker.'),
  ('oos_return_to_stock',        'false',    'If true, units marked out-of-stock by a picker return to available stock.'),
  ('max_item_qty',               '50',       'Max quantity of one product in one order.'),
  ('max_order_lines',            '100',      'Max distinct products in one order.');

create or replace function setting_int(p_key text) returns int
language sql stable as $$ select (value #>> '{}')::int from app_settings where key = p_key $$;
create or replace function setting_text(p_key text) returns text
language sql stable as $$ select value #>> '{}' from app_settings where key = p_key $$;
create or replace function setting_bool(p_key text) returns boolean
language sql stable as $$ select (value #>> '{}')::boolean from app_settings where key = p_key $$;

-- business date: the calendar date shifted by the configurable day-start (Cairo time)
create or replace function business_date(p_ts timestamptz default null) returns date
language sql stable as $$
  select ((coalesce(p_ts, app_now()) at time zone 'Africa/Cairo')
          - (setting_text('business_day_start')::time)::interval)::date
$$;

-- ---------- roles & permissions ----------
create type app_role as enum ('super_admin', 'admin', 'employee', 'picker', 'pickup');

create table profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  email      text,
  full_name  text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table user_roles (
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       app_role not null,
  granted_by uuid,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table user_permissions (
  user_id    uuid not null references auth.users(id) on delete cascade,
  permission text not null,
  granted_by uuid,
  created_at timestamptz not null default now(),
  primary key (user_id, permission)
);

create table role_permissions (
  role       app_role not null,
  permission text not null,
  primary key (role, permission)
);
insert into role_permissions values
  ('employee','shop'), ('picker','picker.work'), ('pickup','pickup.work'), ('admin','dashboard.view');

create or replace function has_role(p_role app_role) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from user_roles where user_id = auth.uid() and role = p_role)
$$;

create or replace function has_permission(p_perm text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from profiles where id = auth.uid() and is_active) and (
       exists (select 1 from user_roles where user_id = auth.uid() and role = 'super_admin')
    or exists (select 1 from user_permissions where user_id = auth.uid() and permission = p_perm)
    or exists (select 1 from user_roles ur join role_permissions rp on rp.role = ur.role
               where ur.user_id = auth.uid() and rp.permission = p_perm))
$$;

create or replace function require_permission(p_perm text) returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if not has_permission(p_perm) then raise exception 'FORBIDDEN'; end if;
end $$;

create or replace function require_active() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'NOT_AUTHENTICATED'; end if;
  if not exists (select 1 from profiles where id = auth.uid() and is_active) then
    raise exception 'ACCOUNT_DISABLED';
  end if;
  return auth.uid();
end $$;

-- new auth user => profile + default employee role
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into profiles(id, email, full_name) values (new.id, new.email, new.email);
  insert into user_roles(user_id, role) values (new.id, 'employee');
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function handle_new_user();

-- ---------- audit log ----------
create table audit_logs (
  id          bigint generated always as identity primary key,
  actor_id    uuid,
  action      text not null,
  entity_type text,
  entity_id   text,
  before      jsonb,
  after       jsonb,
  created_at  timestamptz not null default now()
);
create index audit_logs_created_idx on audit_logs(created_at desc);
create index audit_logs_entity_idx on audit_logs(entity_type, entity_id);

create or replace function audit_write(p_action text, p_entity_type text, p_entity_id text,
                                       p_before jsonb, p_after jsonb) returns void
language sql security definer set search_path = public, pg_temp as $$
  insert into audit_logs(actor_id, action, entity_type, entity_id, before, after)
  values (auth.uid(), p_action, p_entity_type, p_entity_id, p_before, p_after)
$$;

create or replace function audit_immutable() returns trigger language plpgsql as $$
begin raise exception 'AUDIT_LOG_IS_IMMUTABLE'; end $$;
create trigger audit_logs_no_change before update or delete on audit_logs
  for each row execute function audit_immutable();

-- generic row-change audit. TG_ARGV[0] = name of the primary-key column
create or replace function audit_row_change() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_key text := tg_argv[0]; v_old jsonb; v_new jsonb; v_id text;
begin
  if tg_op = 'INSERT' then v_new := to_jsonb(new); v_id := v_new ->> v_key;
  elsif tg_op = 'UPDATE' then v_old := to_jsonb(old); v_new := to_jsonb(new); v_id := v_new ->> v_key;
    if v_old = v_new then return new; end if;
  else v_old := to_jsonb(old); v_id := v_old ->> v_key; end if;
  insert into audit_logs(actor_id, action, entity_type, entity_id, before, after)
  values (auth.uid(), lower(tg_op), tg_table_name, v_id, v_old, v_new);
  return coalesce(new, old);
end $$;

create trigger audit_app_settings after insert or update or delete on app_settings
  for each row execute function audit_row_change('key');
create trigger audit_user_roles after insert or update or delete on user_roles
  for each row execute function audit_row_change('user_id');
create trigger audit_user_permissions after insert or update or delete on user_permissions
  for each row execute function audit_row_change('user_id');

-- ---------- rate limiting ----------
create table rate_limits (
  bucket       text primary key,
  window_start timestamptz not null,
  hits         int not null
);

create or replace function rate_limit_check(p_key text, p_max int, p_window_seconds int) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_hits int;
begin
  insert into rate_limits(bucket, window_start, hits) values (p_key, app_now(), 1)
  on conflict (bucket) do update set
    hits = case when app_now() - rate_limits.window_start > make_interval(secs => p_window_seconds)
                then 1 else rate_limits.hits + 1 end,
    window_start = case when app_now() - rate_limits.window_start > make_interval(secs => p_window_seconds)
                then app_now() else rate_limits.window_start end
  returning hits into v_hits;
  if v_hits > p_max then raise exception 'RATE_LIMITED'; end if;
end $$;

-- ---------- HRID registry & employees ----------
create table employee_hrid_registry (
  hrid       text primary key,
  full_name  text not null,
  is_active  boolean not null default true,
  user_id    uuid unique references auth.users(id) on delete set null,
  linked_at  timestamptz,
  created_at timestamptz not null default now()
);

create table employees (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  hrid       text not null unique references employee_hrid_registry(hrid),
  full_name  text not null,
  email      text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create trigger audit_employees after insert or update or delete on employees
  for each row execute function audit_row_change('user_id');
create trigger audit_registry after insert or update or delete on employee_hrid_registry
  for each row execute function audit_row_change('hrid');

create or replace function normalize_hrid(p text) returns text
language sql immutable as $$ select upper(btrim(p)) $$;

-- Admin imports the HR list (HRID + name). Never deletes.
create or replace function hrid_import(p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r jsonb; v_hrid text; v_name text; v_new int := 0; v_upd int := 0; v_bad int := 0; v_exists boolean;
begin
  perform require_permission('employees.import');
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 20000 then raise exception 'INVALID_INPUT'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    v_hrid := normalize_hrid(r ->> 'hrid'); v_name := btrim(coalesce(r ->> 'name', ''));
    if v_hrid is null or v_hrid = '' or v_name = '' then v_bad := v_bad + 1; continue; end if;
    select exists(select 1 from employee_hrid_registry where hrid = v_hrid) into v_exists;
    insert into employee_hrid_registry(hrid, full_name) values (v_hrid, v_name)
      on conflict (hrid) do update set full_name = excluded.full_name;
    update employees set full_name = v_name where hrid = v_hrid and full_name <> v_name;
    if v_exists then v_upd := v_upd + 1; else v_new := v_new + 1; end if;
  end loop;
  perform audit_write('hrid_import', 'employee_hrid_registry', null, null,
    jsonb_build_object('new', v_new, 'updated', v_upd, 'invalid', v_bad));
  return jsonb_build_object('new', v_new, 'updated', v_upd, 'invalid', v_bad);
end $$;

-- Employee links their verified account to a HRID, permanently.
create or replace function link_hrid(p_hrid text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid := require_active(); v_hrid text := normalize_hrid(p_hrid);
        v_reg employee_hrid_registry; v_email text; v_confirmed timestamptz;
begin
  perform rate_limit_check('link_hrid:' || v_uid, 10, 3600);
  select email, email_confirmed_at into v_email, v_confirmed from auth.users where id = v_uid;
  if v_confirmed is null then raise exception 'EMAIL_NOT_VERIFIED'; end if;
  if exists (select 1 from employees where user_id = v_uid) then raise exception 'ALREADY_LINKED'; end if;
  -- NOTE: validation failures are RETURNED (not raised) so the attempt counter above is committed;
  -- a raised exception would roll the counter back and defeat the brute-force protection.
  if v_hrid is null or v_hrid = '' then return jsonb_build_object('ok', false, 'error', 'HRID_INVALID'); end if;

  select * into v_reg from employee_hrid_registry where hrid = v_hrid for update;
  if not found or not v_reg.is_active then return jsonb_build_object('ok', false, 'error', 'HRID_INVALID'); end if;
  if v_reg.user_id is not null then return jsonb_build_object('ok', false, 'error', 'HRID_TAKEN'); end if;

  insert into employees(user_id, hrid, full_name, email) values (v_uid, v_hrid, v_reg.full_name, v_email);
  update employee_hrid_registry set user_id = v_uid, linked_at = app_now() where hrid = v_hrid;
  update profiles set full_name = v_reg.full_name where id = v_uid;
  perform audit_write('hrid_linked', 'employees', v_uid::text, null, jsonb_build_object('hrid', v_hrid));
  return jsonb_build_object('ok', true, 'hrid', v_hrid, 'full_name', v_reg.full_name);
end $$;

-- who am I: roles, permissions, link state (used by the UI router)
create or replace function my_access() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_uid uuid := auth.uid(); v jsonb;
begin
  if v_uid is null then raise exception 'NOT_AUTHENTICATED'; end if;
  select jsonb_build_object(
    'user_id', p.id, 'email', p.email, 'full_name', p.full_name, 'is_active', p.is_active,
    'email_verified', (select email_confirmed_at is not null from auth.users where id = p.id),
    'hrid', (select hrid from employees where user_id = p.id),
    'employee_active', (select is_active from employees where user_id = p.id),
    'roles', coalesce((select jsonb_agg(role) from user_roles where user_id = p.id), '[]'),
    'permissions', coalesce((
        select jsonb_agg(distinct perm) from (
          select permission as perm from user_permissions where user_id = p.id
          union select rp.permission from user_roles ur join role_permissions rp on rp.role = ur.role where ur.user_id = p.id
        ) x), '[]'))
  into v from profiles p where p.id = v_uid;
  return v;
end $$;

-- settings safe for every signed-in user (checkout display)
create or replace function public_settings() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'bag_initial_piastres', setting_int('bag_initial_piastres'),
    'fee_bp', setting_int('fee_bp'),
    'reservation_expiry_minutes', setting_int('reservation_expiry_minutes'),
    'max_item_qty', setting_int('max_item_qty'))
$$;

-- admin: change a setting (validated whitelist)
create or replace function setting_set(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform require_permission('settings.manage');
  if p_key not in ('business_day_start','bag_initial_piastres','fee_bp','reassign_minutes','reservation_expiry_minutes',
                   'min_lead_minutes','booking_cutoff_time','picker_max_active_orders','oos_return_to_stock',
                   'max_item_qty','max_order_lines') then raise exception 'INVALID_INPUT'; end if;
  if p_key in ('business_day_start','booking_cutoff_time') then
    if jsonb_typeof(p_value) <> 'string' or (p_value #>> '{}') !~ '^\d{2}:\d{2}$' then raise exception 'INVALID_INPUT'; end if;
  elsif p_key = 'oos_return_to_stock' then
    if jsonb_typeof(p_value) <> 'boolean' then raise exception 'INVALID_INPUT'; end if;
  else
    if jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}') !~ '^\d+$' then raise exception 'INVALID_INPUT'; end if;
    if p_key = 'fee_bp' and (p_value #>> '{}')::int > 2000 then raise exception 'INVALID_INPUT'; end if;
    if p_key in ('reassign_minutes','reservation_expiry_minutes','picker_max_active_orders') and (p_value #>> '{}')::int < 1 then raise exception 'INVALID_INPUT'; end if;
  end if;
  update app_settings set value = p_value, updated_by = auth.uid(), updated_at = now() where key = p_key;
end $$;

-- ---------- user administration ----------
create or replace function admin_set_user_active(p_user uuid, p_active boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform require_permission('users.manage');
  if p_user = auth.uid() then raise exception 'CANNOT_MODIFY_SELF'; end if;
  if exists (select 1 from user_roles where user_id = p_user and role = 'super_admin') and not has_role('super_admin') then
    raise exception 'FORBIDDEN';
  end if;
  update profiles set is_active = p_active where id = p_user;
  update employees set is_active = p_active where user_id = p_user;
  perform audit_write(case when p_active then 'user_activated' else 'user_deactivated' end, 'profiles', p_user::text, null,
                      jsonb_build_object('is_active', p_active));
end $$;

create or replace function admin_set_roles(p_user uuid, p_roles app_role[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform require_permission('users.manage');
  if not has_role('super_admin') then raise exception 'FORBIDDEN'; end if;
  if p_user = auth.uid() and not ('super_admin' = any(p_roles)) then raise exception 'CANNOT_MODIFY_SELF'; end if;
  delete from user_roles where user_id = p_user and role <> all(p_roles);
  insert into user_roles(user_id, role, granted_by)
    select p_user, r, auth.uid() from unnest(p_roles) r on conflict do nothing;
end $$;

create or replace function admin_set_permissions(p_user uuid, p_perms text[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform require_permission('users.manage');
  if not has_role('super_admin') then raise exception 'FORBIDDEN'; end if;
  delete from user_permissions where user_id = p_user and permission <> all(p_perms);
  insert into user_permissions(user_id, permission, granted_by)
    select p_user, p, auth.uid() from unnest(p_perms) p on conflict do nothing;
end $$;

create or replace function admin_list_users(p_search text default null, p_limit int default 50) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v jsonb;
begin
  perform require_permission('users.manage');
  select coalesce(jsonb_agg(row_to_json(t)), '[]') into v from (
    select p.id, p.email, p.full_name, p.is_active, e.hrid,
           coalesce((select jsonb_agg(role) from user_roles where user_id = p.id), '[]') as roles,
           coalesce((select jsonb_agg(permission) from user_permissions where user_id = p.id), '[]') as permissions
    from profiles p left join employees e on e.user_id = p.id
    where p_search is null or p.email ilike '%' || p_search || '%' or p.full_name ilike '%' || p_search || '%'
          or e.hrid ilike '%' || p_search || '%'
    order by p.created_at desc limit least(coalesce(p_limit, 50), 200)) t;
  return v;
end $$;

-- Bootstrap the very first super admin. Run from the Supabase SQL editor only.
create or replace function bootstrap_super_admin(p_email text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid;
begin
  select id into v_id from auth.users where lower(email) = lower(p_email);
  if v_id is null then raise exception 'USER_NOT_FOUND'; end if;
  insert into user_roles(user_id, role) values (v_id, 'super_admin') on conflict do nothing;
end $$;
revoke all on function bootstrap_super_admin(text) from public, anon, authenticated;
