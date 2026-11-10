"use client";

import { AppShell, PageTitle } from "@/components/layout/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExcelButton } from "@/components/ui/file-drop";
import { DataTable, ErrorBox, Spinner, Td, useToast } from "@/components/ui/misc";
import { useAuth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase/client";
import { rpc } from "@/lib/rpc";
import { useLoad } from "@/lib/hooks";
import { downloadTable } from "@/lib/export";
import { cairoDateTime, egp } from "@/lib/format";
import { errorMessage } from "@/lib/errors";
import { useState } from "react";

type Pay = { id: string; order_id: string; purpose: string; amount_piastres: number; status: string; created_at: string; provider_txn_id: string | null };
type Ref = { id: string; order_id: string; method: string; amount_piastres: number; status: string; kind: string; last_error: string | null; created_at: string };
const REF_STATUS: Record<string, string> = { pending: "قيد المعالجة (تلقائي)", processing: "جاري التحويل", completed: "تم", failed: "فشل — يحتاج تدخل" };

function Finance() {
  const { can } = useAuth();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const { data, error, loading, reload } = useLoad(async () => {
    const s = getSupabase();
    const [p, r] = await Promise.all([
      s.from("payments").select("id,order_id,purpose,amount_piastres,status,created_at,provider_txn_id").order("created_at", { ascending: false }).limit(200),
      s.from("refunds").select("id,order_id,method,amount_piastres,status,kind,last_error,created_at").order("created_at", { ascending: false }).limit(200),
    ]);
    if (p.error) throw p.error;
    return { pay: (p.data ?? []) as Pay[], ref: (r.data ?? []) as Ref[] };
  });
  async function run(fn: () => Promise<unknown>, ok: string) { if (busy) return; setBusy(true); try { await fn(); toast(ok); await reload(); } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); } }
  if (loading && !data) return <Spinner />;
  if (error || !data) return <ErrorBox message={error ?? "خطأ"} onRetry={reload} />;
  const tone = (s: string) => (s === "paid" || s === "completed" ? "success" : s === "failed" || s === "mismatch" ? "danger" : "warning");
  return (
    <div className="grid gap-5">
      <p className="rounded-xl bg-brand-50 p-3 text-sm text-brand-800">الاستردادات على الكارت بتتبعت لـ Paymob <b>تلقائيًا</b> (فورًا ثم كل دقيقة لو في معلّق). مش محتاج تضغط أي حاجة. الزر الوحيد اللي بيظهر هو لو العملية فشلت وتحتاج تدخل.</p>
      <div className="flex items-center justify-between"><h2 className="text-lg">الاستردادات</h2>
        <ExcelButton onClick={() => downloadTable("refunds.xlsx", "Refunds", [{ header: "Time", value: (r: Ref) => r.created_at }, { header: "Kind", value: (r: Ref) => r.kind }, { header: "Method", value: (r: Ref) => r.method }, { header: "Amount (EGP)", value: (r: Ref) => r.amount_piastres / 100 }, { header: "Status", value: (r: Ref) => r.status }, { header: "Note", value: (r: Ref) => r.last_error }], data.ref)}>تنزيل Excel</ExcelButton></div>
      <DataTable head={["الوقت", "النوع", "الطريقة", "المبلغ", "الحالة", "ملاحظة", ""]}>
        {data.ref.map((r) => <tr key={r.id}><Td>{cairoDateTime(r.created_at)}</Td><Td>{r.kind}</Td><Td>{r.method === "card" ? "بطاقة" : "محفظة"}</Td><Td>{egp(r.amount_piastres)}</Td>
          <Td><Badge tone={tone(r.status)}>{REF_STATUS[r.status] ?? r.status}</Badge></Td><Td className="max-w-xs truncate">{r.last_error}</Td>
          <Td>{r.method === "card" && r.status === "failed" && can("refunds.manage") && (
            <span className="flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => run(() => rpc("refund_retry", { p_refund: r.id }), "تمت إعادة المحاولة (تلقائي)")}>إعادة محاولة</Button>
              <Button size="sm" variant="ghost" onClick={() => { const note = prompt("اكتب ملاحظة (مثال: تم الرد يدويًا من لوحة Paymob برقم ...)"); if (note) void run(() => rpc("refund_mark_manual", { p_refund: r.id, p_note: note }), "تم تسجيل الرد اليدوي"); }}>تم الرد يدويًا</Button>
            </span>)}</Td></tr>)}
      </DataTable>
      <div className="flex items-center justify-between"><h2 className="text-lg">المدفوعات</h2>
        <ExcelButton onClick={() => downloadTable("payments.xlsx", "Payments", [{ header: "Time", value: (p: Pay) => p.created_at }, { header: "Purpose", value: (p: Pay) => p.purpose }, { header: "Amount (EGP)", value: (p: Pay) => p.amount_piastres / 100 }, { header: "Status", value: (p: Pay) => p.status }, { header: "Transaction", value: (p: Pay) => p.provider_txn_id }], data.pay)}>تنزيل Excel</ExcelButton></div>
      <DataTable head={["الوقت", "الغرض", "المبلغ", "الحالة", "رقم العملية"]}>
        {data.pay.map((p) => <tr key={p.id}><Td>{cairoDateTime(p.created_at)}</Td><Td>{p.purpose === "order" ? "طلب" : "مبلغ إضافي"}</Td><Td>{egp(p.amount_piastres)}</Td><Td><Badge tone={tone(p.status)}>{p.status}</Badge></Td><Td dir="ltr">{p.provider_txn_id ?? "—"}</Td></tr>)}
      </DataTable>
    </div>
  );
}
export default function AdminFinance() { return <AppShell guard={{ employee: false, perm: "payments.view" }}><PageTitle title="المدفوعات والاستردادات" /><Finance /></AppShell>; }
