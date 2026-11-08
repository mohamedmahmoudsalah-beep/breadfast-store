"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { AppShell } from "@/components/layout/shell";
import { ProductImage, QtyControl, useMaxAddable } from "@/components/store/product-card";
import { Badge } from "@/components/ui/badge";
import { EmptyState, ErrorBox, Spinner } from "@/components/ui/misc";
import { getSupabase } from "@/lib/supabase/client";
import { useLoad } from "@/lib/hooks";
import { useStoreMeta, type Product } from "@/lib/store";
import { egp } from "@/lib/format";

function Details() {
  const id = useSearchParams().get("id");
  const { meta } = useStoreMeta();
  const { data, error, loading } = useLoad(async () => {
    const { data: row, error: err } = await getSupabase().from("products")
      .select("id,barcode,name,image_url,price_piastres,stock_qty,category_id,categories(name)").eq("id", id ?? "").maybeSingle();
    if (err) throw err;
    return row as (Product & { categories: { name: string } | null }) | null;
  }, [id]);
  if (loading) return <Spinner />;
  if (error) return <ErrorBox message={error} />;
  if (!data) return <EmptyState title="المنتج غير موجود" />;
  return <Body p={data} meta={meta} />;
}

function Body({ p, meta }: { p: Product & { categories: { name: string } | null }; meta: ReturnType<typeof useStoreMeta>["meta"] }) {
  const { remainingLimit } = useMaxAddable(p, meta);
  return (
    <div className="grid gap-6 rounded-3xl bg-white p-5 md:grid-cols-2">
      <ProductImage src={p.image_url} name={p.name} className="aspect-square w-full rounded-2xl" />
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-bold">{p.name}</h1>
        {p.categories && <Badge tone="brand" className="w-fit">{p.categories.name}</Badge>}
        <p className="text-3xl font-bold text-brand-600">{egp(p.price_piastres)}</p>
        <p className="text-sm text-muted">السعر هو السعر النهائي للموظف بدون أي هامش ربح.</p>
        <p>{p.stock_qty > 0 ? `متاح في المخزون: ${p.stock_qty}` : "غير متاح حاليًا"}</p>
        {remainingLimit !== null && <p className="text-brand-700">المتبقي لك اليوم من هذا القسم: {remainingLimit}</p>}
        <p className="text-sm text-muted" dir="ltr">Barcode: {p.barcode}</p>
        <div className="mt-2"><QtyControl p={p} meta={meta} large /></div>
      </div>
    </div>
  );
}

export default function ProductPage() {
  return <AppShell><Suspense fallback={<Spinner />}><Details /></Suspense></AppShell>;
}
