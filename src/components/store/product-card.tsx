"use client";

import Link from "next/link";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { egp } from "@/lib/format";
import { useCart } from "@/lib/cart";
import type { Product, StoreMeta } from "@/lib/store";

export function ProductImage({ src, name, className = "" }: { src: string | null; name: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken) {
    return <div className={`flex items-center justify-center bg-brand-50 text-4xl font-bold text-brand-300 ${className}`} aria-label={name}>{name.slice(0, 1)}</div>;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt={name} loading="lazy" onError={() => setBroken(true)} className={`object-cover ${className}`} />;
}

/** How many more units of this product the employee may add right now. */
export function useMaxAddable(p: Product, meta: StoreMeta) {
  const cart = useCart();
  const inCart = cart.lines.find((l) => l.product_id === p.id)?.qty ?? 0;
  const maxItem = meta.settings?.max_item_qty ?? 50;
  let cap = Math.min(p.stock_qty, maxItem);
  let remainingLimit: number | null = null;
  if (p.category_id && meta.limits[p.category_id]) {
    const lim = meta.limits[p.category_id];
    const othersInCategory = cart.lines.filter((l) => l.category_id === p.category_id && l.product_id !== p.id).reduce((t, l) => t + l.qty, 0);
    remainingLimit = Math.max(lim.max - lim.used - othersInCategory, 0);
    cap = Math.min(cap, remainingLimit);
  }
  return { inCart, cap, remainingLimit };
}

export function QtyControl({ p, meta, large }: { p: Product; meta: StoreMeta; large?: boolean }) {
  const cart = useCart();
  const { inCart, cap } = useMaxAddable(p, meta);
  const line = { product_id: p.id, name: p.name, image_url: p.image_url, price_piastres: p.price_piastres, stock_qty: p.stock_qty, category_id: p.category_id };
  const closed = meta.status ? !meta.status.open : false;
  if (p.stock_qty <= 0) return <Badge tone="danger">نفد</Badge>;
  if (inCart === 0) {
    return <Button size={large ? "lg" : "sm"} disabled={cap <= 0 || closed} onClick={() => cart.setQty(line, 1)}>{cap <= 0 ? "وصلت للحد" : "أضف للسلة"}</Button>;
  }
  return (
    <div className="flex items-center gap-2" role="group" aria-label={`كمية ${p.name}`}>
      <Button size="sm" variant="secondary" onClick={() => cart.setQty(line, inCart - 1)} aria-label="تقليل">−</Button>
      <span className="min-w-8 text-center font-bold">{inCart}</span>
      <Button size="sm" variant="secondary" disabled={inCart >= inCart + cap} onClick={() => cart.setQty(line, inCart + 1)} aria-label="زيادة">+</Button>
    </div>
  );
}

export function ProductCard({ p, meta }: { p: Product; meta: StoreMeta }) {
  const { remainingLimit } = useMaxAddable(p, meta);
  return (
    <article className="flex flex-col overflow-hidden rounded-2xl border border-line bg-white">
      <Link href={`/product/?id=${p.id}`} className="block">
        <ProductImage src={p.image_url} name={p.name} className="aspect-square w-full" />
      </Link>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <Link href={`/product/?id=${p.id}`} className="line-clamp-2 min-h-12 font-semibold">{p.name}</Link>
        <p className="text-lg font-bold text-brand-600">{egp(p.price_piastres)}</p>
        <div className="flex flex-wrap gap-1">
          {p.stock_qty > 0 ? <Badge tone={p.stock_qty <= 5 ? "warning" : "success"}>متاح: {p.stock_qty}</Badge> : <Badge tone="danger">غير متاح</Badge>}
          {remainingLimit !== null && <Badge tone="brand">المتبقي لك اليوم: {remainingLimit}</Badge>}
        </div>
        <div className="mt-auto pt-1"><QtyControl p={p} meta={meta} /></div>
      </div>
    </article>
  );
}
