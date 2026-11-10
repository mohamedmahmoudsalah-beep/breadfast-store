"use client";

import { Suspense, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AppShell, PageTitle } from "@/components/layout/shell";
import { CameraScanner } from "@/components/store/scanner";
import { ProductImage } from "@/components/store/product-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorBox, Modal, Spinner, useToast, Field } from "@/components/ui/misc";
import { getSupabase } from "@/lib/supabase/client";
import { rpc } from "@/lib/rpc";
import { useLoad, useRealtime } from "@/lib/hooks";
import { cairoDateTime, orderNo } from "@/lib/format";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { groupByCategory } from "@/lib/group";

type Item = { id: string; name: string; category_name: string | null; barcode: string; image_url: string | null; qty_ordered: number; qty_prepared: number; qty_unavailable: number; status: string };
type Order = { id: string; order_no: number; status: string; employee_name: string; hrid: string; slot_label: string | null; created_at: string; order_items: Item[] };

function Prep() {
  const id = useSearchParams().get("id") ?? "";
  const router = useRouter();
  const toast = useToast();
  const scanRef = useRef<HTMLInputElement>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<Item | null>(null);
  const [prep, setPrep] = useState(0);
  const [unav, setUnav] = useState(0);
  const [bagsOpen, setBagsOpen] = useState(false);
  const [small, setSmall] = useState("");
  const [large, setLarge] = useState("");

  const { data, error, loading, reload } = useLoad(async () => {
    const { data: row, error: err } = await getSupabase().from("orders")
      .select("id,order_no,status,employee_name,hrid,slot_label,created_at,order_items(id,name,category_name,barcode,image_url,qty_ordered,qty_prepared,qty_unavailable,status)").eq("id", id).maybeSingle();
    if (err) throw err; return row as Order | null;
  }, [id]);
  useRealtime("order_items", `order_id=eq.${id}`, () => void reload(), 15_000);

  async function act(fn: () => Promise<unknown>, ok?: string) {
    if (busy) return; setBusy(true);
    try { await fn(); if (ok) toast(ok); await reload(); } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); scanRef.current?.focus(); }
  }
  const scan = (c: string) => act(() => rpc("picker_scan", { p_order: id, p_barcode: c.trim() }));

  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!data) return <EmptyState title="الطلب غير موجود أو لم يعد معيّنًا ليك" />;
  const o = data;
  const groups = groupByCategory(o.order_items, (i) => i.qty_prepared + i.qty_unavailable >= i.qty_ordered);   // by category; finished items go to the bottom of each group
  const total = o.order_items.reduce((t, i) => t + i.qty_ordered, 0);
  const done = o.order_items.reduce((t, i) => t + i.qty_prepared + i.qty_unavailable, 0);
  const allDone = o.order_items.every((i) => i.qty_prepared + i.qty_unavailable >= i.qty_ordered);
  const editable = o.status === "assigned" || o.status === "preparing";

  return (
    <div className="grid gap-4">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><p className="text-xl font-bold">{orderNo(o.order_no)}</p><p className="text-sm text-muted">{o.employee_name} ({o.hrid}) • {o.slot_label} • {cairoDateTime(o.created_at)}</p></div>
          <Badge tone={o.status === "preparing" ? "brand" : "neutral"}>{o.status === "preparing" ? "جاري التجهيز" : o.status === "assigned" ? "لم يبدأ" : "انتهى"}</Badge>
        </div>
        <div className="mt-3 h-3 overflow-hidden rounded-full bg-surface"><div className="h-full bg-brand-500 transition-all" style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
        <p className="mt-1 text-sm">{done} / {total}</p>
        {o.status === "assigned" && <Button className="mt-3" loading={busy} onClick={() => act(() => rpc("picker_start_order", { p_order: id }), "بدأ التجهيز")}>ابدأ التجهيز</Button>}
      </Card>

      {editable && (
        <Card>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (code.trim()) { void scan(code); setCode(""); } }}>
            <Input ref={scanRef} autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="امسح أو اكتب الباركود ثم Enter" dir="ltr" aria-label="الباركود" inputMode="numeric" />
            <Button type="submit" loading={busy}>تأكيد</Button>
          </form>
          <div className="mt-3"><CameraScanner onScan={(c) => void scan(c)} /></div>
        </Card>
      )}

      <div className="grid gap-5">
        {groups.map(([cat, list]) => (
          <section key={cat}>
            <h3 className="mb-2 flex items-center justify-between border-b-2 border-gold pb-1 text-lg text-brand-700"><span>{cat}</span><span className="text-sm text-muted">{list.filter((i) => i.qty_prepared + i.qty_unavailable >= i.qty_ordered).length} / {list.length}</span></h3>
            <div className="grid gap-3">
              {list.map((it) => {
                const finished = it.qty_prepared + it.qty_unavailable >= it.qty_ordered;
              return (
                <Card key={it.id} className={cn("flex items-center gap-3 p-3", finished && "bg-surface opacity-60")}>
                  <ProductImage src={it.image_url} name={it.name} className="h-16 w-16 shrink-0 rounded-xl" />
                  <div className="min-w-0 flex-1">
                    <p className={cn("font-semibold", finished && "line-through")}>{it.name}</p>
                    <p className="text-sm text-muted" dir="ltr">{it.barcode}</p>
                    <p className="text-sm">المطلوب <b>{it.qty_ordered}</b> • تم تجهيز <b>{it.qty_prepared}</b>{it.qty_unavailable > 0 && <span className="text-danger"> • غير متوفر <b>{it.qty_unavailable}</b></span>}</p>
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {it.status === "out_of_stock" && <Badge tone="danger">نفد</Badge>}
                    {it.status === "partial" && <Badge tone="warning">جزئي</Badge>}
                    {it.status === "prepared" && <Badge tone="success">تم</Badge>}
                    {editable && <Button size="sm" variant="secondary" onClick={() => { setEdit(it); setPrep(it.qty_prepared); setUnav(it.qty_unavailable); }}>تعديل</Button>}
                  </div>
                </Card>
              );
              })}
            </div>
          </section>
        ))}
      </div>

      {editable && <Button size="lg" disabled={!allDone} onClick={() => setBagsOpen(true)}>إنهاء التجهيز وتسجيل الأكياس</Button>}
      {editable && !allDone && <p className="text-center text-sm text-muted">لازم تجهّز كل المنتجات أو تحدد غير المتوفر منها قبل الإنهاء.</p>}

      <Modal open={Boolean(edit)} title={edit?.name ?? ""} onClose={() => setEdit(null)}>
        {edit && (
          <div className="grid gap-4">
            <div className="flex items-center gap-4 rounded-xl bg-surface p-3">
              <ProductImage src={edit.image_url} name={edit.name} className="h-28 w-28 shrink-0 rounded-xl" />
              <div className="min-w-0">
                <p className="text-lg font-bold">{edit.name}</p>
                <p className="mt-1 text-sm text-muted">الباركود</p>
                <p className="break-all text-xl font-bold tracking-wider" dir="ltr">{edit.barcode}</p>
                <p className="mt-1 text-sm">المطلوب: <b>{edit.qty_ordered}</b></p>
              </div>
            </div>
            <Field label="الكمية المجهّزة"><Input type="number" min={0} max={edit.qty_ordered} value={prep} onChange={(e) => setPrep(Number(e.target.value))} /></Field>
            <Field label="الكمية غير المتوفرة (OUT OF STOCK)" hint="بعد التسجيل لا يمكن تقليلها. العميل هيتم إشعاره وهيتسترد المبلغ."><Input type="number" min={edit.qty_unavailable} max={edit.qty_ordered} value={unav} onChange={(e) => setUnav(Number(e.target.value))} /></Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" onClick={() => { setPrep(Math.max(0, edit.qty_ordered - unav)); }}>جهّزت الكل</Button>
              <Button variant="danger" onClick={() => { setUnav(edit.qty_ordered - prep); }}>الباقي نفد</Button>
            </div>
            <Button loading={busy} onClick={() => act(async () => { await rpc("picker_set_item", { p_order: id, p_item: edit.id, p_prepared: prep, p_unavailable: unav }); setEdit(null); }, "تم الحفظ")}>حفظ</Button>
          </div>
        )}
      </Modal>

      <Modal open={bagsOpen} title="عدد الأكياس المستخدمة" onClose={() => setBagsOpen(false)}>
        <div className="grid gap-4">
          <Field label="أكياس صغيرة"><Input type="number" min={0} inputMode="numeric" value={small} onChange={(e) => setSmall(e.target.value)} placeholder="0" /></Field>
          <Field label="أكياس كبيرة"><Input type="number" min={0} inputMode="numeric" value={large} onChange={(e) => setLarge(e.target.value)} placeholder="0" /></Field>
          <Button size="lg" loading={busy} disabled={small === "" || large === ""} onClick={() => act(async () => {
            await rpc("picker_complete_order", { p_order: id, p_small: Number(small), p_large: Number(large) });
            toast("تم إنهاء التجهيز وتسليم الطلب لنقطة الاستلام"); router.replace("/picker/");
          })}>تأكيد الإنهاء</Button>
        </div>
      </Modal>
    </div>
  );
}

export default function PickerOrderPage() {
  return <AppShell guard={{ employee: false, perm: "picker.work" }}><PageTitle title="تجهيز الطلب" /><Suspense fallback={<Spinner />}><Prep /></Suspense></AppShell>;
}
