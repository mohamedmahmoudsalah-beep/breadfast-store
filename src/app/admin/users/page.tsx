"use client";

import { useState } from "react";
import { AppShell, PageTitle } from "@/components/layout/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DataTable, ErrorBox, Field, Modal, Spinner, Td, useToast } from "@/components/ui/misc";
import { useAuth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase/client";
import { rpc } from "@/lib/rpc";
import { mapRows, readTable } from "@/lib/files";
import { useDebounced, useLoad } from "@/lib/hooks";
import { errorMessage } from "@/lib/errors";

type U = { id: string; email: string; full_name: string | null; is_active: boolean; hrid: string | null; roles: string[]; permissions: string[] };
const ROLES = [["employee", "موظف"], ["picker", "مجهّز"], ["pickup", "موظف استلام"], ["admin", "مسؤول"], ["super_admin", "سوبر أدمن"]] as const;
const PERMS: [string, string][] = [
  ["dashboard.view", "عرض لوحة التحكم"], ["orders.view", "عرض الطلبات"], ["orders.manage", "إدارة الطلبات (إلغاء/إعادة تعيين)"], ["products.manage", "إدارة المنتجات"],
  ["stock.import", "استيراد المخزون"], ["stock.adjust", "تصحيح المخزون"], ["categories.manage", "إدارة الأقسام"], ["limits.manage", "الحدود اليومية"],
  ["schedule.manage", "المواعيد وأيام العمل"], ["settings.manage", "الإعدادات"], ["bags.manage", "أسعار الأكياس"], ["payments.view", "عرض المدفوعات"],
  ["refunds.manage", "إدارة الاستردادات"], ["wallets.manage", "تعديل المحافظ"], ["reports.export", "تصدير التقارير"], ["users.manage", "إدارة المستخدمين"],
  ["employees.import", "استيراد سجل الموظفين"], ["pickers.manage", "إدارة المجهّزين"], ["audit.view", "سجل المراجعة"],
];

function Users() {
  const { hasRole, access } = useAuth();
  const isSuper = hasRole("super_admin");
  const toast = useToast();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [sel, setSel] = useState<U | null>(null);
  const [roles, setRoles] = useState<string[]>([]);
  const [perms, setPerms] = useState<string[]>([]);
  const [hrid, setHrid] = useState("");
  const [busy, setBusy] = useState(false);
  const [create, setCreate] = useState({ email: "", password: "", hrid: "" });
  const [showCreate, setShowCreate] = useState(false);
  const { data, error, loading, reload } = useLoad(() => rpc<U[]>("admin_list_users", { p_search: q || null, p_limit: 100 }), [q]);

  async function run(fn: () => Promise<unknown>, ok: string, close = true) {
    if (busy) return; setBusy(true);
    try { await fn(); toast(ok); if (close) setSel(null); await reload(); } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  }
  async function importHrid(file: File | undefined) {
    if (!file) return;
    try {
      const { rows, missing } = mapRows(await readTable(file), ["hrid", "emp_name"]);
      if (missing.length) { toast("الملف لازم يحتوي على عمودي HRID واسم الموظف.", "error"); return; }
      const r = await rpc<{ new: number; updated: number; invalid: number }>("hrid_import", { p_rows: rows.map((x) => ({ hrid: x.hrid, name: x.emp_name })) });
      toast(`جديد ${r.new} • تحديث ${r.updated} • أخطاء ${r.invalid}`);
    } catch (e) { toast(e instanceof Error && /[؀-ۿ]/.test(e.message) ? e.message : errorMessage(e), "error"); }
  }
  async function createUser() {
    if (busy) return; setBusy(true);
    try {
      const { data: res, error: err } = await getSupabase().functions.invoke("admin-create-user", { body: create });
      if (err) { let m = ""; try { m = (await (err as { context?: Response }).context?.json())?.error ?? ""; } catch { /* */ } throw new Error(m || "CREATE_FAILED"); }
      toast(`تم إنشاء الحساب ${(res as { email?: string })?.email ?? ""}`); setShowCreate(false); setCreate({ email: "", password: "", hrid: "" }); await reload();
    } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  }
  const toggle = (arr: string[], v: string) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  return (
    <div className="grid gap-4">
      <Card className="grid gap-3">
        <h2 className="font-bold">سجل الموظفين (HRID)</h2>
        <p className="text-sm text-muted">ارفع ملف Excel/CSV فيه عمودين: HRID واسم الموظف. الاستيراد بيضيف ويحدّث الأسماء ولا يحذف أبدًا.</p>
        <input type="file" accept=".xlsx,.csv" onChange={(e) => { void importHrid(e.target.files?.[0]); e.target.value = ""; }} />
      </Card>
      <div className="flex flex-wrap gap-3">
        <Input className="max-w-sm" placeholder="بحث بالاسم أو البريد أو HRID" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Button onClick={() => setShowCreate(true)}>+ إنشاء حساب</Button>
      </div>
      {loading && !data ? <Spinner /> : error || !data ? <ErrorBox message={error ?? "خطأ"} onRetry={reload} /> : (
        <DataTable head={["الاسم", "البريد", "HRID", "الأدوار", "الحالة", ""]}>
          {data.map((u) => (
            <tr key={u.id}><Td>{u.full_name}</Td><Td dir="ltr">{u.email}</Td><Td dir="ltr">{u.hrid ?? "—"}</Td>
              <Td>{u.roles.map((r) => ROLES.find((x) => x[0] === r)?.[1] ?? r).join("، ")}</Td>
              <Td><Badge tone={u.is_active ? "success" : "danger"}>{u.is_active ? "نشط" : "موقوف"}</Badge></Td>
              <Td><Button size="sm" variant="secondary" onClick={() => { setSel(u); setRoles(u.roles); setPerms(u.permissions); setHrid(""); }}>إدارة</Button></Td></tr>
          ))}
        </DataTable>
      )}
      <Modal open={Boolean(sel)} title={sel?.full_name ?? sel?.email ?? ""} onClose={() => setSel(null)}>
        {sel && (
          <div className="grid gap-4">
            <p className="text-sm text-muted" dir="ltr">{sel.email}</p>
            {sel.id !== access?.user_id && (
              <Button variant={sel.is_active ? "danger" : "primary"} loading={busy} onClick={() => run(() => rpc("admin_set_user_active", { p_user: sel.id, p_active: !sel.is_active }), sel.is_active ? "تم إيقاف الحساب" : "تم تفعيل الحساب")}>{sel.is_active ? "إيقاف الحساب" : "تفعيل الحساب"}</Button>
            )}
            {!sel.hrid && (
              <div className="grid gap-2 rounded-xl bg-surface p-3"><b>ربط بـ HRID</b>
                <Input value={hrid} onChange={(e) => setHrid(e.target.value)} dir="ltr" placeholder="HRID" />
                <Button variant="secondary" loading={busy} disabled={!hrid.trim()} onClick={() => run(async () => { const r = await rpc<{ ok: boolean }>("admin_link_hrid", { p_user: sel.id, p_hrid: hrid }); if (!r.ok) throw new Error("HRID_INVALID"); }, "تم الربط")}>ربط</Button></div>
            )}
            {isSuper && (<>
              <div><b>الأدوار</b><div className="mt-2 flex flex-wrap gap-2">{ROLES.map(([k, l]) => <label key={k} className="flex items-center gap-1 rounded-lg border border-line px-3 py-1"><input type="checkbox" checked={roles.includes(k)} onChange={() => setRoles(toggle(roles, k))} />{l}</label>)}</div>
                <Button className="mt-2" size="sm" variant="secondary" loading={busy} onClick={() => run(() => rpc("admin_set_roles", { p_user: sel.id, p_roles: roles }), "تم حفظ الأدوار", false)}>حفظ الأدوار</Button></div>
              <div><b>صلاحيات إضافية</b><div className="mt-2 grid gap-1 sm:grid-cols-2">{PERMS.map(([k, l]) => <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={perms.includes(k)} onChange={() => setPerms(toggle(perms, k))} />{l}</label>)}</div>
                <Button className="mt-2" size="sm" variant="secondary" loading={busy} onClick={() => run(() => rpc("admin_set_permissions", { p_user: sel.id, p_perms: perms }), "تم حفظ الصلاحيات", false)}>حفظ الصلاحيات</Button></div>
            </>)}
          </div>
        )}
      </Modal>
      <Modal open={showCreate} title="إنشاء حساب موظف" onClose={() => setShowCreate(false)}>
        <div className="grid gap-3">
          <Field label="البريد الإلكتروني"><Input type="email" dir="ltr" value={create.email} onChange={(e) => setCreate({ ...create, email: e.target.value })} /></Field>
          <Field label="كلمة مرور مؤقتة" hint="8 حروف على الأقل. اطلب من الموظف تغييرها."><Input type="text" dir="ltr" value={create.password} onChange={(e) => setCreate({ ...create, password: e.target.value })} /></Field>
          <Field label="HRID (اختياري)"><Input dir="ltr" value={create.hrid} onChange={(e) => setCreate({ ...create, hrid: e.target.value })} /></Field>
          <Button loading={busy} disabled={!create.email || create.password.length < 8} onClick={createUser}>إنشاء</Button>
        </div>
      </Modal>
    </div>
  );
}
export default function AdminUsers() { return <AppShell guard={{ employee: false, perm: "users.manage" }}><PageTitle title="المستخدمون والصلاحيات" /><Users /></AppShell>; }
