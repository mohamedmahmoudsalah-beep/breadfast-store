"use client";

import { useState } from "react";
import { AppShell, PageTitle } from "@/components/layout/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DataTable, ErrorBox, Field, Spinner, Td, useToast } from "@/components/ui/misc";
import { useAuth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase/client";
import { rpc } from "@/lib/rpc";
import { useLoad } from "@/lib/hooks";
import { cairoDateTime, egp, parseEgpToPiastres } from "@/lib/format";
import { errorMessage } from "@/lib/errors";
import { kickRefundWorker } from "@/lib/payments";

type Pay = { id: string; order_id: string; purpose: string; amount_piastres: number; status: string; created_at: string; provider_txn_id: string | null };
type Ref = { id: string; order_id: string; method: string; amount_piastres: number; status: string; kind: string; last_error: string | null; created_at: string };

function Finance() {
  const { can } = useAuth();
  const toast = useToast();
  const [hrid, setHrid] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const { data, error, loading, reload } = useLoad(async () => {
    const s = getSupabase();
    const [p, r] = await Promise.all([
      s.from("payments").select("id,order_id,purpose,amount_piastres,status,created_at,provider_txn_id").order("created_at", { ascending: false }).limit(100),
      s.from("refunds").select("id,order_id,method,amount_piastres,status,kind,last_error,created_at").order("created_at", { ascending: false }).limit(100),
    ]);
    if (p.error) throw p.error;
    return { pay: (p.data ?? []) as Pay[], ref: (r.data ?? []) as Ref[] };
  });
  async function run(fn: () => Promise<unknown>, ok: string) { if (busy) return; setBusy(true); try { await fn(); toast(ok); await reload(); } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); } }
  async function adjust(sign: 1 | -1) {
    const piastres = parseEgpToPiastres(amount); if (!piastres) { toast("المبلغ غير صحيح", "error"); return; }
    const { data: emp } = await getSupabase().from("employees").select("user_id").eq("hrid", hrid.trim().toUpperCase()).maybeSingle();
    if (!emp) { toast("HRID غير موجود", "error"); return; }
    await run(() => rpc("admin_wallet_adjust", { p_user: emp.user_id, p_amount: sign * piastres, p_reason: reason }), "تم تعديل المحفظة");
  }
  if (loading && !data) return <Spinner />;
  if (error || !data) return <ErrorBox message={error ?? "خطأ"} onRetry={reload} />;
  const tone = (s: string) => (s === "paid" || s === "completed" ? "success" : s === "failed" || s === "mismatch" ? "danger" : "warning");
  return (
    <div className="grid gap-5">
      {can("refunds.manage") && <div><Button variant="secondary" onClick={() => run(async () => { await kickRefundWorker(); }, "تم إرسال طلب معالجة الاستردادات")}>معالجة الاستردادات المعلّقة الآن</Button></div>}
      <h2 className="text-lg font-bold">الاستردادات</h2>
      <DataTable head={["الوقت", "النوع", "الطريقة", "المبلغ", "الحالة", "ملاحظة", ""]}>
        {data.ref.map((r) => <tr key={r.id}><Td>{cairoDateTime(r.created_at)}</Td><Td>{r.kind}</Td><Td>{r.method === "card" ? "بطاقة" : "محفظة"}</Td><Td>{egp(r.amount_piastres)}</Td>
          <Td><Badge tone={tone(r.status)}>{r.status}</Badge></Td><Td className="max-w-xs truncate">{r.last_error}</Td>
          <Td>{r.method === "card" && ["failed", "pending"].includes(r.status) && can("refunds.manage") && (
            <span className="flex gap-2">
              {r.status === "failed" && <Button size="sm" variant="secondary" onClick={() => run(async () => { await rpc("refund_retry", { p_refund: r.id }); await kickRefundWorker(); }, "تمت إعادة المحاولة")}>إعادة محاولة</Button>}
              <Button size="sm" variant="ghost" onClick={() => { const note = prompt("اكتب ملاحظة (مثال: تم الرد يدويًا من لوحة Paymob برقم ...)"); if (note) void run(() => rpc("refund_mark_manual", { p_refund: r.id, p_note: note }), "تم تسجيل الرد اليدوي"); }}>تم الرد يدويًا</Button>
            </span>)}</Td></tr>)}
      </DataTable>
      <h2 className="text-lg font-bold">المدفوعات</h2>
      <DataTable head={["الوقت", "الغرض", "المبلغ", "الحالة", "رقم العملية"]}>
        {data.pay.map((p) => <tr key={p.id}><Td>{cairoDateTime(p.created_at)}</Td><Td>{p.purpose === "order" ? "طلب" : "مبلغ إضافي"}</Td><Td>{egp(p.amount_piastres)}</Td><Td><Badge tone={tone(p.status)}>{p.status}</Badge></Td><Td dir="ltr">{p.provider_txn_id ?? "—"}</Td></tr>)}
      </DataTable>
      {can("wallets.manage") && (
        <Card className="grid max-w-xl gap-3">
          <h2 className="font-bold">تعديل محفظة موظف (يُسجَّل في المراجعة)</h2>
          <Field label="HRID"><Input value={hrid} onChange={(e) => setHrid(e.target.value)} dir="ltr" /></Field>
          <Field label="المبلغ (جنيه)"><Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" dir="ltr" /></Field>
          <Field label="السبب (إجباري)"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <div className="flex gap-2"><Button loading={busy} disabled={reason.trim().length < 3} onClick={() => adjust(1)}>إضافة رصيد</Button><Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={() => adjust(-1)}>خصم رصيد</Button></div>
        </Card>
      )}
    </div>
  );
}
export default function AdminFinance() { return <AppShell guard={{ employee: false, perm: "payments.view" }}><PageTitle title="المدفوعات والاستردادات" /><Finance /></AppShell>; }
