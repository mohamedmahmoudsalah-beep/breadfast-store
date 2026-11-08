"use client";

import Link from "next/link";
import { useEffect } from "react";
import { AppShell, PageTitle } from "@/components/layout/shell";
import { Card } from "@/components/ui/card";
import { EmptyState, ErrorBox, Spinner } from "@/components/ui/misc";
import { getSupabase } from "@/lib/supabase/client";
import { rpc } from "@/lib/rpc";
import { useLoad, useRealtime } from "@/lib/hooks";
import { useAuth } from "@/lib/auth";
import { cairoDateTime } from "@/lib/format";

type N = { id: string; title: string; body: string | null; order_id: string | null; read_at: string | null; created_at: string };

function List() {
  const { session } = useAuth();
  const { data, error, loading, reload } = useLoad(async () => {
    const { data: rows, error: err } = await getSupabase().from("notifications").select("id,title,body,order_id,read_at,created_at").order("created_at", { ascending: false }).limit(100);
    if (err) throw err; return rows as N[];
  });
  useRealtime("notifications", session ? `user_id=eq.${session.user.id}` : undefined, () => void reload(), 60_000);
  useEffect(() => { if (data?.some((n) => !n.read_at)) void rpc("notifications_mark_read", {}).catch(() => {}); }, [data]);
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox message={error} onRetry={reload} />;
  if (!data?.length) return <EmptyState title="مفيش إشعارات" />;
  return (
    <div className="grid gap-2">
      {data.map((n) => {
        const inner = (
          <Card className={n.read_at ? "" : "border-brand-300 bg-brand-50"}>
            <p className="font-bold">{n.title}</p>{n.body && <p className="text-sm">{n.body}</p>}<p className="mt-1 text-xs text-muted">{cairoDateTime(n.created_at)}</p>
          </Card>);
        return n.order_id ? <Link key={n.id} href={`/order/?id=${n.order_id}`}>{inner}</Link> : <div key={n.id}>{inner}</div>;
      })}
    </div>
  );
}

export default function NotificationsPage() { return <AppShell><PageTitle title="الإشعارات" /><List /></AppShell>; }
