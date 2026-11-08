"use client";

import { useState } from "react";
import { AppShell, PageTitle } from "@/components/layout/shell";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, useToast } from "@/components/ui/misc";
import { rpc } from "@/lib/rpc";
import { buildSheets, downloadCsv, downloadXlsx, type ReportData } from "@/lib/export";
import { errorMessage } from "@/lib/errors";

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });

function Reports() {
  const toast = useToast();
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [busy, setBusy] = useState(false);
  const [data, setData] = useState<ReportData | null>(null);

  async function load() {
    if (busy) return; setBusy(true);
    try { setData(await rpc<ReportData>("report_sales", { p_from: from, p_to: to })); } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  }
  const sheets = data ? buildSheets(data) : [];
  const stamp = `${from}_${to}`;
  return (
    <div className="grid max-w-3xl gap-4">
      <Card className="grid gap-3 sm:grid-cols-3">
        <Field label="من"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="إلى"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <div className="flex items-end"><Button loading={busy} onClick={load}>تجهيز التقرير</Button></div>
      </Card>
      {data && (
        <Card className="grid gap-3">
          <h2 className="font-bold">التقرير جاهز</h2>
          <ul className="text-sm">{sheets.map((s) => <li key={s.name}>{s.name}: {s.rows.length} صف</li>)}</ul>
          <p className="text-sm text-muted">المبيعات = الطلبات المدفوعة وغير الملغية. الطلبات غير المدفوعة أو المنتهية لا تدخل في التقرير. المعادلة موضحة في ورقة Sales Summary.</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void downloadXlsx(sheets, `breadfast-sales_${stamp}.xlsx`)}>تنزيل Excel (4 أوراق)</Button>
            {sheets.map((s) => <Button key={s.name} variant="secondary" size="sm" onClick={() => downloadCsv(s, `${s.name.replace(/ /g, "-")}_${stamp}.csv`)}>CSV: {s.name}</Button>)}
          </div>
        </Card>
      )}
    </div>
  );
}
export default function AdminReports() { return <AppShell guard={{ employee: false, perm: "reports.export" }}><PageTitle title="تقارير المبيعات" /><Reports /></AppShell>; }
