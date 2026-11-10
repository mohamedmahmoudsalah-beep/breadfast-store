"use client";

import { useState } from "react";
import { AppShell, PageTitle } from "@/components/layout/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, ErrorBox, Field, Modal, Spinner, Td, useToast } from "@/components/ui/misc";
import { useAuth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase/client";
import { rpc } from "@/lib/rpc";
import { useLoad } from "@/lib/hooks";
import { ExcelButton } from "@/components/ui/file-drop";
import { downloadTable } from "@/lib/export";
import { errorMessage } from "@/lib/errors";

type Cat = { id: string; name: string; sort_order: number; is_active: boolean; is_system: boolean; limit: number | null };

function Categories() {
  const { can } = useAuth();
  const toast = useToast();
  const [edit, setEdit] = useState<{ id: string; name: string; sort_order: string; is_active: boolean; limit: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, error, loading, reload } = useLoad(async () => {
    const [c, l] = await Promise.all([getSupabase().from("categories").select("id,name,sort_order,is_active,is_system").order("sort_order").order("name"), getSupabase().from("category_daily_limits").select("category_id,max_qty_per_employee")]);
    if (c.error) throw c.error;
    return (c.data ?? []).map((x) => ({ ...x, limit: l.data?.find((y) => y.category_id === x.id)?.max_qty_per_employee ?? null })) as Cat[];
  });
  async function save() {
    if (!edit || busy) return; setBusy(true);
    try {
      const p: Record<string, unknown> = { id: edit.id || null, name: edit.name, sort_order: Number(edit.sort_order || 0), is_active: edit.is_active };
      if (can("limits.manage")) p.daily_limit = edit.limit === "" ? null : Number(edit.limit);
      await rpc("category_save", { p }); toast("تم الحفظ"); setEdit(null); await reload();
    } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  }
  if (loading && !data) return <Spinner />;
  if (error || !data) return <ErrorBox message={error ?? "خطأ"} onRetry={reload} />;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-3"><Button onClick={() => setEdit({ id: "", name: "", sort_order: "0", is_active: true, limit: "" })}>+ قسم جديد</Button>
        <ExcelButton onClick={() => downloadTable("categories.xlsx", "Categories", [{ header: "Category", value: (c: Cat) => c.name }, { header: "Daily Limit", value: (c: Cat) => c.limit }], data)}>تنزيل Excel</ExcelButton>
        <a className="self-center text-sm font-semibold text-brand-600 underline" href="/admin/import/">رفع الحدود من Excel ←</a></div>
      <p className="text-sm text-muted">الحد اليومي = أقصى عدد وحدات لكل موظف في اليوم التجاري من القسم (بيتجمع على كل طلبات اليوم). الأقسام بتتعمل تلقائيًا من ملف المنتجات. قسم «null» (منتجات بدون قسم) حدّه ثابت قطعتين.</p>
      <DataTable head={["القسم", "الترتيب", "الحد اليومي لكل موظف", "الحالة", ""]}>
        {data.map((c) => <tr key={c.id}><Td>{c.name}</Td><Td>{c.sort_order}</Td><Td>{c.limit ?? "بدون حد"}</Td><Td><Badge tone={c.is_active ? "success" : "neutral"}>{c.is_active ? "نشط" : "موقوف"}</Badge></Td>
          <Td>{c.is_system ? <Badge tone="neutral">ثابت (قطعتين)</Badge> : <Button size="sm" variant="secondary" onClick={() => setEdit({ id: c.id, name: c.name, sort_order: String(c.sort_order), is_active: c.is_active, limit: c.limit === null ? "" : String(c.limit) })}>تعديل</Button>}</Td></tr>)}
      </DataTable>
      <Modal open={Boolean(edit)} title={edit?.id ? "تعديل قسم" : "قسم جديد"} onClose={() => setEdit(null)}>
        {edit && <div className="grid gap-3">
          <Field label="اسم القسم"><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
          <Field label="الترتيب"><Input type="number" value={edit.sort_order} onChange={(e) => setEdit({ ...edit, sort_order: e.target.value })} /></Field>
          {can("limits.manage") && <Field label="الحد اليومي لكل موظف" hint="اتركه فاضي لإلغاء الحد"><Input type="number" min={1} value={edit.limit} onChange={(e) => setEdit({ ...edit, limit: e.target.value })} /></Field>}
          <label className="flex items-center gap-2"><input type="checkbox" checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> ظاهر في المتجر</label>
          <Button loading={busy} onClick={save}>حفظ</Button>
        </div>}
      </Modal>
    </div>
  );
}
export default function AdminCategories() { return <AppShell guard={{ employee: false, perm: "categories.manage" }}><PageTitle title="الأقسام والحدود اليومية" /><Categories /></AppShell>; }
