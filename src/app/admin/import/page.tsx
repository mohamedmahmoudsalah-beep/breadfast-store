"use client";

import { useState } from "react";
import { AppShell, PageTitle } from "@/components/layout/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { DataTable, Td, useToast } from "@/components/ui/misc";
import { getSupabase } from "@/lib/supabase/client";
import { rpc } from "@/lib/rpc";
import { mapRows, readTable } from "@/lib/files";
import { errorMessage } from "@/lib/errors";
import { cairoDateTime, egp } from "@/lib/format";

type Stage = { batch_id: string; total_rows: number; new_count: number; update_count: number; invalid_count: number; duplicate_of: { file_name: string; confirmed_at: string } | null };
type Item = { row_no: number; barcode: string | null; name: string | null; category_name: string | null; price_piastres: number | null; qty: number; action: string; error: string | null; old_qty: number; new_qty: number };

const ERR: Record<string, string> = {
  BARCODE_MISSING: "الباركود فاضي", NAME_REQUIRED_FOR_NEW: "منتج جديد بدون اسم", PRICE_REQUIRED_FOR_NEW: "منتج جديد بدون سعر", DUPLICATE_BARCODE_IN_FILE: "باركود مكرر داخل الملف",
  QTY_INVALID: "كمية غير صحيحة", PRICE_NEGATIVE: "سعر سالب", NUMBER_INVALID: "رقم غير صحيح", IMAGE_URL_INVALID: "رابط صورة غير صحيح",
};

function Import() {
  const toast = useToast();
  const [fileName, setFileName] = useState("");
  const [stage, setStage] = useState<Stage | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [allowDup, setAllowDup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");

  async function onFile(file: File | undefined) {
    if (!file) return;
    setBusy(true); setStage(null); setItems([]); setDone(""); setAllowDup(false); setFileName(file.name);
    try {
      const table = await readTable(file);
      const { rows, missing } = mapRows(table, ["barcode", "name", "category", "image_url", "price", "qty"]);
      if (missing.includes("barcode") || missing.includes("qty")) { toast("الملف لازم يحتوي على عمودي الباركود وكمية المخزون على الأقل.", "error"); return; }
      if (rows.length === 0) { toast("الملف فاضي.", "error"); return; }
      const res = await rpc<Stage>("import_stage", { p_file_name: file.name, p_rows: rows });
      const { data } = await getSupabase().from("stock_import_items").select("row_no,barcode,name,category_name,price_piastres,qty,action,error,old_qty,new_qty").eq("batch_id", res.batch_id).order("row_no").limit(5000);
      setStage(res); setItems((data ?? []) as Item[]);
    } catch (e) { toast(e instanceof Error && /[؀-ۿ]/.test(e.message) ? e.message : errorMessage(e), "error"); } finally { setBusy(false); }
  }

  async function confirm() {
    if (!stage || busy) return;
    setBusy(true);
    try {
      const r = await rpc<{ new_count: number; update_count: number }>("import_confirm", { p_batch: stage.batch_id, p_allow_duplicate: allowDup });
      setDone(`تم الاستيراد: ${r.new_count} منتج جديد، ${r.update_count} منتج تم تحديثه.`); setStage(null); setItems([]);
    } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  }
  async function cancel() { if (stage) await rpc("import_cancel", { p_batch: stage.batch_id }).catch(() => {}); setStage(null); setItems([]); }

  return (
    <div className="grid gap-4">
      <Card>
        <p className="font-semibold">الاستيراد بيضيف الكمية الجديدة على المخزون الحالي (مش بيستبدلها). المنتجات غير الموجودة في الملف بتفضل زي ما هي.</p>
        <p className="mt-1 text-sm text-muted">الأعمدة: Barcode، Product Name، Category، Image URL، Cost / Employee Purchase Price، Stock Quantity. الخلايا الفاضية (اسم/سعر/صورة) لا تمسح القيم الحالية.</p>
        <input type="file" accept=".xlsx,.csv" className="mt-4 block" disabled={busy} onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
      </Card>
      {done && <p className="rounded-xl bg-green-50 p-4 font-semibold text-success">{done}</p>}
      {stage && (
        <Card className="grid gap-3">
          <h2 className="text-lg font-bold">معاينة: {fileName}</h2>
          <div className="flex flex-wrap gap-2">
            <Badge tone="neutral">إجمالي الصفوف {stage.total_rows}</Badge><Badge tone="success">جديد {stage.new_count}</Badge>
            <Badge tone="brand">تحديث {stage.update_count}</Badge><Badge tone={stage.invalid_count ? "danger" : "neutral"}>أخطاء {stage.invalid_count}</Badge>
          </div>
          {stage.duplicate_of && (
            <div className="rounded-xl bg-amber-50 p-3 text-warning">
              <p className="font-semibold">تحذير: نفس محتوى الملف ده اتستورد قبل كده ({stage.duplicate_of.file_name} — {cairoDateTime(stage.duplicate_of.confirmed_at)}).</p>
              <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={allowDup} onChange={(e) => setAllowDup(e.target.checked)} /> أنا متأكد، ده توريد جديد بنفس الكميات</label>
            </div>
          )}
          {stage.invalid_count > 0 && <p className="rounded-xl bg-red-50 p-3 text-danger">صحّح الصفوف الحمراء في الملف وارفعه تاني. لا يمكن التأكيد مع وجود أخطاء.</p>}
          <div className="max-h-96 overflow-auto">
            <DataTable head={["صف", "الباركود", "الاسم", "السعر", "الإضافة", "قبل", "بعد", "الإجراء"]}>
              {items.map((i) => (
                <tr key={i.row_no} className={i.action === "invalid" ? "bg-red-50" : ""}>
                  <Td>{i.row_no + 1}</Td><Td dir="ltr">{i.barcode}</Td><Td>{i.name}</Td><Td>{i.price_piastres !== null ? egp(i.price_piastres) : "—"}</Td>
                  <Td>+{i.qty}</Td><Td>{i.old_qty}</Td><Td>{i.new_qty}</Td>
                  <Td>{i.action === "invalid" ? <span className="text-danger">{ERR[i.error ?? ""] ?? i.error}</span> : i.action === "new" ? "جديد" : "تحديث"}</Td>
                </tr>
              ))}
            </DataTable>
          </div>
          <div className="flex gap-2">
            <Button loading={busy} disabled={stage.invalid_count > 0 || (Boolean(stage.duplicate_of) && !allowDup)} onClick={confirm}>تأكيد الاستيراد</Button>
            <Button variant="ghost" onClick={cancel}>إلغاء</Button>
          </div>
        </Card>
      )}
    </div>
  );
}

export default function AdminImport() {
  return <AppShell guard={{ employee: false, perm: "stock.import" }}><PageTitle title="استيراد المخزون (Excel / CSV)" /><Import /></AppShell>;
}
