-- =====================================================================
-- 0003_schedule.sql | Operating days, time slots (capacity), bag prices.
-- All time maths use Africa/Cairo.
-- =====================================================================

create table operating_days (
  weekday    smallint primary key check (weekday between 1 and 7),   -- ISO: 1 = Monday ... 7 = Sunday
  is_enabled boolean not null default false
);
insert into operating_days(weekday, is_enabled) values (1,true),(2,false),(3,false),(4,true),(5,false),(6,false),(7,false);

create table time_slots (
  id         uuid primary key default gen_random_uuid(),
  label      text not null,
  start_time time not null,
  end_time   time not null,
  capacity   int  not null check (capacity >= 0),
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  check (end_time > start_time)
);

create table bag_pricing (
  bag_type       text primary key check (bag_type in ('small','large')),
  price_piastres int not null check (price_piastres >= 0),
  updated_by     uuid,
  updated_at     timestamptz not null default now()
);
-- temporary defaults (EGP 3 / EGP 6): set the real prices from the admin settings page.
insert into bag_pricing(bag_type, price_piastres) values ('small', 300), ('large', 600);

create trigger audit_operating_days after insert or update or delete on operating_days
  for each row execute function audit_row_change('weekday');
create trigger audit_time_slots after insert or update or delete on time_slots
  for each row execute function audit_row_change('id');
create trigger audit_bag_pricing after insert or update or delete on bag_pricing
  for each row execute function audit_row_change('bag_type');

create or replace function operating_day_set(p_weekday int, p_enabled boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform require_permission('schedule.manage');
  update operating_days set is_enabled = p_enabled where weekday = p_weekday;
  if not found then raise exception 'INVALID_INPUT'; end if;
end $$;

create or replace function slot_save(p jsonb) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid := nullif(p ->> 'id','')::uuid; v_label text := nullif(btrim(coalesce(p ->> 'label','')),'');
        v_start time := (p ->> 'start_time')::time; v_end time := (p ->> 'end_time')::time;
        v_cap int := (p ->> 'capacity')::int; v_active boolean := coalesce((p ->> 'is_active')::boolean, true);
begin
  perform require_permission('schedule.manage');
  if v_label is null or v_start is null or v_end is null or v_cap is null or v_cap < 0 or v_end <= v_start then
    raise exception 'INVALID_INPUT';
  end if;
  if v_start < setting_text('business_day_start')::time then raise exception 'SLOT_BEFORE_BUSINESS_DAY_START'; end if;
  if v_id is null then
    insert into time_slots(label, start_time, end_time, capacity, is_active) values (v_label, v_start, v_end, v_cap, v_active)
    returning id into v_id;
  else
    update time_slots set label = v_label, start_time = v_start, end_time = v_end, capacity = v_cap, is_active = v_active
    where id = v_id;
    if not found then raise exception 'NOT_FOUND'; end if;
  end if;
  return v_id;
end $$;

create or replace function bag_price_set(p_type text, p_price int) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform require_permission('bags.manage');
  if p_price is null or p_price < 0 then raise exception 'INVALID_INPUT'; end if;
  update bag_pricing set price_piastres = p_price, updated_by = auth.uid(), updated_at = now() where bag_type = p_type;
  if not found then raise exception 'INVALID_INPUT'; end if;
end $$;

-- Is the store accepting orders right now?
create or replace function store_status() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_bd date := business_date(); v_enabled boolean; v_open boolean := true; v_reason text;
        v_local time := (app_now() at time zone 'Africa/Cairo')::time; v_cutoff time := setting_text('booking_cutoff_time')::time;
begin
  select is_enabled into v_enabled from operating_days where weekday = extract(isodow from v_bd)::int;
  if not coalesce(v_enabled, false) then v_open := false; v_reason := 'DAY_DISABLED';
  elsif v_local > v_cutoff then v_open := false; v_reason := 'AFTER_CUTOFF'; end if;
  return jsonb_build_object('open', v_open, 'reason', v_reason, 'business_date', v_bd,
    'next_enabled_weekdays', coalesce((select jsonb_agg(weekday order by weekday) from operating_days where is_enabled), '[]'));
end $$;

-- Eligible future slots for today's business date, with live capacity
create or replace function available_slots() returns table (
  slot_id uuid, label text, start_time time, end_time time, slot_date date, capacity int, booked int, remaining int, can_book boolean)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_st jsonb := store_status(); v_bd date := business_date(); v_lead int := setting_int('min_lead_minutes');
begin
  if not (v_st ->> 'open')::boolean then return; end if;
  return query
  select s.id, s.label, s.start_time, s.end_time, v_bd, s.capacity,
         coalesce(b.cnt, 0)::int, greatest(s.capacity - coalesce(b.cnt, 0), 0)::int,
         (s.capacity - coalesce(b.cnt, 0)) > 0
  from time_slots s
  left join lateral (select count(*) cnt from slot_reservations r
                     where r.slot_id = s.id and r.slot_date = v_bd and r.status in ('held','confirmed')) b on true
  where s.is_active
    and ((v_bd + s.start_time) at time zone 'Africa/Cairo') >= app_now() + make_interval(mins => v_lead)
  order by s.start_time;
end $$;
