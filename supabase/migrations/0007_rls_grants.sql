-- =====================================================================
-- 0007_rls_grants.sql | Row Level Security + least-privilege grants.
-- Clients can only READ (through RLS). Every write goes through SECURITY DEFINER RPCs.
-- =====================================================================

create or replace function can_view_order(p_order uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from orders o where o.id = p_order and (
      o.user_id = auth.uid()
      or has_permission('orders.view')
      or (has_permission('picker.work') and exists (select 1 from order_assignments a
            where a.order_id = o.id and a.picker_id = auth.uid() and (a.ended_at is null or a.end_reason = 'completed')))
      or (has_permission('pickup.work') and o.status in ('ready_handover','received_pickup','ready_collection','collected'))))
$$;

-- enable RLS everywhere
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- start from zero privileges for API roles
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- read access
grant select on profiles, user_roles, user_permissions, role_permissions, employees, employee_hrid_registry,
  categories, category_daily_limits, products, stock_movements, stock_import_batches, stock_import_items,
  operating_days, time_slots, bag_pricing, orders, order_items, order_status_history, order_assignments,
  picker_activity, pickers, refunds, wallets, wallet_transactions, notifications, audit_logs, app_settings,
  slot_reservations, employee_category_reservations to authenticated;
-- payments: everything except the raw provider payload
grant select (id, order_id, user_id, purpose, provider, amount_piastres, status, provider_order_id, provider_txn_id, created_at, paid_at)
  on payments to authenticated;

-- policies
create policy profiles_read on profiles for select to authenticated using (id = auth.uid() or has_permission('users.manage'));
create policy user_roles_read on user_roles for select to authenticated using (user_id = auth.uid() or has_permission('users.manage'));
create policy user_perms_read on user_permissions for select to authenticated using (user_id = auth.uid() or has_permission('users.manage'));
create policy role_perms_read on role_permissions for select to authenticated using (true);
create policy employees_read on employees for select to authenticated
  using (user_id = auth.uid() or has_permission('users.manage') or has_permission('orders.view'));
create policy registry_read on employee_hrid_registry for select to authenticated
  using (has_permission('users.manage') or has_permission('employees.import'));
create policy categories_read on categories for select to authenticated using (true);
create policy limits_read on category_daily_limits for select to authenticated using (true);
create policy products_read on products for select to authenticated using (is_active or has_permission('products.manage'));
create policy stock_mov_read on stock_movements for select to authenticated
  using (has_permission('stock.import') or has_permission('products.manage') or has_permission('stock.adjust'));
create policy import_batches_read on stock_import_batches for select to authenticated using (has_permission('stock.import'));
create policy import_items_read on stock_import_items for select to authenticated using (has_permission('stock.import'));
create policy days_read on operating_days for select to authenticated using (true);
create policy slots_read on time_slots for select to authenticated using (true);
create policy bags_read on bag_pricing for select to authenticated using (true);
create policy orders_read on orders for select to authenticated using (user_id = auth.uid() or can_view_order(id));
create policy order_items_read on order_items for select to authenticated using (can_view_order(order_id));
create policy order_hist_read on order_status_history for select to authenticated using (can_view_order(order_id));
create policy assignments_read on order_assignments for select to authenticated
  using (picker_id = auth.uid() or has_permission('orders.view'));
create policy picker_act_read on picker_activity for select to authenticated
  using (picker_id = auth.uid() or has_permission('orders.view'));
create policy pickers_read on pickers for select to authenticated
  using (user_id = auth.uid() or has_permission('orders.view') or has_permission('pickers.manage'));
create policy payments_read on payments for select to authenticated using (user_id = auth.uid() or has_permission('payments.view'));
create policy refunds_read on refunds for select to authenticated
  using (user_id = auth.uid() or has_permission('payments.view') or has_permission('refunds.manage'));
create policy wallets_read on wallets for select to authenticated using (user_id = auth.uid() or has_permission('wallets.manage'));
create policy wallet_tx_read on wallet_transactions for select to authenticated using (user_id = auth.uid() or has_permission('wallets.manage'));
create policy notifications_read on notifications for select to authenticated using (user_id = auth.uid());
create policy audit_read on audit_logs for select to authenticated using (has_permission('audit.view'));
create policy settings_read on app_settings for select to authenticated using (has_permission('settings.manage'));
create policy slot_res_read on slot_reservations for select to authenticated using (has_permission('orders.view'));
create policy cat_res_read on employee_category_reservations for select to authenticated using (has_permission('orders.view'));
-- no policies on rate_limits, payment_webhook_events, presence_heartbeats => no client access at all

-- RPCs callable by signed-in users (each one re-checks identity / permission inside)
grant execute on function
  app_now(), has_role(app_role), has_permission(text), can_view_order(uuid), my_access(), public_settings(),
  link_hrid(text), hrid_import(jsonb), setting_set(text, jsonb),
  admin_set_user_active(uuid, boolean), admin_set_roles(uuid, app_role[]), admin_set_permissions(uuid, text[]), admin_list_users(text, int),
  import_stage(text, jsonb), import_confirm(uuid, boolean), import_cancel(uuid), stock_adjust(uuid, int, text),
  product_save(jsonb), category_save(jsonb), operating_day_set(int, boolean), slot_save(jsonb), bag_price_set(text, int),
  store_status(), available_slots(), my_category_usage(),
  create_order(jsonb, uuid, text, boolean), cancel_order(uuid, boolean), admin_cancel_order(uuid, text, boolean),
  payment_prepare(uuid, text), refund_retry(uuid), admin_wallet_adjust(uuid, int, text), notifications_mark_read(uuid[]),
  picker_set_status(text), picker_start_order(uuid), picker_scan(uuid, text), picker_set_item(uuid, uuid, int, int),
  picker_complete_order(uuid, int, int), admin_reassign_order(uuid, uuid),
  pickup_lookup(text), pickup_receive(uuid), pickup_collect(text),
  heartbeat(), online_users(boolean), dashboard_stats(date, date), admin_search_orders(jsonb), report_sales(date, date),
  wallet_reconcile()
  to authenticated;

-- service role (Edge Functions) needs the internal payment/refund functions
grant execute on all functions in schema public to service_role;
