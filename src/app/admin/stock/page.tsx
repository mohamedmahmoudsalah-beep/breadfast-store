"use client";

import { useState } from "react";
import { AppShell, PageTitle } from "@/components/layout/shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, ErrorBox, Field, Modal, Spinner, Td, Textarea, useToast } from "@/components/ui/misc";
import { useAuth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase/client";
import { rpc } from "@/lib/rpc";
import { useDebounced, useLoad } from "@/lib/hooks";
import { cairoDateTime } from "@/lib/format";
import { errorMessage } from "@/lib/errors";

type Mv = { id: number; movement_type: string; qty_delta: number; qty_before: number; qty_after: number; note: string | null; created_at: string; products: { name: string; barcode: string } | null };
const TYPE: Record<string, string> = { import: "استيراد", adjustment: "تصحيح", order_reserve: "حجز لطلب", order_release: "إرجاع من طلب", oos_reported: "نفاد عند التجهيز" };

function Stock() {
  const { can } = useAuth();
  const toast = useToast();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim());
  const [adj, setAdj] = useState<{ id: string; name: string; qty: number } | null>(null);
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ id: string; name: string; barcode: string; stock_qty: number }[]>([]);

  const { data, error, loading, reload } = useLoad(async () => {
    let query = getSupabase().from("stock_movements").select("id,movement_type,qty_delta,qty_before,qty_after,note,created_at,products!inner(name,barcode)").order("id", { ascending: false }).limit(150);
    if (q) query = query.or(`barcode.eq.${q.replace(/[,()]/g, "")},name.ilike.%${q.replace(/[,()%]/g, "")}%`, { foreignTable: "products" });
    const { data: rows, error: err } = await query;
    if (err) throw err;
    if (q && can("stock.adjust")) {
      const p = await getSupabase().from("products").select("id,name,barcode,stock_qty").or(`barcode.eq.${q.replace(/[,()]/g, "")},name.ilike.%${q.replace(/[,()%]/g, "")}%`).limit(5);
      setFound((p.data ?? []) as typeof found);
    } else setFound([]);
    return rows as unknown as Mv[];
  }, [q]);

  async function save() {
    if (!adj || busy) return; setBusy(true);
    try { await rpc("stock_adjust", { p_product: adj.id, p_new_qty: Number(qty), p_reason: reason }); toast("تم تسجيل التصحيح"); setAdj(null); setReason(""); await reload(); }
    catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  }
  return (
    <div className="grid gap-4">
      <Input className="max-w-sm" placeholder="ابحث بالاسم أو الباركود لعرض حركة منتج أو تصحيح مخزونه" value={search} onChange={(e) => setSearch(e.target.value)} />
      {found.length > 0 && (
        <div className="grid gap-2 rounded-2xl border border-line bg-white p-3">
          {found.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-2"><span>{p.name} <span className="text-muted" dir="ltr">({p.barcode})</span> — المخزون {p.stock_qty}</span>
              <Button size="sm" variant="secondary" onClick={() => { setAdj({ id: p.id, name: p.name, qty: p.stock_qty }); setQty(String(p.stock_qty)); }}>تصحيح المخزون</Button></div>
          ))}
        </div>
      )}
      {loading && !data ? <Spinner /> : error || !data ? <ErrorBox message={error ?? "خطأ"} onRetry={reload} /> : (
        <DataTable head={["الوقت", "المنتج", "النوع", "التغيير", "قبل", "بعد", "ملاحظة"]}>
          {data.map((m) => <tr key={m.id}><Td>{cairoDateTime(m.created_at)}</Td><Td>{m.products?.name}</Td><Td>{TYPE[m.movement_type] ?? m.movement_type}</Td>
            <Td className={m.qty_delta < 0 ? "text-danger" : "text-success"} dir="ltr">{m.qty_delta > 0 ? "+" : ""}{m.qty_delta}</Td><Td>{m.qty_before}</Td><Td>{m.qty_after}</Td><Td>{m.note}</Td></tr>)}
        </DataTable>
      )}
      <Modal open={Boolean(adj)} title={`تصحيح مخزون: ${adj?.name ?? ""}`} onClose={() => setAdj(null)}>
        <div className="grid gap-3">
          <p className="text-sm text-muted">الكمية الحالية: {adj?.qty}. التصحيح بيسجل باسمك وبسببه في سجل المراجعة.</p>
          <Field label="الكمية الصحيحة الجديدة"><Input type="number" min={0} value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
          <Field label="السبب (إجباري)"><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          <Button loading={busy} disabled={reason.trim().length < 3 || qty === ""} onClick={save}>حفظ التصحيح</Button>
        </div>
      </Modal>
    </div>
  );
}
export default function AdminStock() { return <AppShell guard={{ employee: false, perm: "stock.import" }}><PageTitle title="حركة المخزون" /><Stock /></AppShell>; }
