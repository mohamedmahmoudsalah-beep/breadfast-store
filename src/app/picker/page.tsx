"use client";

import Link from "next/link";
import { AppShell, PageTitle } from "@/components/layout/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorBox, Spinner, useToast } from "@/components/ui/misc";
import { useAuth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase/client";
import { rpc } from "@/lib/rpc";
import { useLoad, useRealtime } from "@/lib/hooks";
import { ORDER_STATUS_LABEL, cairoDateTime, cairoTime, orderNo } from "@/lib/format";
import { errorMessage } from "@/lib/errors";

type PickerRow = { status: "available" | "busy" | "offline" | "paused" };
type OrderRow = { id: string; order_no: number; status: string; created_at: string; slot_label: string | null; employee_name: string; hrid: string; order_items: { qty_ordered: number; qty_prepared: number; qty_unavailable: number }[] };

const STATUS_LABEL = { available: "متاح", busy: "مشغول", offline: "غير متصل", paused: "إيقاف مؤقت" } as const;

function Dashboard() {
  const { session } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useLoad(async () => {
    const supabase = getSupabase();
    const [me, orders, queue] = await Promise.all([
      supabase.from("pickers").select("status").maybeSingle(),
      supabase.from("orders").select("id,order_no,status,created_at,slot_label,employee_name,hrid,order_items(qty_ordered,qty_prepared,qty_unavailable)")
        .in("status", ["assigned", "preparing"]).eq("picker_id", session!.user.id).order("created_at"),
      supabase.rpc("dashboard_stats"),
    ]);
    if (orders.error) throw orders.error;
    return { me: me.data as PickerRow | null, orders: (orders.data ?? []) as OrderRow[], waiting: queue.error ? null : (queue.data as { orders_waiting: number }).orders_waiting };
  });
  useRealtime("orders", session ? `picker_id=eq.${session.user.id}` : undefined, () => void reload(), 10_000);
  useRealtime("pickers", session ? `user_id=eq.${session.user.id}` : undefined, () => void reload(), 60_000);

  async function setStatus(s: string) {
    try { await rpc("picker_set_status", { p_status: s }); await reload(); } catch (e) { toast(errorMessage(e), "error"); }
  }
  if (loading && !data) return <Spinner />;
  if (error || !data) return <ErrorBox message={error ?? "خطأ"} onRetry={reload} />;
  const st = data.me?.status ?? "offline";
  return (
    <div className="grid gap-5">
      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div><p className="text-sm text-muted">حالتك</p><Badge tone={st === "available" ? "success" : st === "busy" ? "brand" : "neutral"} className="text-base">{STATUS_LABEL[st]}</Badge></div>
        <div className="flex flex-wrap gap-2">
          <Button variant={st === "available" || st === "busy" ? "primary" : "secondary"} onClick={() => setStatus("available")}>متاح</Button>
          <Button variant={st === "paused" ? "primary" : "secondary"} onClick={() => setStatus("paused")}>إيقاف مؤقت</Button>
          <Button variant={st === "offline" ? "primary" : "secondary"} onClick={() => setStatus("offline")}>غير متصل</Button>
        </div>
      </Card>
      {data.orders.length === 0 ? <EmptyState title="مفيش طلبات معيّنة ليك دلوقتي" hint={st === "available" ? "هتوصلك الطلبات تلقائيًا." : "غيّر حالتك لـ متاح عشان تستقبل طلبات."} /> : (
        <div className="grid gap-3">
          {data.orders.map((o) => {
            const total = o.order_items.reduce((t, i) => t + i.qty_ordered, 0);
            const done = o.order_items.reduce((t, i) => t + i.qty_prepared + i.qty_unavailable, 0);
            return (
              <Link key={o.id} href={`/picker/order/?id=${o.id}`}>
                <Card className="hover:border-brand-300">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-lg font-bold">{orderNo(o.order_no)}</p>
                    <Badge tone={o.status === "preparing" ? "brand" : "warning"}>{ORDER_STATUS_LABEL[o.status]}</Badge>
                  </div>
                  <p className="text-sm text-muted">{o.employee_name} ({o.hrid}) • {o.slot_label} • أُنشئ {cairoDateTime(o.created_at)} • وقت الإنشاء {cairoTime(o.created_at)}</p>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface"><div className="h-full bg-brand-500" style={{ width: `${total ? (done / total) * 100 : 0}%` }} /></div>
                  <p className="mt-1 text-sm">{done} / {total} وحدة</p>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
      {data.waiting !== null && <p className="text-sm text-muted">طلبات في الانتظار: {data.waiting}</p>}
    </div>
  );
}

export default function PickerPage() {
  return <AppShell guard={{ employee: false, perm: "picker.work" }}><PageTitle title="لوحة التجهيز" /><Dashboard /></AppShell>;
}
