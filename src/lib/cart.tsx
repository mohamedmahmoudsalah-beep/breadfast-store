"use client";

import { createContext, useContext, useMemo, useState } from "react";

export type CartLine = { product_id: string; name: string; image_url: string | null; price_piastres: number; qty: number; stock_qty: number; category_id: string | null };
type CartCtx = {
  lines: CartLine[]; count: number; subtotal: number;
  setQty: (line: Omit<CartLine, "qty">, qty: number) => void; remove: (id: string) => void; clear: () => void;
  checkoutKey: string; newCheckoutKey: () => void;
};
const CartContext = createContext<CartCtx | null>(null);
const KEY = "bf-cart-v1";
const KEY_ID = "bf-checkout-key";

const makeKey = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export function CartProvider({ children }: { children: React.ReactNode }) {
  // Lazy init from localStorage. Safe for the static export: nothing cart-dependent renders before the client has loaded the session.
  const [lines, setLines] = useState<CartLine[]>(() => {
    if (typeof window === "undefined") return [];
    try { return JSON.parse(localStorage.getItem(KEY) ?? "[]"); } catch { return []; }
  });
  const [checkoutKey, setCheckoutKey] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    let k = localStorage.getItem(KEY_ID);
    if (!k) { k = makeKey(); localStorage.setItem(KEY_ID, k); }
    return k;
  });

  const persist = (next: CartLine[]) => {
    setLines(next); localStorage.setItem(KEY, JSON.stringify(next));
    // cart changed => a different order intent => new idempotency key (same cart + same key = same order, even across tabs)
    const k = makeKey(); localStorage.setItem(KEY_ID, k); setCheckoutKey(k);
  };

  const value = useMemo<CartCtx>(() => ({
    lines,
    count: lines.reduce((t, l) => t + l.qty, 0),
    subtotal: lines.reduce((t, l) => t + l.qty * l.price_piastres, 0),
    setQty: (line, qty) => {
      const rest = lines.filter((l) => l.product_id !== line.product_id);
      persist(qty > 0 ? [...rest, { ...line, qty }].sort((a, b) => a.name.localeCompare(b.name)) : rest);
    },
    remove: (id) => persist(lines.filter((l) => l.product_id !== id)),
    clear: () => persist([]),
    checkoutKey,
    newCheckoutKey: () => { const k = makeKey(); localStorage.setItem(KEY_ID, k); setCheckoutKey(k); },
  }), [lines, checkoutKey]);

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart() {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside CartProvider");
  return ctx;
}
