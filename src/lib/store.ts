"use client";

import { useLoad } from "@/lib/hooks";
import { getSupabase } from "@/lib/supabase/client";
import { rpc } from "@/lib/rpc";

export type Product = { id: string; barcode: string; name: string; image_url: string | null; price_piastres: number; stock_qty: number; category_id: string | null };
export type Category = { id: string; name: string };
export type StoreStatus = { open: boolean; reason: string | null; business_date: string };
export type PublicSettings = { bag_initial_piastres: number; fee_bp: number; reservation_expiry_minutes: number; max_item_qty: number };

export type StoreMeta = {
  categories: Category[];
  limits: Record<string, { max: number; used: number }>;
  status: StoreStatus | null;
  settings: PublicSettings | null;
};

const EMPTY_META: StoreMeta = { categories: [], limits: {}, status: null, settings: null };

export function useStoreMeta() {
  const { data, loading, reload } = useLoad<StoreMeta>(async () => {
    const supabase = getSupabase();
    const [cats, usage, status, settings] = await Promise.all([
      supabase.from("categories").select("id,name").eq("is_active", true).order("sort_order").order("name"),
      supabase.rpc("my_category_usage"),
      rpc<StoreStatus>("store_status"),
      rpc<PublicSettings>("public_settings"),
    ]);
    const limits: StoreMeta["limits"] = {};
    for (const u of (usage.data ?? []) as { category_id: string; used: number; max_qty: number }[]) limits[u.category_id] = { max: u.max_qty, used: u.used };
    return { categories: (cats.data ?? []) as Category[], limits, status, settings };
  });
  return { meta: data ?? EMPTY_META, loading, reload };
}

/** Integer-only mirror of the server maths (the server is the source of truth). */
export const feeFor = (subtotal: number, feeBp: number) => Math.floor((subtotal * feeBp + 5000) / 10000);

export const WALLET_REASON: Record<string, string> = {
  refund: "استرداد", bag_difference: "فرق الأكياس", order_payment: "دفع طلب", order_unpaid_release: "إرجاع رصيد طلب لم يكتمل",
  bag_extra: "زيادة تكلفة الأكياس", manual_adjustment: "تعديل من الإدارة",
};
