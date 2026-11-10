"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AppShell, PageTitle } from "@/components/layout/shell";
import { ProductImage } from "@/components/store/product-card";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, Spinner } from "@/components/ui/misc";
import { getSupabase } from "@/lib/supabase/client";
import { useCart } from "@/lib/cart";
import { useStoreMeta } from "@/lib/store";
import { egp } from "@/lib/format";

function CartView() {
  const cart = useCart();
  const { meta, loading } = useStoreMeta();
  const [synced, setSynced] = useState(cart.lines.length === 0);

  // refresh live stock/price/activity of what is in the cart
  useEffect(() => {
    if (cart.lines.length === 0) return;
    void getSupabase().from("products").select("id,name,image_url,price_piastres,stock_qty,category_id,is_active")
      .in("id", cart.lines.map((l) => l.product_id)).then(({ data }) => {
        for (const l of cart.lines) {
          const fresh = data?.find((p) => p.id === l.product_id);
          if (!fresh || !fresh.is_active || fresh.stock_qty <= 0) cart.remove(l.product_id);
          else if (fresh.price_piastres !== l.price_piastres || fresh.stock_qty !== l.stock_qty || l.qty > fresh.stock_qty) {
            cart.setQty({ product_id: l.product_id, name: fresh.name, image_url: fresh.image_url, price_piastres: fresh.price_piastres, stock_qty: fresh.stock_qty, category_id: fresh.category_id }, Math.min(l.qty, fresh.stock_qty));
          }
        }
        setSynced(true);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading || !synced) return <Spinner />;
  if (cart.lines.length === 0) return <EmptyState title="السلة فاضية" hint="ضيف منتجات من المتجر." action={<Link href="/"><Button>تصفح المنتجات</Button></Link>} />;

  const overLimit = Object.entries(meta.limits).flatMap(([catId, lim]) => {
    const qty = cart.lines.filter((l) => l.category_id === catId).reduce((t, l) => t + l.qty, 0);
    const name = meta.categories.find((c) => c.id === catId)?.name ?? "قسم";
    return qty > lim.max - lim.used ? [`${name}: المتاح لك ${Math.max(lim.max - lim.used, 0)} فقط`] : [];
  });

  // can this line go up by one? (stock, per-order maximum, and the daily category limit shared by the whole cart)
  const canIncrease = (l: (typeof cart.lines)[number]) => {
    if (l.qty >= l.stock_qty || l.qty >= (meta.settings?.max_item_qty ?? 50)) return false;
    const lim = l.category_id ? meta.limits[l.category_id] : undefined;
    if (!lim) return true;
    const inCategory = cart.lines.filter((x) => x.category_id === l.category_id).reduce((t, x) => t + x.qty, 0);
    return inCategory + 1 <= lim.max - lim.used;
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_20rem]">
      <div className="grid gap-3">
        {cart.lines.map((l) => (
          <Card key={l.product_id} className="flex items-center gap-3 p-3">
            <ProductImage src={l.image_url} name={l.name} className="h-20 w-20 shrink-0 rounded-xl" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{l.name}</p>
              <p className="text-brand-600">{egp(l.price_piastres)}</p>
              <div className="mt-1 flex items-center gap-2">
                <Button size="sm" variant="secondary" aria-label="تقليل" onClick={() => cart.setQty(l, l.qty - 1)}>−</Button>
                <span className="min-w-8 text-center font-bold">{l.qty}</span>
                <Button size="sm" variant="secondary" aria-label="زيادة" disabled={!canIncrease(l)} onClick={() => cart.setQty(l, l.qty + 1)}>+</Button>
                <button className="ms-2 text-sm text-danger underline" onClick={() => cart.remove(l.product_id)}>حذف</button>
              </div>
            </div>
            <p className="font-bold">{egp(l.price_piastres * l.qty)}</p>
          </Card>
        ))}
      </div>
      <Card className="h-fit">
        <h2 className="text-lg font-bold">ملخص السلة</h2>
        <div className="mt-3 flex justify-between"><span>إجمالي المنتجات</span><b>{egp(cart.subtotal)}</b></div>
        <p className="mt-2 text-sm text-muted">رسوم الكيس والرسوم الإدارية بتتحسب في صفحة الدفع.</p>
        {overLimit.length > 0 && <ul className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-warning">{overLimit.map((m) => <li key={m}>{m}</li>)}</ul>}
        {meta.status && !meta.status.open && <p className="mt-3 rounded-xl bg-amber-50 p-3 text-sm text-warning">المتجر لا يستقبل طلبات حاليًا.</p>}
        <Link href="/checkout/"><Button size="lg" className="mt-4 w-full" disabled={overLimit.length > 0 || Boolean(meta.status && !meta.status.open)}>المتابعة للدفع</Button></Link>
      </Card>
    </div>
  );
}

export default function CartPage() {
  return <AppShell><PageTitle title="السلة" /><CartView /></AppShell>;
}
