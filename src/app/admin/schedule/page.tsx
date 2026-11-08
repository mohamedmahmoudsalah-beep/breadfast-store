"use client";

import { useState } from "react";
import { AppShell, PageTitle } from "@/components/layout/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { DataTable, ErrorBox, Field, Modal, Spinner, Td, useToast } from "@/components/ui/misc";
import { getSupabase } from "@/lib/supabase/client";
import { rpc } from "@/lib/rpc";
import { useLoad } from "@/lib/hooks";
import { errorMessage } from "@/lib/errors";

const DAYS = ["", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت", "الأحد"];
type Slot = { id: string; label: string; start_time: string; end_time: string; capacity: number; is_active: boolean };

function Schedule() {
  const toast = useToast();
  const [edit, setEdit] = useState<{ id: string; label: string; start: string; end: string; capacity: string; is_active: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const { data, error, loading, reload } = useLoad(async () => {
    const [d, s] = await Promise.all([getSupabase().from("operating_days").select("weekday,is_enabled").order("weekday"), getSupabase().from("time_slots").select("*").order("start_time")]);
    if (d.error) throw d.error;
    return { days: (d.data ?? []) as { weekday: number; is_enabled: boolean }[], slots: (s.data ?? []) as Slot[] };
  });
  async function toggle(w: number, on: boolean) { try { await rpc("operating_day_set", { p_weekday: w, p_enabled: on }); await reload(); } catch (e) { toast(errorMessage(e), "error"); } }
  async function save() {
    if (!edit || busy) return; setBusy(true);
    try { await rpc("slot_save", { p: { id: edit.id || null, label: edit.label, start_time: edit.start, end_time: edit.end, capacity: Number(edit.capacity), is_active: edit.is_active } }); toast("تم الحفظ"); setEdit(null); await reload(); }
    catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  }
  if (loading && !data) return <Spinner />;
  if (error || !data) return <ErrorBox message={error ?? "خطأ"} onRetry={reload} />;
  return (
    <div className="grid gap-5">
      <Card>
        <h2 className="mb-3 font-bold">أيام عمل المتجر</h2>
        <div className="flex flex-wrap gap-2">
          {data.days.map((d) => <button key={d.weekday} onClick={() => toggle(d.weekday, !d.is_enabled)} aria-pressed={d.is_enabled}
            className={`rounded-xl border px-4 py-2 font-semibold ${d.is_enabled ? "border-brand-500 bg-brand-500 text-white" : "border-line bg-white text-muted"}`}>{DAYS[d.weekday]}</button>)}
        </div>
        <p className="mt-2 text-sm text-muted">الأيام غير المفعّلة لا تقبل طلبات. بداية اليوم التجاري من صفحة الإعدادات.</p>
      </Card>
      <div><Button onClick={() => setEdit({ id: "", label: "", start: "13:00", end: "14:00", capacity: "20", is_active: true })}>+ موعد جديد</Button></div>
      <DataTable head={["الموعد", "من", "إلى", "السعة (طلبات)", "الحالة", ""]}>
        {data.slots.map((s) => <tr key={s.id}><Td>{s.label}</Td><Td dir="ltr">{s.start_time.slice(0, 5)}</Td><Td dir="ltr">{s.end_time.slice(0, 5)}</Td><Td>{s.capacity}</Td>
          <Td><Badge tone={s.is_active ? "success" : "neutral"}>{s.is_active ? "مفعّل" : "موقوف"}</Badge></Td>
          <Td><Button size="sm" variant="secondary" onClick={() => setEdit({ id: s.id, label: s.label, start: s.start_time.slice(0, 5), end: s.end_time.slice(0, 5), capacity: String(s.capacity), is_active: s.is_active })}>تعديل</Button></Td></tr>)}
      </DataTable>
      <Modal open={Boolean(edit)} title={edit?.id ? "تعديل موعد" : "موعد جديد"} onClose={() => setEdit(null)}>
        {edit && <div className="grid gap-3">
          <Field label="الاسم"><Input value={edit.label} onChange={(e) => setEdit({ ...edit, label: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="من"><Input type="time" value={edit.start} onChange={(e) => setEdit({ ...edit, start: e.target.value })} /></Field>
            <Field label="إلى"><Input type="time" value={edit.end} onChange={(e) => setEdit({ ...edit, end: e.target.value })} /></Field>
          </div>
          <Field label="السعة (أقصى عدد طلبات)"><Input type="number" min={0} value={edit.capacity} onChange={(e) => setEdit({ ...edit, capacity: e.target.value })} /></Field>
          <label className="flex items-center gap-2"><input type="checkbox" checked={edit.is_active} onChange={(e) => setEdit({ ...edit, is_active: e.target.checked })} /> مفعّل</label>
          <Button loading={busy} onClick={save}>حفظ</Button>
        </div>}
      </Modal>
    </div>
  );
}
export default function AdminSchedule() { return <AppShell guard={{ employee: false, perm: "schedule.manage" }}><PageTitle title="المواعيد وأيام العمل" /><Schedule /></AppShell>; }
