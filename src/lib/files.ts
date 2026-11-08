import Papa from "papaparse";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;

export type SheetRow = Record<string, string>;

const ALIASES: Record<string, string[]> = {
  barcode: ["barcode", "الباركود", "باركود", "bar code", "sku", "code"],
  name: ["product name", "name", "اسم المنتج", "المنتج", "الاسم", "product"],
  category: ["category", "القسم", "الفئة", "internal category name"],
  image_url: ["image url", "image", "image_url", "رابط الصورة", "الصورة"],
  price: ["cost", "price", "employee purchase price", "cost / employee purchase price", "السعر", "سعر الموظف", "التكلفة", "unit price"],
  qty: ["stock quantity", "quantity", "qty", "stock", "الكمية", "كمية المخزون", "المخزون"],
  hrid: ["hrid", "hr id", "employee id", "رقم الموظف"],
  emp_name: ["employee name", "name", "اسم الموظف", "الاسم"],
};

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");

/** Reads the first sheet of an .xlsx or a .csv into a 2D array of strings. Validates type and size. */
export async function readTable(file: File): Promise<string[][]> {
  if (file.size > MAX_FILE_BYTES) throw new Error("الملف أكبر من 5 ميجابايت.");
  const name = file.name.toLowerCase();
  if (name.endsWith(".csv")) {
    const text = await file.text();
    const parsed = Papa.parse<string[]>(text.replace(/^\uFEFF/, ""), { skipEmptyLines: true });
    return parsed.data.map((r) => r.map((c) => String(c ?? "")));
  }
  if (name.endsWith(".xlsx")) {
    const { readSheet } = await import("read-excel-file/browser");
    const rows = await readSheet(file);
    return (rows as unknown[][]).map((r) => r.map((c) => (c instanceof Date ? c.toISOString() : String(c ?? ""))));
  }
  throw new Error("نوع الملف غير مدعوم. استخدم .xlsx أو .csv");
}

/** Maps header names (English/Arabic) to our canonical field names. */
export function mapRows(table: string[][], fields: string[]): { rows: SheetRow[]; missing: string[] } {
  if (table.length < 2) return { rows: [], missing: fields };
  const header = table[0].map(norm);
  const index: Record<string, number> = {};
  for (const f of fields) {
    const i = header.findIndex((h) => ALIASES[f].includes(h));
    if (i >= 0) index[f] = i;
  }
  const missing = fields.filter((f) => !(f in index));
  const rows = table.slice(1).filter((r) => r.some((c) => String(c).trim() !== "")).map((r) => {
    const o: SheetRow = {};
    for (const f of fields) o[f] = f in index ? String(r[index[f]] ?? "").trim() : "";
    return o;
  });
  return { rows, missing };
}
