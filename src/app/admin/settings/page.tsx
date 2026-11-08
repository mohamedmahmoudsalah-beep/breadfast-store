"use client";

import { useState } from "react";
import { AppShell, PageTitle } from "@/components/layout/shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ErrorBox, Field, Spinner, useToast } from "@/components/ui/misc";
import { useAuth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase/client";
import { rpc } from "@/lib/rpc";
import { useLoad } from "@/lib/hooks";
import { errorMessage } from "@/lib/errors";
import { parseEgpToPiastres } from "@/lib/format";

type Setting = { key: string; value: unknown };
// [key, label, kind, hint]
const FIELDS: [string, string, "egp" | "pct" | "int" | "time" | "bool", string?][] = [
  ["business_day_start", "بداية اليوم التجاري (توقيت القاهرة)", "time", "الحدود اليومية للأقسام بتتصفّر عند الساعة دي."],
  ["bag_initial_piastres", "رسوم الكيس المبدئية (جنيه)", "egp"],
  ["fee_bp", "رسوم المعالجة (%) على إجمالي المنتجات", "pct", "مثال: 1 = واحد في المية."],
  ["reassign_minutes", "إعادة التوزيع لو المجهّز لم يبدأ خلال (دقائق)", "int"],
  ["reservation_expiry_minutes", "مهلة الدفع قبل إلغاء الحجز (دقائق)", "int"],
  ["min_lead_minutes", "أقل مدة قبل بداية الموعد (دقائق)", "int"],
  ["booking_cutoff_time", "آخر وقت لاستقبال الطلبات يوميًا", "time"],
  ["picker_max_active_orders", "أقصى عدد طلبات نشطة لكل مجهّز", "int"],
  ["max_item_qty", "أقصى كمية من المنتج الواحد في الطلب", "int"],
  ["oos_return_to_stock", "إرجاع الكمية غير المتوفرة للمخزون عند التجهيز", "bool", "الافتراضي: لا (الوحدة اللي المجهّز مالقاهاش مش بترجع للمتاح)."],
];

function Settings() {
  const { can } = useAuth();
  const toast = useToast();
  const [edits, setEdits] = useState<Record<string, string | boolean>>({});
  const [bagEdits, setBagEdits] = useState<{ small?: string; large?: string }>({});
  const [busy, setBusy] = useState(false);
  const { data, error, loading, reload } = useLoad(async () => {
    const [s, b] = await Promise.all([getSupabase().from("app_settings").select("key,value"), getSupabase().from("bag_pricing").select("bag_type,price_piastres")]);
    if (s.error) throw s.error;
    return { s: (s.data ?? []) as Setting[], b: (b.data ?? []) as { bag_type: string; price_piastres: number }[] };
  });
  const fromData = (k: string, kind: string): string | boolean => {
    const raw = data?.s.find((x) => x.key === k)?.value;
    return kind === "bool" ? Boolean(raw) : kind === "egp" || kind === "pct" ? String(Number(raw) / 100) : String(raw ?? "");
  };
  const vals = new Proxy({} as Record<string, string | boolean>, { get: (_t, k: string) => (k in edits ? edits[k] : fromData(k, FIELDS.find((f) => f[0] === k)?.[2] ?? "")) });
  const setVals = (next: Record<string, string | boolean>) => setEdits((e) => ({ ...e, ...next }));
  const bags = {
    small: bagEdits.small ?? String((data?.b.find((x) => x.bag_type === "small")?.price_piastres ?? 0) / 100),
    large: bagEdits.large ?? String((data?.b.find((x) => x.bag_type === "large")?.price_piastres ?? 0) / 100),
  };
  const setBags = (b: { small: string; large: string }) => setBagEdits(b);

  async function save(key: string, kind: string) {
    if (busy) return; setBusy(true);
    try {
      const raw = vals[key]; let value: unknown;
      if (kind === "bool") value = Boolean(raw);
      else if (kind === "time") value = String(raw);
      else if (kind === "egp") { const p = parseEgpToPiastres(String(raw)); if (p === null) throw new Error("INVALID_INPUT"); value = p; }
      else if (kind === "pct") { const n = Number(raw); if (!Number.isFinite(n) || n < 0) throw new Error("INVALID_INPUT"); value = Math.round(n * 100); }
      else value = Number(raw);
      await rpc("setting_set", { p_key: key, p_value: value }); toast("تم الحفظ"); await reload();
    } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  }
  async function saveBag(type: "small" | "large") {
    const p = parseEgpToPiastres(bags[type]); if (p === null) { toast("السعر غير صحيح", "error"); return; }
    try { await rpc("bag_price_set", { p_type: type, p_price: p }); toast("تم الحفظ"); await reload(); } catch (e) { toast(errorMessage(e), "error"); }
  }
  if (loading && !data) return <Spinner />;
  if (error || !data) return <ErrorBox message={error ?? "خطأ"} onRetry={reload} />;
  return (
    <div className="grid max-w-2xl gap-4">
      {can("bags.manage") && (
        <Card className="grid gap-3"><h2 className="font-bold">أسعار الأكياس (بتُحسب وقت التجهيز)</h2>
          {(["small", "large"] as const).map((t) => (
            <div key={t} className="flex items-end gap-2"><div className="flex-1"><Field label={t === "small" ? "كيس صغير (جنيه)" : "كيس كبير (جنيه)"}><Input value={bags[t]} inputMode="decimal" dir="ltr" onChange={(e) => setBags({ ...bags, [t]: e.target.value })} /></Field></div><Button onClick={() => saveBag(t)}>حفظ</Button></div>
          ))}
        </Card>
      )}
      <Card className="grid gap-4">
        <h2 className="font-bold">إعدادات النظام</h2>
        {FIELDS.map(([k, label, kind, hint]) => (
          <div key={k} className="flex items-end gap-2">
            <div className="flex-1"><Field label={label} hint={hint}>
              {kind === "bool" ? <input type="checkbox" className="h-6 w-6" checked={Boolean(vals[k])} onChange={(e) => setVals({ [k]: e.target.checked })} />
                : <Input value={String(vals[k] ?? "")} type={kind === "time" ? "time" : "text"} dir="ltr" onChange={(e) => setVals({ [k]: e.target.value })} />}
            </Field></div>
            <Button onClick={() => save(k, kind)} loading={busy}>حفظ</Button>
          </div>
        ))}
      </Card>
    </div>
  );
}
export default function AdminSettings() { return <AppShell guard={{ employee: false, perm: "settings.manage" }}><PageTitle title="الإعدادات" /><Settings /></AppShell>; }
