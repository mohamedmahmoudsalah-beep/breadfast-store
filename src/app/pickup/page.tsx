"use client";

import { useState } from "react";
import { AppShell, PageTitle } from "@/components/layout/shell";
import { CameraScanner } from "@/components/store/scanner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorBox, Spinner, useToast } from "@/components/ui/misc";
import { getSupabase } from "@/lib/supabase/client";
import { rpc } from "@/lib/rpc";
import { useLoad, useRealtime } from "@/lib/hooks";
import { ORDER_STATUS_LABEL, STATUS_TONE, cairoTime, egp, orderNo } from "@/lib/format";
import { errorMessage } from "@/lib/errors";

type Row = { id: string; order_no: number; status: string; employee_name: string; hrid: string; pickup_code: string; ready_at: string | null; extra_due_piastres: number; bag_small_count: number | null; bag_large_count: number | null };
type Lookup = { order_id: string; order_no: number; status: string; employee_name: string; hrid: string; extra_due_piastres: number; bag_small: number | null; bag_large: number | null; items: { name: string; barcode: string; qty_prepared: number; qty_unavailable: number }[] };

function Pickup() {
  const toast = useToast();
  const [code, setCode] = useState("");
  const [found, setFound] = useState<Lookup | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, error, loading, reload } = useLoad(async () => {
    const { data: rows, error: err } = await getSupabase().from("orders")
      .select("id,order_no,status,employee_name,hrid,pickup_code,ready_at,extra_due_piastres,bag_small_count,bag_large_count")
      .in("status", ["ready_handover", "received_pickup", "ready_collection"]).order("ready_at");
    if (err) throw err; return rows as Row[];
  });
  useRealtime("orders", undefined, () => void reload(), 10_000);

  async function find(c: string) {
    if (!c.trim()) return;
    try { setFound(await rpc<Lookup>("pickup_lookup", { p_code: c.trim() })); } catch (e) { setFound(null); toast(errorMessage(e), "error"); }
  }
  async function run(fn: () => Promise<unknown>, ok: string) {
    if (busy) return; setBusy(true);
    try { await fn(); toast(ok); setFound(null); setCode(""); await reload(); } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  }
  const stage = (s: string) => data?.filter((o) => o.status === s) ?? [];

  return (
    <div className="grid gap-5">
      <Card>
        <h2 className="mb-2 text-lg font-bold">استلام الموظف للطلب</h2>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void find(code); }}>
          <Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="رقم الطلب أو كود الـ QR" dir="ltr" aria-label="كود الطلب" />
          <Button type="submit">بحث</Button>
        </form>
        <div className="mt-3"><CameraScanner label="مسح QR بالكاميرا" onScan={(c) => { setCode(c); void find(c); }} /></div>
        {found && (
          <div className="mt-4 rounded-2xl border border-brand-200 bg-brand-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-lg font-bold">{orderNo(found.order_no)} — {found.employee_name} ({found.hrid})</p>
              <Badge tone={STATUS_TONE[found.status] ?? "neutral"}>{ORDER_STATUS_LABEL[found.status]}</Badge>
            </div>
            <ul className="mt-2 text-sm">{found.items.map((i) => <li key={i.barcode}>{i.name}: <b>{i.qty_prepared}</b>{i.qty_unavailable > 0 && <span className="text-danger"> (غير متوفر {i.qty_unavailable})</span>}</li>)}</ul>
            <p className="mt-1 text-sm text-muted">أكياس: {found.bag_small ?? 0} صغير، {found.bag_large ?? 0} كبير</p>
            {found.extra_due_piastres > 0 && <p className="mt-2 rounded-lg bg-amber-50 p-2 text-warning">لسه مطلوب دفع {egp(found.extra_due_piastres)} قبل التسليم.</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              {found.status === "ready_handover" && <Button loading={busy} onClick={() => run(() => rpc("pickup_receive", { p_order: found.order_id }), "تم استلام الطلب من المجهّز")}>تأكيد استلام الطلب من المجهّز</Button>}
              {found.status === "ready_collection" && <Button loading={busy} onClick={() => run(() => rpc("pickup_collect", { p_code: String(found.order_no) }), "تم تسليم الطلب للموظف")}>تأكيد تسليم الطلب للموظف</Button>}
            </div>
          </div>
        )}
      </Card>

      {loading && !data ? <Spinner /> : error ? <ErrorBox message={error} onRetry={reload} /> : (
        <div className="grid gap-5 lg:grid-cols-3">
          {([["ready_handover", "جاهز للتسليم من المجهّز"], ["received_pickup", "بانتظار دفع إضافي"], ["ready_collection", "جاهز لاستلام الموظف"]] as const).map(([s, title]) => (
            <Card key={s}>
              <h3 className="mb-3 font-bold">{title} ({stage(s).length})</h3>
              {stage(s).length === 0 ? <p className="text-sm text-muted">لا توجد طلبات.</p> : (
                <ul className="grid gap-2">{stage(s).map((o) => (
                  <li key={o.id}><button className="w-full rounded-xl border border-line p-3 text-start hover:border-brand-300" onClick={() => { setCode(String(o.order_no)); void find(String(o.order_no)); }}>
                    <b>{orderNo(o.order_no)}</b> • {o.employee_name}<span className="block text-xs text-muted">{cairoTime(o.ready_at)}</span></button></li>
                ))}</ul>
              )}
            </Card>
          ))}
        </div>
      )}
      {!loading && !data?.length && <EmptyState title="لا توجد طلبات في نقطة الاستلام حاليًا" />}
    </div>
  );
}

export default function PickupPage() {
  return <AppShell guard={{ employee: false, perm: "pickup.work" }}><PageTitle title="نقطة الاستلام" /><Pickup /></AppShell>;
}
