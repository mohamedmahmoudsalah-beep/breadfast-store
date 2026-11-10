"use client";

import { useState } from "react";
import { AppShell, PageTitle } from "@/components/layout/shell";
import { Input } from "@/components/ui/input";
import { DataTable, ErrorBox, Spinner, Td } from "@/components/ui/misc";
import { getSupabase } from "@/lib/supabase/client";
import { useDebounced, useLoad } from "@/lib/hooks";
import { cairoDateTime } from "@/lib/format";
import { ExcelButton } from "@/components/ui/file-drop";
import { downloadTable } from "@/lib/export";

type Log = { id: number; actor_id: string | null; action: string; entity_type: string | null; entity_id: string | null; before: unknown; after: unknown; created_at: string };

function Audit() {
  const [entity, setEntity] = useState("");
  const e = useDebounced(entity.trim().replace(/[^\w.-]/g, ""));
  const { data, error, loading, reload } = useLoad(async () => {
    let q = getSupabase().from("audit_logs").select("id,actor_id,action,entity_type,entity_id,before,after,created_at").order("id", { ascending: false }).limit(200);
    if (e) q = q.ilike("entity_type", `%${e}%`);
    const [logs, profiles] = await Promise.all([q, getSupabase().from("profiles").select("id,full_name,email")]);
    if (logs.error) throw logs.error;
    const names: Record<string, string> = {}; (profiles.data ?? []).forEach((p) => { names[p.id] = p.full_name ?? p.email ?? p.id; });
    return { logs: (logs.data ?? []) as Log[], names };
  }, [e]);
  if (loading && !data) return <Spinner />;
  if (error || !data) return <ErrorBox message={error ?? "خطأ"} onRetry={reload} />;
  return (
    <div className="grid gap-4">
      <Input className="max-w-xs" placeholder="فلترة بنوع العنصر (products, orders, ...)" value={entity} onChange={(ev) => setEntity(ev.target.value)} dir="ltr" />
      <div><ExcelButton onClick={() => downloadTable("audit-log.xlsx", "Audit", [
        { header: "Time", value: (l: Log) => l.created_at }, { header: "Actor", value: (l: Log) => (l.actor_id ? data.names[l.actor_id] ?? l.actor_id : "system") }, { header: "Action", value: (l: Log) => l.action },
        { header: "Entity", value: (l: Log) => `${l.entity_type ?? ""} ${l.entity_id ?? ""}` }, { header: "Before", value: (l: Log) => (l.before ? JSON.stringify(l.before) : "") }, { header: "After", value: (l: Log) => (l.after ? JSON.stringify(l.after) : "") }], data.logs)}>تنزيل Excel</ExcelButton></div>
      <DataTable head={["الوقت", "المنفّذ", "الإجراء", "العنصر", "قبل", "بعد"]}>
        {data.logs.map((l) => (
          <tr key={l.id}><Td>{cairoDateTime(l.created_at)}</Td><Td>{l.actor_id ? data.names[l.actor_id] ?? l.actor_id.slice(0, 8) : "النظام"}</Td><Td>{l.action}</Td><Td dir="ltr">{l.entity_type} {l.entity_id?.slice(0, 8)}</Td>
            <Td className="max-w-xs truncate" dir="ltr">{l.before ? JSON.stringify(l.before) : "—"}</Td><Td className="max-w-xs truncate" dir="ltr">{l.after ? JSON.stringify(l.after) : "—"}</Td></tr>
        ))}
      </DataTable>
    </div>
  );
}
export default function AdminAudit() { return <AppShell guard={{ employee: false, perm: "audit.view" }}><PageTitle title="سجل المراجعة" /><Audit /></AppShell>; }
