"use client";

import { useState } from "react";
import { AppShell, PageTitle } from "@/components/layout/shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ExcelButton, FileDrop } from "@/components/ui/file-drop";
import { DataTable, Td, useToast } from "@/components/ui/misc";
import { useAuth } from "@/lib/auth";
import { getSupabase } from "@/lib/supabase/client";
import { rpc } from "@/lib/rpc";
import { mapRows, readTable } from "@/lib/files";
import { downloadTemplate } from "@/lib/export";
import { errorMessage } from "@/lib/errors";
import { cairoDateTime, egp } from "@/lib/format";
import { cn } from "@/lib/utils";

type Mode = "catalog" | "price" | "stock" | "limits";
type Stage = { batch_id: string; mode: string; total_rows: number; new_count: number; update_count: number; invalid_count: number; duplicate_of: { file_name: string; confirmed_at: string } | null };
type Item = { row_no: number; barcode: string | null; name: string | null; category_name: string | null; image_url: string | null; price_piastres: number | null; old_price: number | null; qty: number; action: string; error: string | null; old_qty: number; new_qty: number };

const ERR: Record<string, string> = {
  BARCODE_MISSING: "الباركود فاضي", NAME_REQUIRED_FOR_NEW: "منتج جديد بدون اسم", DUPLICATE_BARCODE_IN_FILE: "باركود مكرر داخل الملف",
  QTY_INVALID: "كمية غير صحيحة", QTY_REQUIRED: "الكمية فاضية", PRICE_REQUIRED: "السعر فاضي", PRODUCT_NOT_FOUND: "المنتج مش موجود: ارفع ملف المنتجات الأول",
  PRICE_NEGATIVE: "سعر سالب", PRICE_MUST_BE_POSITIVE: "السعر لازم يكون أكبر من صفر", NUMBER_INVALID: "رقم غير صحيح", IMAGE_URL_INVALID: "رابط صورة غير صحيح",
};

function Staged({ mode }: { mode: "catalog" | "price" | "stock" }) {
  const toast = useToast();
  const [fileName, setFileName] = useState("");
  const [stage, setStage] = useState<Stage | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [allowDup, setAllowDup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const isCatalog = mode === "catalog";
  const isPrice = mode === "price";

  async function onFile(file: File) {
    setBusy(true); setStage(null); setItems([]); setDone(""); setAllowDup(false); setFileName(file.name);
    try {
      const table = await readTable(file);
      const fields = isCatalog ? ["barcode", "name", "category", "image_url"] : isPrice ? ["barcode", "name", "price"] : ["barcode", "name", "qty"];
      const { rows, missing } = mapRows(table, fields);
      const required = isCatalog ? ["barcode", "name"] : isPrice ? ["barcode", "price"] : ["barcode", "qty"];
      if (required.some((f) => missing.includes(f))) { toast(isCatalog ? "الملف لازم فيه عمودي الباركود واسم المنتج." : isPrice ? "الملف لازم فيه عمودي الباركود والسعر." : "الملف لازم فيه عمودي الباركود والكمية.", "error"); return; }
      const res = await rpc<Stage>("import_stage", { p_file_name: file.name, p_rows: rows, p_mode: mode });
      const { data } = await getSupabase().from("stock_import_items").select("row_no,barcode,name,category_name,image_url,price_piastres,old_price,qty,action,error,old_qty,new_qty").eq("batch_id", res.batch_id).order("row_no").limit(5000);
      setStage(res); setItems((data ?? []) as Item[]);
    } catch (e) { toast(e instanceof Error && /[؀-ۿ]/.test(e.message) ? e.message : errorMessage(e), "error"); } finally { setBusy(false); }
  }
  async function confirm() {
    if (!stage || busy) return; setBusy(true);
    try {
      const r = await rpc<{ new_count: number; update_count: number }>("import_confirm", { p_batch: stage.batch_id, p_allow_duplicate: allowDup });
      setDone(isCatalog ? `تم: ${r.new_count} منتج جديد و ${r.update_count} منتج اتحدّث.` : isPrice ? `تم تحديث أسعار ${r.update_count} منتج. المنتجات اللي كانت من غير سعر بقت ظاهرة في المتجر.` : `تم إضافة المخزون لـ ${r.update_count} منتج.`); setStage(null); setItems([]);
    } catch (e) { toast(errorMessage(e), "error"); } finally { setBusy(false); }
  }
  async function cancel() { if (stage) await rpc("import_cancel", { p_batch: stage.batch_id }).catch(() => {}); setStage(null); setItems([]); }

  return (
    <div className="grid gap-4">
      <Card className="grid gap-3">
        {isCatalog ? (
          <>
            <p className="font-semibold">ملف بيانات المنتجات: الباركود، اسم المنتج، القسم، رابط الصورة.</p>
            <ul className="list-disc ps-5 text-sm text-muted">
              <li>الأقسام الموجودة في الملف بتتعمل تلقائيًا. المنتج من غير قسم بيدخل قسم «null» (حدّه ثابت قطعتين لكل موظف في اليوم).</li>
              <li>الخلايا الفاضية بتسيب القيمة الحالية زي ما هي (مش بتمسحها).</li>
              <li>المنتج الجديد <b>مش بيظهر في المتجر</b> لحد ما تدخل له سعر من تبويب «الأسعار».</li>
              <li>الملف ده <b>مش بيغيّر المخزون ولا الأسعار</b>.</li>
            </ul>
            <div><ExcelButton onClick={() => downloadTemplate("template-products.xlsx", ["Barcode", "Product Name", "Category", "Image URL"], [["6221234567890", "كولا 330 مل", "مشروبات غازية", "https://example.com/cola.jpg"]], ["الأعمدة المطلوبة: Barcode و Product Name. باقي الأعمدة اختيارية.", "امسح صف المثال قبل الرفع."])}>تحميل تمبليت المنتجات</ExcelButton></div>
          </>
        ) : isPrice ? (
          <>
            <p className="font-semibold">ملف الأسعار: الباركود، اسم المنتج، السعر (بالجنيه).</p>
            <ul className="list-disc ps-5 text-sm text-muted">
              <li>السعر بيستبدل السعر الحالي. المنتج لازم يكون موجود (ارفع ملف المنتجات الأول).</li>
              <li>المنتج اللي ملوش سعر <b>مش بيظهر للموظفين</b>. أول ما تدخل له سعر بيظهر تلقائيًا.</li>
              <li>الاسم للمراجعة فقط ولا يغيّر اسم المنتج. الأسعار القديمة بتفضل متسجلة في سجل المراجعة.</li>
            </ul>
            <div><ExcelButton onClick={() => downloadTemplate("template-prices.xlsx", ["Barcode", "Product Name", "Price"], [["6221234567890", "كولا 330 مل", 10.5]], ["الأعمدة المطلوبة: Barcode و Price. السعر بالجنيه وأكبر من صفر.", "امسح صف المثال قبل الرفع."])}>تحميل تمبليت الأسعار</ExcelButton></div>
          </>
        ) : (
          <>
            <p className="font-semibold">ملف المخزون: الباركود، اسم المنتج، كمية المخزون.</p>
            <ul className="list-disc ps-5 text-sm text-muted">
              <li>الكمية بتتضاف على المخزون الحالي (<b>مش بتستبدله</b>). المنتجات اللي مش في الملف بتفضل زي ما هي.</li>
              <li>المنتج لازم يكون موجود قبل كده (ارفع ملف المنتجات الأول).</li>
              <li>لو نفس الملف اتستورد قبل كده بيظهر تحذير ولازم تأكد.</li>
            </ul>
            <div><ExcelButton onClick={() => downloadTemplate("template-stock.xlsx", ["Barcode", "Product Name", "Stock Quantity"], [["6221234567890", "كولا 330 مل", 120]], ["الأعمدة المطلوبة: Barcode و Stock Quantity. الاسم للمراجعة فقط ولا يغيّر اسم المنتج.", "امسح صف المثال قبل الرفع."])}>تحميل تمبليت المخزون</ExcelButton></div>
          </>
        )}
        <FileDrop onFile={onFile} disabled={busy} />
      </Card>
      {done && <p className="rounded-xl bg-green-50 p-4 font-semibold text-success">{done}</p>}
      {stage && (
        <Card className="grid gap-3">
          <h2 className="text-lg">معاينة: {fileName}</h2>
          <div className="flex flex-wrap gap-2">
            <Badge tone="neutral">إجمالي الصفوف {stage.total_rows}</Badge>
            {isCatalog && <Badge tone="success">جديد {stage.new_count}</Badge>}
            <Badge tone="brand">{isCatalog ? "تحديث" : "منتجات"} {stage.update_count}</Badge>
            <Badge tone={stage.invalid_count ? "danger" : "neutral"}>أخطاء {stage.invalid_count}</Badge>
          </div>
          {stage.duplicate_of && (
            <div className="rounded-xl bg-amber-50 p-3 text-warning">
              <p className="font-semibold">تحذير: نفس محتوى الملف ده اتستورد قبل كده ({stage.duplicate_of.file_name} — {cairoDateTime(stage.duplicate_of.confirmed_at)}).</p>
              <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={allowDup} onChange={(e) => setAllowDup(e.target.checked)} /> أنا متأكد، ده توريد جديد</label>
            </div>
          )}
          {stage.invalid_count > 0 && <p className="rounded-xl bg-red-50 p-3 text-danger">صحّح الصفوف الحمراء في الملف وارفعه تاني. لا يمكن التأكيد مع وجود أخطاء.</p>}
          <div className="max-h-96 overflow-auto">
            <DataTable head={isCatalog ? ["صف", "الباركود", "الاسم", "القسم", "الإجراء"] : isPrice ? ["صف", "الباركود", "الاسم", "السعر الحالي", "السعر الجديد", "الإجراء"] : ["صف", "الباركود", "الاسم", "الإضافة", "قبل", "بعد", "الإجراء"]}>
              {items.map((i) => (
                <tr key={i.row_no} className={i.action === "invalid" ? "bg-red-50" : ""}>
                  <Td>{i.row_no + 1}</Td><Td dir="ltr">{i.barcode}</Td><Td>{i.name}</Td>
                  {isCatalog ? <Td>{i.category_name ?? "—"}</Td> : isPrice ? <><Td>{i.old_price ? egp(i.old_price) : "بدون سعر"}</Td><Td className="font-bold">{i.price_piastres !== null ? egp(i.price_piastres) : "—"}</Td></> : <><Td>+{i.qty}</Td><Td>{i.old_qty}</Td><Td>{i.new_qty}</Td></>}
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

function Limits() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ updated: number; removed: number; invalid: number; skipped_system: number; unknown: string[] } | null>(null);

  async function template() {
    const s = getSupabase();
    const [c, l] = await Promise.all([s.from("categories").select("id,name,is_system").order("name"), s.from("category_daily_limits").select("category_id,max_qty_per_employee")]);
    const rows = (c.data ?? []).filter((x) => !x.is_system).map((x) => [x.name, l.data?.find((y) => y.category_id === x.id)?.max_qty_per_employee ?? ""]);
    await downloadTemplate("template-category-limits.xlsx", ["Category", "Daily Limit"], rows.length ? rows : [["مشروبات غازية", 5]],
      ["Daily Limit = أقصى عدد وحدات لكل موظف في اليوم من القسم. اتركه فاضي لإلغاء الحد.", "قسم «null» حدّه ثابت (2) ولا يتغيّر."]);
  }
  async function onFile(file: File) {
    setBusy(true); setResult(null);
    try {
      const { rows, missing } = mapRows(await readTable(file), ["category", "limit"]);
      if (missing.length) { toast("الملف لازم فيه عمودي Category و Daily Limit.", "error"); return; }
      setResult(await rpc("limits_import", { p_rows: rows }));
    } catch (e) { toast(e instanceof Error && /[؀-ۿ]/.test(e.message) ? e.message : errorMessage(e), "error"); } finally { setBusy(false); }
  }
  return (
    <div className="grid gap-4">
      <Card className="grid gap-3">
        <p className="font-semibold">ملف حدود الأقسام: اسم القسم والحد اليومي لكل موظف.</p>
        <ul className="list-disc ps-5 text-sm text-muted">
          <li>الأقسام بتيجي من ملف المنتجات. حمّل التمبليت وهتلاقي كل الأقسام الموجودة فيه جاهزة، وانت تكتب الحد قصاد كل قسم.</li>
          <li>الحد الفاضي = بدون حد. قسم «null» حدّه ثابت قطعتين ولا يتغيّر.</li>
        </ul>
        <div><ExcelButton onClick={template}>تحميل تمبليت الحدود (بالأقسام الحالية)</ExcelButton></div>
        <FileDrop onFile={onFile} disabled={busy} />
      </Card>
      {result && (
        <Card className="grid gap-1">
          <p className="font-bold text-success">تم تطبيق الحدود.</p>
          <p>تحديث: {result.updated} • إلغاء حد: {result.removed} • أخطاء: {result.invalid}{result.skipped_system ? ` • قسم النظام اتخطّى: ${result.skipped_system}` : ""}</p>
          {result.unknown.length > 0 && <p className="text-warning">أقسام غير موجودة (ارفع ملف المنتجات الأول): {result.unknown.join("، ")}</p>}
        </Card>
      )}
    </div>
  );
}

function Tabs() {
  const { can } = useAuth();
  const all: [Mode, string, string][] = [["catalog", "1) بيانات المنتجات", "products.manage"], ["price", "2) الأسعار", "products.manage"], ["stock", "3) المخزون", "stock.import"], ["limits", "4) حدود الأقسام", "limits.manage"]];
  const tabs = all.filter(([, , p]) => can(p));
  const [mode, setMode] = useState<Mode>(tabs[0]?.[0] ?? "catalog");
  return (
    <div className="grid gap-4">
      <div role="tablist" className="flex flex-wrap gap-2">
        {tabs.map(([m, label]) => (
          <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
            className={cn("rounded-lg border px-5 py-3 text-base font-semibold", mode === m ? "border-brand-500 bg-brand-500 text-white" : "border-line bg-white hover:bg-brand-50")}>{label}</button>
        ))}
      </div>
      {mode === "limits" ? <Limits /> : <Staged key={mode} mode={mode} />}
    </div>
  );
}

export default function AdminImport() {
  return <AppShell guard={{ employee: false, anyPerm: ["products.manage", "stock.import", "limits.manage"] }}><PageTitle title="رفع ملفات Excel" /><Tabs /></AppShell>;
}
