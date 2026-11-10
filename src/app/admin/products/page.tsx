"use client";

import { useState } from "react";
import { AppShell, PageTitle } from "@/components/layout/shell";
import { ProductImage } from "@/components/store/product-card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataTable, ErrorBox, Field, Modal, Select, Spinner, Td, useToast } from "@/components/ui/misc";
import { getSupabase } from "@/lib/supabase/client";
import { rpc } from "@/lib/rpc";
import { useDebounced, useLoad } from "@/lib/hooks";
import { egp, parseEgpToPiastres } from "@/lib/format";
import { errorMessage } from "@/lib/errors";
import { ExcelButton } from "@/components/ui/file-drop";
import { downloadTable } from "@/lib/export";

type P = { id: string; barcode: string; name: string; image_url: string | null; price_piastres: number; stock_qty: number; is_active: boolean; category_id: string | null; categories: { name: string } | null };
const blank = { id: "", barcode: "", name: "", image_url: "", price: "", category_id: "", is_active: true };

function Products() {
  const toast = useToast();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim().replace(/[,()%*\\]/g, " "));
  const [form, setForm] = useState<typeof blank | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, error, loading, reload } = useLoad(async () => {
    let query = getSupabase().from("products").select("id,barcode,name,image_url,price_piastres,stock_qty,is_active,category_id,categories(name)").order("name").limit(200);
    if (q) query = query.or(`name.ilike.%${q}%,barcode.eq.${q}`);
    const [p, c] = await Promise.all([query, getSupabase().from("categories").select("id,name").order("name")]);
    if (p.error) throw p.error;
    return { products: (p.data ?? []) as unknown as P[], cats: (c.data ?? []) as { id: string; name: string }[] };
  }, [q]);

  async function save() {
    if (!form || busy) return;
    const price = parseEgpToPiastres(form.price);
    if (price === null) { toast("السعر غير صحيح", "error"); return; }
    setBusy(true);
    try {
      await rpc("product_save", { p: { id: form.id || null, barcode: form.barcode, name: form.name, image_url: form.image_url, price_piastres: price, category_id: form.category_id || null, is_active: form.is_active } });
      toast("تم الحفظ"); setForm(null); await reload();
    } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap gap-3">
        <Input className="max-w-sm" placeholder="بحث بالاسم أو الباركود" value={search} onChange={(e) => setSearch(e.target.value)} />
        <Button onClick={() => setForm({ ...blank })}>+ منتج جديد</Button>
        {data && <ExcelButton onClick={() => downloadTable("products.xlsx", "Products", [
          { header: "Barcode", value: (p: P) => p.barcode }, { header: "Product Name", value: (p: P) => p.name }, { header: "Category", value: (p: P) => p.categories?.name }, { header: "Image URL", value: (p: P) => p.image_url },
          { header: "Price", value: (p: P) => p.price_piastres / 100 }, { header: "Stock Quantity", value: (p: P) => p.stock_qty }, { header: "Active", value: (p: P) => (p.is_active ? "yes" : "no") }], data.products)}>تنزيل Excel</ExcelButton>}
      </div>
      <p className="text-sm text-muted">الكميات لا تتعدل من هنا؛ استخدم «رفع ملفات Excel ← المخزون» (إضافة) أو «حركة المخزون» (تصحيح بسبب). المنتج الظاهر لازم يكون له سعر أكبر من صفر.</p>
      {loading && !data ? <Spinner /> : error || !data ? <ErrorBox message={error ?? "خطأ"} onRetry={reload} /> : (
        <DataTable head={["", "المنتج", "الباركود", "القسم", "السعر", "المخزون", "الحالة", ""]}>
          {data.products.map((p) => (
            <tr key={p.id}>
              <Td><ProductImage src={p.image_url} name={p.name} className="h-10 w-10 rounded-lg" /></Td><Td>{p.name}</Td><Td dir="ltr">{p.barcode}</Td><Td>{p.categories?.name ?? "—"}</Td>
              <Td>{egp(p.price_piastres)}</Td><Td>{p.stock_qty}</Td><Td>{p.price_piastres <= 0 ? <Badge tone="warning">بدون سعر (مخفي)</Badge> : <Badge tone={p.is_active ? "success" : "neutral"}>{p.is_active ? "نشط" : "موقوف"}</Badge>}</Td>
              <Td><Button size="sm" variant="secondary" onClick={() => setForm({ id: p.id, barcode: p.barcode, name: p.name, image_url: p.image_url ?? "", price: String(p.price_piastres / 100), category_id: p.category_id ?? "", is_active: p.is_active })}>تعديل</Button></Td>
            </tr>
          ))}
        </DataTable>
      )}
      <Modal open={Boolean(form)} title={form?.id ? "تعديل منتج" : "منتج جديد"} onClose={() => setForm(null)}>
        {form && (
          <div className="grid gap-3">
            <Field label="الباركود"><Input value={form.barcode} disabled={Boolean(form.id)} onChange={(e) => setForm({ ...form, barcode: e.target.value })} dir="ltr" /></Field>
            <Field label="اسم المنتج"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="السعر (جنيه)"><Input value={form.price} inputMode="decimal" onChange={(e) => setForm({ ...form, price: e.target.value })} dir="ltr" /></Field>
            <Field label="القسم"><Select value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}><option value="">بدون قسم</option>{data?.cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
            <Field label="رابط الصورة"><Input value={form.image_url} onChange={(e) => setForm({ ...form, image_url: e.target.value })} dir="ltr" placeholder="https://..." /></Field>
            <label className="flex items-center gap-2"><input type="checkbox" checked={form.is_active} onChange={(e) => setForm({ ...form, is_active: e.target.checked })} /> ظاهر في المتجر</label>
            <Button loading={busy} onClick={save}>حفظ</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}

export default function AdminProducts() {
  return <AppShell guard={{ employee: false, perm: "products.manage" }}><PageTitle title="المنتجات" /><Products /></AppShell>;
}
