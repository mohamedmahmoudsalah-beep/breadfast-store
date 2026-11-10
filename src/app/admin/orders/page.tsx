"use client";

import { useState } from "react";
import { AppShell, PageTitle } from "@/components/layout/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, ErrorBox, Field, Modal, Select, Spinner, Td, Textarea, useToast } from "@/components/ui/misc";
import { useAuth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase/client";
import { rpc } from "@/lib/rpc";
import { useLoad } from "@/lib/hooks";
import { ORDER_STATUS_LABEL, STATUS_TONE, cairoDateTime, egp, orderNo } from "@/lib/format";
import { errorMessage } from "@/lib/errors";
import { ExcelButton } from "@/components/ui/file-drop";
import { downloadTable } from "@/lib/export";

type Row = { id: string; order_no: number; status: string; hrid: string; employee_name: string; business_date: string; slot_label: string; created_at: string; total_piastres: number; is_partial: boolean; extra_due_piastres: number; picker_name: string | null; pickup_name: string | null; payment_method: string };
type Picker = { user_id: string; status: string; name: string };
const empty = { from: "", to: "", status: "", hrid: "", employee: "", order_no: "", barcode: "", payment_method: "" };

function Orders() {
  const { can } = useAuth();
  const toast = useToast();
  const [f, setF] = useState(empty);
  const [applied, setApplied] = useState(empty);
  const [sel, setSel] = useState<Row | null>(null);
  const [reason, setReason] = useState("");
  const [toWallet, setToWallet] = useState(false);
  const [picker, setPicker] = useState("");
  const [busy, setBusy] = useState(false);
  const clean = Object.fromEntries(Object.entries(applied).filter(([, v]) => v !== ""));
  const { data, error, loading, reload } = useLoad(async () => {
    const rows = await rpc<Row[]>("admin_search_orders", { p: clean });
    const pk = await getSupabase().from("pickers").select("user_id,status");
    const names = await getSupabase().from("profiles").select("id,full_name,email");
    const pickers: Picker[] = ((pk.data ?? []) as { user_id: string; status: string }[]).map((p) => {
      const n = names.data?.find((x) => x.id === p.user_id);
      return { ...p, name: n?.full_name ?? n?.email ?? p.user_id };
    });
    return { rows, pickers };
  }, [applied]);

  async function run(fn: () => Promise<unknown>, ok: string) {
    if (busy) return; setBusy(true);
    try { await fn(); toast(ok); setSel(null); setReason(""); await reload(); } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  }
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <div className="grid gap-4">
      <form className="grid gap-3 rounded-2xl border border-line bg-white p-4 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); setApplied(f); }}>
        <Field label="من تاريخ"><Input type="date" value={f.from} onChange={set("from")} /></Field>
        <Field label="إلى تاريخ"><Input type="date" value={f.to} onChange={set("to")} /></Field>
        <Field label="الحالة"><Select value={f.status} onChange={set("status")}><option value="">الكل</option>{Object.entries(ORDER_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select></Field>
        <Field label="طريقة الدفع"><Select value={f.payment_method} onChange={set("payment_method")}><option value="">الكل</option><option value="card">كارت</option><option value="wallet">محفظة</option><option value="mixed">مختلط</option></Select></Field>
        <Field label="HRID"><Input value={f.hrid} onChange={set("hrid")} dir="ltr" /></Field>
        <Field label="اسم الموظف"><Input value={f.employee} onChange={set("employee")} /></Field>
        <Field label="رقم الطلب"><Input value={f.order_no} onChange={set("order_no")} inputMode="numeric" dir="ltr" /></Field>
        <Field label="باركود منتج"><Input value={f.barcode} onChange={set("barcode")} dir="ltr" /></Field>
        <div className="flex gap-2 sm:col-span-4"><Button type="submit">بحث</Button><Button type="button" variant="ghost" onClick={() => { setF(empty); setApplied(empty); }}>مسح</Button>
          {data && <ExcelButton onClick={() => downloadTable("orders.xlsx", "Orders", [
            { header: "Order", value: (o: Row) => (o.order_no ? `BF-${o.order_no}` : "") }, { header: "Employee", value: (o: Row) => o.employee_name }, { header: "HRID", value: (o: Row) => o.hrid },
            { header: "Date", value: (o: Row) => o.business_date }, { header: "Slot", value: (o: Row) => o.slot_label }, { header: "Status", value: (o: Row) => o.status },
            { header: "Total (EGP)", value: (o: Row) => o.total_piastres / 100 }, { header: "Payment", value: (o: Row) => o.payment_method }, { header: "Picker", value: (o: Row) => o.picker_name }, { header: "Pickup", value: (o: Row) => o.pickup_name }], data.rows)}>تنزيل Excel</ExcelButton>}</div>
      </form>
      {loading && !data ? <Spinner /> : error || !data ? <ErrorBox message={error ?? "خطأ"} onRetry={reload} /> : (
        <DataTable head={["الطلب", "الموظف", "اليوم", "الموعد", "الحالة", "الإجمالي", "الدفع", "المجهّز", "الاستلام", ""]}>
          {data.rows.map((o) => (
            <tr key={o.id}>
              <Td><b>{orderNo(o.order_no)}</b>{o.is_partial && <Badge tone="warning" className="ms-2">جزئي</Badge>}</Td>
              <Td>{o.employee_name} <span className="text-muted" dir="ltr">({o.hrid})</span></Td><Td>{o.business_date}</Td><Td>{o.slot_label}</Td>
              <Td><Badge tone={STATUS_TONE[o.status] ?? "neutral"}>{ORDER_STATUS_LABEL[o.status]}</Badge></Td><Td>{egp(o.total_piastres)}</Td>
              <Td>{o.payment_method}</Td><Td>{o.picker_name ?? "—"}</Td><Td>{o.pickup_name ?? "—"}</Td>
              <Td>{can("orders.manage") && <Button size="sm" variant="secondary" onClick={() => { setSel(o); setPicker(""); }}>إدارة</Button>}</Td>
            </tr>
          ))}
        </DataTable>
      )}
      <Modal open={Boolean(sel)} title={sel ? `${orderNo(sel.order_no)} — ${sel.employee_name}` : ""} onClose={() => setSel(null)}>
        {sel && (
          <div className="grid gap-4">
            <p className="text-sm text-muted">{cairoDateTime(sel.created_at)}</p>
            {["waiting_picker", "assigned", "preparing"].includes(sel.status) && (
              <div className="grid gap-2 rounded-xl bg-surface p-3">
                <b>إعادة تعيين المجهّز</b>
                <Select value={picker} onChange={(e) => setPicker(e.target.value)}>
                  <option value="">إرجاع للطابور (توزيع تلقائي)</option>
                  {data?.pickers.map((p) => <option key={p.user_id} value={p.user_id}>{p.name} ({p.status})</option>)}
                </Select>
                <Button variant="secondary" loading={busy} onClick={() => run(() => rpc("admin_reassign_order", { p_order: sel.id, p_picker: picker || null }), "تمت إعادة التعيين")}>تنفيذ</Button>
              </div>
            )}
            {!["collected", "canceled", "expired"].includes(sel.status) && (
              <div className="grid gap-2 rounded-xl bg-red-50 p-3">
                <b className="text-danger">إلغاء الطلب (استثناء إداري)</b>
                <Field label="السبب (إجباري)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={toWallet} onChange={(e) => setToWallet(e.target.checked)} /> الاسترداد للمحفظة بدل البطاقة</label>
                <Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={() => run(async () => { await rpc("admin_cancel_order", { p_order: sel.id, p_reason: reason, p_refund_to_wallet: toWallet }); }, "تم إلغاء الطلب")}>إلغاء الطلب</Button>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

export default function AdminOrders() {
  return <AppShell guard={{ employee: false, perm: "orders.view" }}><PageTitle title="متابعة الطلبات" /><Orders /></AppShell>;
}
