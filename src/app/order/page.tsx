"use client";
/* eslint-disable @next/next/no-img-element */

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import QRCode from "qrcode";
import { AppShell, PageTitle } from "@/components/layout/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorBox, Spinner, useToast } from "@/components/ui/misc";
import { ProductImage } from "@/components/store/product-card";
import { getSupabase } from "@/lib/supabase/client";
import { rpc } from "@/lib/rpc";
import { useLoad, useRealtime } from "@/lib/hooks";
import { ORDER_FLOW, ORDER_STATUS_LABEL, STATUS_TONE, cairoDateTime, cairoTime, egp, orderNo } from "@/lib/format";
import { errorMessage } from "@/lib/errors";
import { startCardPayment } from "@/lib/payments";
import { cn } from "@/lib/utils";
import { groupByCategory } from "@/lib/group";

type Item = { id: string; name: string; category_name: string | null; barcode: string; image_url: string | null; unit_price_piastres: number; qty_ordered: number; qty_prepared: number; qty_unavailable: number; status: string };
type Hist = { id: number; to_status: string; created_at: string };
type Refund = { id: string; method: string; amount_piastres: number; status: string; kind: string; created_at: string };
type Order = {
  id: string; order_no: number; status: string; slot_label: string | null; created_at: string; pickup_code: string;
  subtotal_piastres: number; bag_initial_piastres: number; fee_piastres: number; total_piastres: number; wallet_applied_piastres: number; card_due_piastres: number;
  payment_expires_at: string | null; prepared_subtotal_piastres: number | null; final_fee_piastres: number | null; bag_actual_piastres: number | null;
  final_total_piastres: number | null; extra_due_piastres: number; is_partial: boolean; bag_small_count: number | null; bag_large_count: number | null;
  order_items: Item[]; order_status_history: Hist[]; refunds: Refund[];
};

const REFUND_STATUS: Record<string, string> = { pending: "قيد المعالجة", processing: "جاري التحويل", completed: "تم", failed: "تعذر — الإدارة هتتابع" };

function Detail() {
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  const payFailed = params.get("pay") === "failed";
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [toWallet, setToWallet] = useState(false);
  const [qr, setQr] = useState("");
  const { data, error, loading, reload } = useLoad(async () => {
    const { data: row, error: err } = await getSupabase().from("orders")
      .select("*, order_items(*), order_status_history(id,to_status,created_at), refunds(id,method,amount_piastres,status,kind,created_at)").eq("id", id).maybeSingle();
    if (err) throw err; return row as Order | null;
  }, [id]);
  useRealtime("orders", `id=eq.${id}`, () => void reload(), 15_000);
  useRealtime("order_items", `order_id=eq.${id}`, () => void reload(), 60_000);

  useEffect(() => { if (data?.pickup_code) void QRCode.toDataURL(data.pickup_code, { margin: 1, width: 220 }).then(setQr); }, [data?.pickup_code]);

  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!data) return <EmptyState title="الطلب غير موجود" />;
  const o = data;
  const canCancel = ["pending_payment", "waiting_picker", "assigned"].includes(o.status);
  const stepIndex = ORDER_FLOW.indexOf(o.status);
  const showCode = ["ready_handover", "received_pickup", "ready_collection"].includes(o.status);

  async function run(fn: () => Promise<unknown>, ok?: string) {
    if (busy) return; setBusy(true);
    try { await fn(); if (ok) toast(ok); await reload(); } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  }

  return (
    <div className="grid gap-5">
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="text-xl font-bold">{o.order_no ? orderNo(o.order_no) : "طلب بانتظار الدفع"}</p><p className="text-sm text-muted">{cairoDateTime(o.created_at)} • {o.slot_label}</p></div>
        <Badge tone={STATUS_TONE[o.status] ?? "neutral"} className="text-base">{ORDER_STATUS_LABEL[o.status] ?? o.status}</Badge>
      </Card>

      {!["canceled", "expired"].includes(o.status) && (
        <Card>
          <ol className="flex gap-2 overflow-x-auto pb-1" aria-label="مراحل الطلب">
            {ORDER_FLOW.map((s, i) => (
              <li key={s} className={cn("whitespace-nowrap rounded-full px-3 py-1 text-sm", i < stepIndex ? "bg-brand-100 text-brand-700" : i === stepIndex ? "bg-brand-500 font-bold text-white" : "bg-surface text-muted")}>{ORDER_STATUS_LABEL[s]}</li>
            ))}
          </ol>
        </Card>
      )}

      {o.status === "pending_payment" && (
        <Card className="border-amber-300 bg-amber-50">
          <p className="font-semibold text-warning">طلبك محجوز لحد {cairoTime(o.payment_expires_at)}. بعد كده بيتلغي تلقائيًا.</p>
          <div className="mt-3 flex flex-wrap gap-3">
            {o.card_due_piastres > 0 && <Button loading={busy} onClick={() => run(() => startCardPayment(o.id, "order"))}>ادفع {egp(o.card_due_piastres)} بالكارت</Button>}
          </div>
          {payFailed && <p className="mt-2 text-danger">تعذر بدء الدفع. جرب تاني.</p>}
        </Card>
      )}

      {o.extra_due_piastres > 0 && (
        <Card className="border-amber-300 bg-amber-50">
          <p className="font-semibold text-warning">مطلوب دفع إضافي {egp(o.extra_due_piastres)} (فرق تكلفة الأكياس) قبل الاستلام.</p>
          <Button className="mt-3" loading={busy} onClick={() => run(() => startCardPayment(o.id, "extra"))}>ادفع المبلغ الإضافي</Button>
        </Card>
      )}

      {showCode && (
        <Card className="flex flex-col items-center gap-2 text-center">
          <p className="font-bold">كود الاستلام</p>
          {qr && <img src={qr} alt="QR code للاستلام" width={180} height={180} />}
          <p className="text-2xl font-bold tracking-widest" dir="ltr">{o.pickup_code}</p>
          <p className="text-sm text-muted">اعرض الكود أو رقم الطلب ({orderNo(o.order_no)}) على موظف الاستلام.</p>
        </Card>
      )}

      <Card>
        <h2 className="mb-3 text-lg font-bold">المنتجات</h2>
        {groupByCategory(o.order_items, (i) => i.status !== "pending").map(([cat, list]) => (
          <section key={cat} className="mb-4">
            <h3 className="mb-2 border-b border-line pb-1 text-base text-brand-700">{cat} <span className="text-sm text-muted">({list.length})</span></h3>
            <ul className="grid gap-3">
              {list.map((it) => (
                <li key={it.id} className={cn("flex items-center gap-3", it.status !== "pending" && "opacity-70")}>
                  <ProductImage src={it.image_url} name={it.name} className="h-14 w-14 rounded-xl" />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{it.name}</p>
                    <p className="text-sm text-muted">{it.qty_ordered} × {egp(it.unit_price_piastres)}{it.qty_unavailable > 0 && <span className="text-danger"> • غير متوفر: {it.qty_unavailable}</span>}</p>
                  </div>
                  <b>{egp(it.unit_price_piastres * (o.final_total_piastres !== null ? it.qty_prepared : it.qty_ordered - it.qty_unavailable))}</b>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <dl className="mt-4 grid gap-1 border-t border-line pt-3">
          <div className="flex justify-between"><dt>المنتجات</dt><dd>{egp(o.prepared_subtotal_piastres ?? o.subtotal_piastres)}</dd></div>
          <div className="flex justify-between"><dt>{o.bag_actual_piastres !== null ? `الأكياس (${o.bag_small_count ?? 0} صغير، ${o.bag_large_count ?? 0} كبير)` : "كيس التسوق (مبدئي)"}</dt><dd>{egp(o.bag_actual_piastres ?? o.bag_initial_piastres)}</dd></div>
          <div className="flex justify-between"><dt>رسوم الدفع</dt><dd>{egp(o.final_fee_piastres ?? o.fee_piastres)}</dd></div>
          <div className="flex justify-between text-lg font-bold"><dt>الإجمالي</dt><dd>{egp(o.final_total_piastres ?? o.total_piastres)}</dd></div>
        </dl>
      </Card>

      {o.refunds.length > 0 && (
        <Card>
          <h2 className="mb-2 text-lg font-bold">الاستردادات</h2>
          <ul className="grid gap-2">{o.refunds.map((r) => (
            <li key={r.id} className="flex justify-between"><span>{r.method === "card" ? "إلى البطاقة" : "إلى المحفظة"} — {REFUND_STATUS[r.status]}</span><b>{egp(r.amount_piastres)}</b></li>
          ))}</ul>
        </Card>
      )}

      <Card>
        <h2 className="mb-2 text-lg font-bold">سجل الحالة</h2>
        <ul className="grid gap-1 text-sm">{[...o.order_status_history].sort((a, b) => a.id - b.id).map((h) => (
          <li key={h.id} className="flex justify-between"><span>{ORDER_STATUS_LABEL[h.to_status]}</span><span className="text-muted">{cairoDateTime(h.created_at)}</span></li>
        ))}</ul>
      </Card>

      <Card>
        <h2 className="mb-1 text-lg font-bold">إلغاء الطلب</h2>
        {canCancel ? (
          <>
            <p className="text-sm text-muted">تقدر تلغي الطلب طالما المجهّز لم يبدأ التجهيز.</p>
            {o.status !== "pending_payment" && (
              <label className="mt-3 flex items-center gap-2 text-sm"><input type="checkbox" checked={toWallet} onChange={(e) => setToWallet(e.target.checked)} /> استرداد المبلغ في محفظتي بدل البطاقة</label>
            )}
            <Button variant="danger" className="mt-3" loading={busy} onClick={() => { if (confirm("متأكد إنك عايز تلغي الطلب؟")) void run(async () => { await rpc("cancel_order", { p_order: o.id, p_refund_to_wallet: toWallet }); }, "تم إلغاء الطلب"); }}>إلغاء الطلب</Button>
          </>
        ) : <p className="text-sm text-muted">{["canceled", "expired", "collected"].includes(o.status) ? "لا يمكن إلغاء هذا الطلب." : "لا يمكن الإلغاء لأن التجهيز بدأ. تواصل مع الإدارة لو محتاج."}</p>}
      </Card>
    </div>
  );
}

export default function OrderPage() {
  return <AppShell><PageTitle title="تفاصيل الطلب" /><Suspense fallback={<Spinner />}><Detail /></Suspense></AppShell>;
}
