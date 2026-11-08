"use client";

import { AppShell, PageTitle } from "@/components/layout/shell";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorBox, Spinner } from "@/components/ui/misc";
import { getSupabase } from "@/lib/supabase/client";
import { useLoad } from "@/lib/hooks";
import { cairoDateTime, egp } from "@/lib/format";
import { WALLET_REASON } from "@/lib/store";

type Tx = { id: string; direction: "credit" | "debit"; amount_piastres: number; reason: string; created_at: string; balance_after: number };

function Wallet() {
  const { data, error, loading, reload } = useLoad(async () => {
    const supabase = getSupabase();
    const [w, t] = await Promise.all([
      supabase.from("wallets").select("balance_piastres").maybeSingle(),
      supabase.from("wallet_transactions").select("id,direction,amount_piastres,reason,created_at,balance_after").order("created_at", { ascending: false }).limit(200),
    ]);
    if (t.error) throw t.error;
    return { balance: w.data ? Number(w.data.balance_piastres) : 0, txs: (t.data ?? []) as Tx[] };
  });
  if (loading) return <Spinner />;
  if (error || !data) return <ErrorBox message={error ?? "خطأ"} onRetry={reload} />;
  return (
    <div className="grid gap-5">
      <Card className="bg-brand-500 text-white"><p className="text-brand-100">رصيد المحفظة</p><p className="text-4xl font-bold">{egp(data.balance)}</p></Card>
      {data.txs.length === 0 ? <EmptyState title="لا توجد حركات بعد" hint="الاستردادات وفروق الأكياس بتظهر هنا." /> : (
        <Card className="p-0">
          <ul className="divide-y divide-line">
            {data.txs.map((t) => (
              <li key={t.id} className="flex items-center justify-between gap-3 px-5 py-3">
                <div><p className="font-semibold">{WALLET_REASON[t.reason] ?? t.reason}</p><p className="text-sm text-muted">{cairoDateTime(t.created_at)}</p></div>
                <div className="text-end"><p className={t.direction === "credit" ? "font-bold text-success" : "font-bold text-danger"}>{t.direction === "credit" ? "+" : "−"}{egp(t.amount_piastres)}</p><p className="text-xs text-muted">الرصيد: {egp(t.balance_after)}</p></div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

export default function WalletPage() { return <AppShell><PageTitle title="محفظتي" /><Wallet /></AppShell>; }
