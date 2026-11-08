"use client";

import Link from "next/link";
import { AppShell, PageTitle } from "@/components/layout/shell";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorBox, Spinner } from "@/components/ui/misc";
import { useAuth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase/client";
import { useLoad, useRealtime } from "@/lib/hooks";
import { ORDER_STATUS_LABEL, STATUS_TONE, cairoDateTime, egp, orderNo } from "@/lib/format";

type Row = { id: string; order_no: number; status: string; created_at: string; total_piastres: number; final_total_piastres: number | null; slot_label: string | null; extra_due_piastres: number };

function List() {
  const { session } = useAuth();
  const { data, error, loading, reload } = useLoad(async () => {
    const { data: rows, error: err } = await getSupabase().from("orders")
      .select("id,order_no,status,created_at,total_piastres,final_total_piastres,slot_label,extra_due_piastres").order("created_at", { ascending: false }).limit(100);
    if (err) throw err; return rows as Row[];
  });
  useRealtime("orders", session ? `user_id=eq.${session.user.id}` : undefined, () => void reload());
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!data?.length) return <EmptyState title="لسه معندكش طلبات" action={<Link className="font-semibold text-brand-600 underline" href="/">ابدأ التسوق</Link>} />;
  return (
    <div className="grid gap-3">
      {data.map((o) => (
        <Link key={o.id} href={`/order/?id=${o.id}`}>
          <Card className="flex flex-wrap items-center justify-between gap-3 hover:border-brand-300">
            <div>
              <p className="font-bold">{orderNo(o.order_no)}</p>
              <p className="text-sm text-muted">{cairoDateTime(o.created_at)} • {o.slot_label}</p>
            </div>
            <div className="flex items-center gap-3">
              {o.extra_due_piastres > 0 && <Badge tone="warning">مطلوب دفع إضافي</Badge>}
              <Badge tone={STATUS_TONE[o.status] ?? "neutral"}>{ORDER_STATUS_LABEL[o.status] ?? o.status}</Badge>
              <b>{egp(o.final_total_piastres ?? o.total_piastres)}</b>
            </div>
          </Card>
        </Link>
      ))}
    </div>
  );
}

export default function OrdersPage() {
  return <AppShell><PageTitle title="طلباتي" /><List /></AppShell>;
}
