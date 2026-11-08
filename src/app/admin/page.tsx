"use client";

import { useEffect, useState } from "react";
import { AppShell, PageTitle } from "@/components/layout/shell";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DataTable, ErrorBox, Spinner, Td } from "@/components/ui/misc";
import { rpc } from "@/lib/rpc";
import { useLoad } from "@/lib/hooks";
import { egp, num } from "@/lib/format";

type Stats = {
  from: string; to: string; sales_piastres: number; orders_count: number; paid_piastres: number; refunds_piastres: number; net_sales_piastres: number;
  avg_order_value_piastres: number; online_users: number; available_pickers: number; orders_waiting: number; orders_preparing: number; orders_ready: number;
  orders_completed: number; out_of_stock_items: number; low_stock_items: { barcode: string; name: string; stock_qty: number }[];
  top_products: { barcode: string; name: string; qty: number; revenue_piastres: number }[]; orders_per_slot: { slot_label: string; orders: number }[];
  picker_performance: { picker: string; status: string; completed: number; avg_minutes: number | null; active_now: number }[];
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: boolean }) {
  return <Card className={tone ? "bg-brand-500 text-white" : ""}><p className={tone ? "text-brand-100" : "text-sm text-muted"}>{label}</p><p className="mt-1 text-2xl font-bold">{value}</p></Card>;
}

function Dashboard() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const { data, error, loading, reload } = useLoad(() => rpc<Stats>("dashboard_stats", { p_from: from || null, p_to: to || null }), [from, to]);
  const [online, setOnline] = useState<number | null>(null);

  // live online counter, refreshed every 15 s without reloading the page
  useEffect(() => {
    const tick = () => { void rpc<{ count: number }>("online_users", { p_details: false }).then((r) => setOnline(r.count)).catch(() => {}); };
    tick(); const id = window.setInterval(tick, 15_000); return () => window.clearInterval(id);
  }, []);
  useEffect(() => { const id = window.setInterval(() => void reload(), 30_000); return () => window.clearInterval(id); }, [reload]);

  if (loading && !data) return <Spinner />;
  if (error || !data) return <ErrorBox message={error ?? "خطأ"} onRetry={reload} />;
  const d = data;
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">من<Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="text-sm">إلى<Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <p className="pb-3 text-sm text-muted">الفترة: {d.from} → {d.to} (اليوم التجاري)</p>
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="المبيعات" value={egp(d.sales_piastres)} tone />
        <Stat label="عدد الطلبات" value={num(d.orders_count)} />
        <Stat label="إجمالي المدفوع" value={egp(d.paid_piastres)} />
        <Stat label="الاستردادات" value={egp(d.refunds_piastres)} />
        <Stat label="صافي المبيعات" value={egp(d.net_sales_piastres)} />
        <Stat label="متوسط قيمة الطلب" value={egp(d.avg_order_value_piastres)} />
        <Stat label="الموظفون المتصلون الآن" value={num(online ?? d.online_users)} tone />
        <Stat label="مجهزون متاحون" value={num(d.available_pickers)} />
        <Stat label="في انتظار التجهيز" value={num(d.orders_waiting)} />
        <Stat label="جاري تجهيزها" value={num(d.orders_preparing)} />
        <Stat label="جاهزة للاستلام" value={num(d.orders_ready)} />
        <Stat label="مكتملة" value={num(d.orders_completed)} />
        <Stat label="منتجات نفدت" value={num(d.out_of_stock_items)} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card><h2 className="mb-3 font-bold">الأكثر مبيعًا</h2>
          <DataTable head={["المنتج", "الكمية", "الإيراد"]}>{d.top_products.map((p) => <tr key={p.barcode}><Td>{p.name}</Td><Td>{p.qty}</Td><Td>{egp(p.revenue_piastres)}</Td></tr>)}</DataTable></Card>
        <Card><h2 className="mb-3 font-bold">الطلبات لكل موعد</h2>
          <DataTable head={["الموعد", "الطلبات"]}>{d.orders_per_slot.map((s) => <tr key={s.slot_label}><Td>{s.slot_label}</Td><Td>{s.orders}</Td></tr>)}</DataTable></Card>
        <Card><h2 className="mb-3 font-bold">مخزون منخفض</h2>
          <DataTable head={["المنتج", "المتاح"]}>{d.low_stock_items.map((p) => <tr key={p.barcode}><Td>{p.name}</Td><Td>{p.stock_qty}</Td></tr>)}</DataTable></Card>
        <Card><h2 className="mb-3 font-bold">أداء المجهزين</h2>
          <DataTable head={["المجهّز", "الحالة", "مكتمل", "متوسط الدقائق", "نشط الآن"]}>{d.picker_performance.map((p) => <tr key={p.picker}><Td>{p.picker}</Td><Td>{p.status}</Td><Td>{p.completed}</Td><Td>{p.avg_minutes ?? "—"}</Td><Td>{p.active_now}</Td></tr>)}</DataTable></Card>
      </div>
    </div>
  );
}

export default function AdminHome() {
  return <AppShell guard={{ employee: false, perm: "dashboard.view" }}><PageTitle title="لوحة التحكم" /><Dashboard /></AppShell>;
}
