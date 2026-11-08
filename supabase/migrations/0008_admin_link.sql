-- Admin links an (admin-created) account to a HRID on the employee's behalf.
create or replace function admin_link_hrid(p_user uuid, p_hrid text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_hrid text := normalize_hrid(p_hrid); v_reg employee_hrid_registry; v_email text;
begin
  perform require_permission('users.manage');
  select email into v_email from auth.users where id = p_user;
  if v_email is null then raise exception 'USER_NOT_FOUND'; end if;
  if exists (select 1 from employees where user_id = p_user) then raise exception 'ALREADY_LINKED'; end if;
  select * into v_reg from employee_hrid_registry where hrid = v_hrid for update;
  if not found or not v_reg.is_active then raise exception 'HRID_INVALID'; end if;
  if v_reg.user_id is not null then raise exception 'HRID_TAKEN'; end if;
  insert into employees(user_id, hrid, full_name, email) values (p_user, v_hrid, v_reg.full_name, v_email);
  update employee_hrid_registry set user_id = p_user, linked_at = app_now() where hrid = v_hrid;
  update profiles set full_name = v_reg.full_name where id = p_user;
  perform audit_write('hrid_linked_by_admin', 'employees', p_user::text, null, jsonb_build_object('hrid', v_hrid));
  return jsonb_build_object('ok', true, 'hrid', v_hrid);
end $$;
grant execute on function admin_link_hrid(uuid, text) to authenticated;
revoke execute on function admin_link_hrid(uuid, text) from anon, public;

-- A card refund the gateway could not process automatically (e.g. same-day void) was completed by hand
-- in the Paymob dashboard: record that here so the books and the employee's notification are correct.
create or replace function refund_mark_manual(p_refund uuid, p_note text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare r refunds;
begin
  perform require_permission('refunds.manage');
  if p_note is null or length(btrim(p_note)) < 3 then raise exception 'REASON_REQUIRED'; end if;
  update refunds set status = 'completed', completed_at = now(), last_error = 'manual: ' || left(btrim(p_note), 300)
   where id = p_refund and status in ('failed','pending') returning * into r;
  if found then
    perform audit_write('refund_marked_manual', 'refunds', p_refund::text, null, jsonb_build_object('note', p_note));
    perform notify(r.user_id, 'refund_completed', r.order_id, 'تم رد ' || (r.amount_piastres / 100.0)::numeric(12,2) || ' ج.م');
  end if;
end $$;
grant execute on function refund_mark_manual(uuid, text) to authenticated;
revoke execute on function refund_mark_manual(uuid, text) from anon, public;
