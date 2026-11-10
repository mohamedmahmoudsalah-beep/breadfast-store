import { APP_TIMEZONE } from "@/lib/config";

export const egp = (piastres: number | null | undefined) =>
  new Intl.NumberFormat("ar-EG", { style: "currency", currency: "EGP" }).format((piastres ?? 0) / 100);

export const num = (n: number | null | undefined) => new Intl.NumberFormat("ar-EG").format(n ?? 0);

export const cairoDateTime = (iso: string | null | undefined) =>
  iso
    ? new Intl.DateTimeFormat("ar-EG", { timeZone: APP_TIMEZONE, dateStyle: "medium", timeStyle: "short" }).format(new Date(iso))
    : "—";

export const cairoTime = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat("ar-EG", { timeZone: APP_TIMEZONE, timeStyle: "short" }).format(new Date(iso)) : "—";

/** "12.5" or "12,50" (EGP) -> piastres */
export function parseEgpToPiastres(v: string): number | null {
  const n = Number(v.replace(",", ".").trim());
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

export const orderNo = (n: number | string | null | undefined) => (n ? `BF-${n}` : "بانتظار الدفع");

export const ORDER_STATUS_LABEL: Record<string, string> = {
  pending_payment: "في انتظار الدفع",
  confirmed: "تم التأكيد",
  waiting_picker: "في انتظار مجهّز",
  assigned: "معيّن لمجهّز",
  preparing: "جاري التجهيز",
  ready_handover: "جاهز للتسليم لنقطة الاستلام",
  received_pickup: "وصل نقطة الاستلام",
  ready_collection: "جاهز للاستلام",
  collected: "تم الاستلام",
  canceled: "ملغي",
  expired: "انتهت مهلة الدفع",
};

export const STATUS_TONE: Record<string, "neutral" | "brand" | "success" | "warning" | "danger"> = {
  pending_payment: "warning", waiting_picker: "neutral", assigned: "neutral", preparing: "brand",
  ready_handover: "brand", received_pickup: "brand", ready_collection: "success", collected: "success",
  canceled: "danger", expired: "danger", confirmed: "neutral",
};

export const ORDER_FLOW = ["pending_payment", "waiting_picker", "assigned", "preparing", "ready_handover", "received_pickup", "ready_collection", "collected"];
