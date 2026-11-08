"use client";

import { useCallback, useState } from "react";
import { AppShell } from "@/components/layout/shell";
import { ProductCard } from "@/components/store/product-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorBox, Spinner } from "@/components/ui/misc";
import { getSupabase } from "@/lib/supabase/client";
import { useDebounced, useLoad } from "@/lib/hooks";
import { useStoreMeta, type Product } from "@/lib/store";
import { useCart } from "@/lib/cart";
import { egp } from "@/lib/format";
import Link from "next/link";
import { cn } from "@/lib/utils";

const PAGE = 24;

function Store() {
  const { meta, loading: metaLoading } = useStoreMeta();
  const cart = useCart();
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim().replace(/[,()%*\\]/g, " "));
  const [cat, setCat] = useState<string | null>(null);
  const [inStock, setInStock] = useState(false);
  const [more, setMore] = useState<{ key: string; items: Product[] }>({ key: "", items: [] });
  const [loadingMore, setLoadingMore] = useState(false);
  const key = JSON.stringify([cat, q, inStock]);

  const fetchPage = useCallback(async (from: number) => {
    let query = getSupabase().from("products")
      .select("id,barcode,name,image_url,price_piastres,stock_qty,category_id", { count: "exact" })
      .eq("is_active", true).order("name").range(from, from + PAGE - 1);
    if (cat) query = query.eq("category_id", cat);
    if (inStock) query = query.gt("stock_qty", 0);
    if (q) query = query.or(`name.ilike.%${q}%,barcode.eq.${q}`);
    const { data, count, error: err } = await query;
    if (err) throw err;
    return { rows: (data ?? []) as Product[], total: count ?? 0 };
  }, [cat, q, inStock]);

  const first = useLoad(() => fetchPage(0), [cat, q, inStock]);
  const extra = more.key === key ? more.items : [];
  const items = [...(first.data?.rows ?? []), ...extra];
  const total = first.data?.total ?? 0;
  const loading = first.loading;
  const error = first.error;

  async function loadMore() {
    setLoadingMore(true);
    try { const r = await fetchPage(items.length); setMore({ key, items: [...extra, ...r.rows] }); } finally { setLoadingMore(false); }
  }

  const closed = meta.status && !meta.status.open;
  return (
    <>
      <section className="mb-6 overflow-hidden rounded-3xl bg-brand-500 p-6 text-white sm:p-8">
        <h1 className="text-2xl font-bold sm:text-3xl">أهلًا بيك في متجر موظفي بريدفاست</h1>
        <p className="mt-2 text-brand-100">اختار منتجاتك، حدد ميعاد الاستلام، وادفع أونلاين.</p>
      </section>

      {closed && (
        <div role="status" className="mb-4 rounded-2xl bg-amber-50 p-4 text-warning">
          {meta.status?.reason === "AFTER_CUTOFF" ? "انتهى وقت استقبال الطلبات النهاردة." : "المتجر لا يستقبل طلبات النهاردة. تقدر تتصفح المنتجات وتجهز سلتك."}
        </div>
      )}

      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_auto]">
        <Input type="search" placeholder="ابحث بالاسم أو الباركود..." value={search} onChange={(e) => setSearch(e.target.value)} aria-label="بحث" />
        <label className="flex items-center gap-2 rounded-xl border border-line bg-white px-4 py-2 text-sm">
          <input type="checkbox" checked={inStock} onChange={(e) => setInStock(e.target.checked)} /> المتاح فقط
        </label>
      </div>

      <div className="mb-5 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="الأقسام">
        {[{ id: null as string | null, name: "الكل" }, ...meta.categories].map((c) => (
          <button key={c.id ?? "all"} role="tab" aria-selected={cat === c.id} onClick={() => setCat(c.id)}
            className={cn("whitespace-nowrap rounded-full border px-4 py-2 text-sm font-semibold", cat === c.id ? "border-brand-500 bg-brand-500 text-white" : "border-line bg-white")}>{c.name}</button>
        ))}
      </div>

      {error && <ErrorBox message={error} onRetry={first.reload} />}
      {(loading && items.length === 0) || metaLoading ? <Spinner /> : items.length === 0 ? (
        <EmptyState title="مفيش منتجات مطابقة" hint="جرب كلمة بحث تانية أو قسم تاني." />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{items.map((p) => <ProductCard key={p.id} p={p} meta={meta} />)}</div>
          {items.length < total && <div className="mt-6 text-center"><Button variant="secondary" loading={loadingMore} onClick={loadMore}>عرض المزيد</Button></div>}
        </>
      )}

      {cart.count > 0 && (
        <Link href="/cart/" className="fixed inset-x-4 bottom-4 z-30 mx-auto flex max-w-md items-center justify-between rounded-2xl bg-brand-500 px-5 py-4 font-bold text-white shadow-xl">
          <span>السلة ({cart.count})</span><span>{egp(cart.subtotal)}</span>
        </Link>
      )}
    </>
  );
}

export default function HomePage() {
  return <AppShell><Store /></AppShell>;
}
