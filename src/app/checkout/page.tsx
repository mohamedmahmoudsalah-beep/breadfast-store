"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AppShell, PageTitle } from "@/components/layout/shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState, Spinner } from "@/components/ui/misc";
import { useCart } from "@/lib/cart";
import { useStoreMeta, feeFor } from "@/lib/store";
import { rpc } from "@/lib/rpc";
import { getSupabase } from "@/lib/supabase/client";
import { egp } from "@/lib/format";
import { errorCode, errorDetail, errorMessage } from "@/lib/errors";
import { startCardPayment } from "@/lib/payments";
import { cn } from "@/lib/utils";

type Slot = { slot_id: string; label: string; start_time: string; end_time: string; remaining: number; can_book: boolean };
type OrderResult = { order_id: string; card_due_piastres: number; status: string };

function Checkout() {
  const router = useRouter();
  const cart = useCart();
  const { meta, loading } = useStoreMeta();
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<string>("");
  const [balance, setBalance] = useState(0);
  const [useWallet, setUseWallet] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pendingOrder, setPendingOrder] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const supabase = getSupabase();
      const [s, w] = await Promise.all([supabase.rpc("available_slots"), supabase.from("wallets").select("balance_piastres").maybeSingle()]);
      setSlots((s.data ?? []) as Slot[]); setBalance(w.data ? Number(w.data.balance_piastres) : 0);
    })();
  }, []);

  if (loading || slots === null) return <Spinner />;
  if (cart.lines.length === 0) return <EmptyState title="السلة فاضية" action={<Link href="/"><Button>المتجر</Button></Link>} />;
  const s = meta.settings!;
  const fee = feeFor(cart.subtotal, s.fee_bp);
  const total = cart.subtotal + s.bag_initial_piastres + fee;
  const walletUsed = useWallet ? Math.min(balance, total) : 0;
  const cardDue = total - walletUsed;
  const closed = meta.status && !meta.status.open;

  async function confirm() {
    if (busy) return;                                   // frontend guard (the server is the real protection)
    if (!slot) { setError("اختار ميعاد الاستلام الأول."); return; }
    setBusy(true); setError(""); setPendingOrder(null);
    try {
      const res = await rpc<OrderResult>("create_order", {
        p_items: cart.lines.map((l) => ({ product_id: l.product_id, qty: l.qty })),
        p_slot_id: slot, p_idempotency_key: cart.checkoutKey, p_use_wallet: useWallet,
      });
      cart.clear();
      if (res.card_due_piastres > 0) {
        try { await startCardPayment(res.order_id, "order"); return; }
        catch { router.replace(`/order/?id=${res.order_id}&pay=failed`); return; }
      }
      router.replace(`/order/?id=${res.order_id}`);
    } catch (e) {
      if (errorCode(e) === "PENDING_ORDER_EXISTS") setPendingOrder(errorDetail(e) ?? null);
      setError(errorMessage(e)); setBusy(false);
    }
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_22rem]">
      <div className="grid gap-5">
        <Card>
          <h2 className="mb-3 text-lg font-bold">1) ميعاد الاستلام</h2>
          {closed ? <p className="rounded-xl bg-amber-50 p-3 text-warning">المتجر لا يستقبل طلبات حاليًا.</p>
            : slots.length === 0 ? <p className="rounded-xl bg-amber-50 p-3 text-warning">مفيش مواعيد متاحة دلوقتي.</p> : (
            <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="المواعيد">
              {slots.map((sl) => (
                <button key={sl.slot_id} type="button" role="radio" aria-checked={slot === sl.slot_id} disabled={!sl.can_book}
                  onClick={() => setSlot(sl.slot_id)}
                  className={cn("rounded-xl border p-3 text-start", slot === sl.slot_id ? "border-brand-500 bg-brand-50" : "border-line", !sl.can_book && "cursor-not-allowed opacity-50")}>
                  <span className="block font-semibold">{sl.label}</span>
                  <span className="block text-sm text-muted" dir="ltr">{sl.start_time.slice(0, 5)} - {sl.end_time.slice(0, 5)}</span>
                  <span className="block text-sm">{sl.can_book ? `متبقي ${sl.remaining} طلب` : "اكتمل العدد"}</span>
                </button>
              ))}
            </div>
          )}
        </Card>
        <Card>
          <h2 className="mb-3 text-lg font-bold">2) الدفع</h2>
          <p className="text-muted">الدفع بالكارت (فيزا / ماستركارد) عن طريق صفحة Paymob الآمنة. بياناتك البنكية لا تمر على موقعنا.</p>
          {balance > 0 && (
            <label className="mt-3 flex items-center gap-3 rounded-xl bg-brand-50 p-3">
              <input type="checkbox" checked={useWallet} onChange={(e) => setUseWallet(e.target.checked)} />
              <span>استخدم رصيد المحفظة ({egp(balance)})</span>
            </label>
          )}
        </Card>
      </div>
      <Card className="h-fit">
        <h2 className="text-lg font-bold">ملخص الطلب</h2>
        <dl className="mt-3 grid gap-2">
          <div className="flex justify-between"><dt>إجمالي المنتجات</dt><dd>{egp(cart.subtotal)}</dd></div>
          <div className="flex justify-between"><dt>كيس التسوق (مبدئي)</dt><dd>{egp(s.bag_initial_piastres)}</dd></div>
          <div className="flex justify-between"><dt>رسوم الدفع ({(s.fee_bp / 100).toString()}%)</dt><dd>{egp(fee)}</dd></div>
          <div className="flex justify-between border-t border-line pt-2 text-lg font-bold"><dt>الإجمالي</dt><dd>{egp(total)}</dd></div>
          {walletUsed > 0 && <div className="flex justify-between text-success"><dt>من المحفظة</dt><dd>−{egp(walletUsed)}</dd></div>}
          <div className="flex justify-between font-bold"><dt>المطلوب بالكارت</dt><dd>{egp(cardDue)}</dd></div>
        </dl>
        <p className="mt-3 text-sm text-muted">فرق تكلفة الأكياس الفعلية بيتسوّى بعد التجهيز (يرجع لمحفظتك لو أقل، أو يُطلب منك لو أكتر). المنتجات غير المتوفرة بتتحاسب عليها بالاسترداد.</p>
        {error && <p role="alert" className="mt-3 rounded-xl bg-red-50 p-3 text-danger">{error}{pendingOrder && <> <Link className="font-semibold underline" href={`/order/?id=${pendingOrder}`}>فتح الطلب</Link></>}</p>}
        <Button size="lg" className="mt-4 w-full" loading={busy} disabled={Boolean(closed) || !slot} onClick={confirm}>
          {cardDue > 0 ? "تأكيد الطلب والدفع" : "تأكيد الطلب"}
        </Button>
      </Card>
    </div>
  );
}

export default function CheckoutPage() {
  return <AppShell><PageTitle title="إتمام الطلب" /><Checkout /></AppShell>;
}
