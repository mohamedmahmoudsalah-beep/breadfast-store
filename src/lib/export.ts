import Papa from "papaparse";

type Row = Record<string, string | number | null>;
export type Sheet = { name: string; rows: Row[]; money?: string[] };

const LABELS: Record<string, string> = {
  order_id: "Order ID", employee_name: "Employee Name", hrid: "HRID", employee_email: "Employee Email", order_date: "Order Date",
  order_time: "Exact Order Time", time_slot: "Selected Time Slot", order_status: "Order Status", payment_status: "Payment Status",
  products_subtotal: "Products Subtotal", bag_charge: "Bag Charge", payment_processing_fee: "Payment Processing Fee", final_total: "Final Total",
  refunded_amount: "Refunded Amount", picker_name: "Picker Name", pickup_employee_name: "Pickup Employee Name", completion_timestamp: "Completion Timestamp",
  barcode: "Barcode", product_name: "Product Name", category: "Category", ordered_quantity: "Ordered Quantity", prepared_quantity: "Prepared Quantity",
  unavailable_quantity: "Unavailable Quantity", unit_price: "Unit Price", item_total: "Item Total", item_status: "Item Status",
  total_quantity_sold: "Total Quantity Sold", total_revenue: "Total Revenue", number_of_orders: "Number of Orders",
};
const label = (k: string) => LABELS[k] ?? k;

export type ReportData = {
  orders_summary: Row[]; order_items: Row[]; product_performance: Row[];
  sales_summary: Record<string, number | string>;
};

const SUMMARY_LABELS: [string, string, boolean][] = [
  ["total_orders", "Total Orders", false], ["paid_orders", "Paid Orders", false], ["completed_orders", "Completed Orders", false],
  ["canceled_orders", "Canceled Orders", false], ["partial_orders", "Partial Orders", false], ["gross_product_sales", "Gross Product Sales", true],
  ["bag_charges", "Bag Charges", true], ["payment_fees", "Payment Fees", true], ["refunds", "Refunds", true], ["net_sales", "Net Sales", true],
  ["cancellation_refunds", "Refunds on Canceled Orders (not part of sales)", true],
];

export function buildSheets(d: ReportData): Sheet[] {
  const summary: Row[] = SUMMARY_LABELS.map(([k, l]) => ({ Metric: l, Value: Number(d.sales_summary[k] ?? 0) }));
  summary.push({ Metric: "Note", Value: String(d.sales_summary.note ?? "") });
  return [
    { name: "Orders Summary", rows: d.orders_summary, money: ["products_subtotal", "bag_charge", "payment_processing_fee", "final_total", "refunded_amount"] },
    { name: "Order Items", rows: d.order_items, money: ["unit_price", "item_total"] },
    { name: "Sales Summary", rows: summary },
    { name: "Product Performance", rows: d.product_performance, money: ["total_revenue"] },
  ];
}

export async function downloadXlsx(sheets: Sheet[], fileName: string) {
  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  const data = sheets.map((s) => {
    const keys = s.rows.length ? Object.keys(s.rows[0]) : [];
    const header = keys.map((k) => ({ value: label(k), fontWeight: "bold" as const, backgroundColor: "#F9DFF3" }));
    const body = s.rows.map((r) => keys.map((k) => {
      const v = r[k];
      if (typeof v === "number") return { value: v, type: Number, format: s.money?.includes(k) || (s.name === "Sales Summary" && k === "Value") ? "#,##0.00" : "0" };
      return { value: v === null || v === undefined ? "" : String(v), type: String };
    }));
    return { sheet: s.name, data: [header, ...body], columns: keys.map(() => ({ width: 22 })) };
  });
  await writeXlsxFile(data).toFile(fileName);
}

export function downloadCsv(sheet: Sheet, fileName: string) {
  const keys = sheet.rows.length ? Object.keys(sheet.rows[0]) : [];
  const csv = Papa.unparse({ fields: keys.map(label), data: sheet.rows.map((r) => keys.map((k) => r[k] ?? "")) });
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });           // BOM => Excel shows Arabic correctly
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = fileName; a.click(); URL.revokeObjectURL(a.href);
}

type Cell = string | number | null | undefined;

async function writeSheets(fileName: string, sheets: { name: string; header: string[]; rows: Cell[][]; widths?: number[]; notes?: string[] }[]) {
  const { default: writeXlsxFile } = await import("write-excel-file/browser");
  const data = sheets.map((sh) => {
    const header = sh.header.map((h) => ({ value: h, fontWeight: "bold" as const, backgroundColor: "#F9DFF3", textColor: "#570041" }));
    const body = sh.rows.map((r) => r.map((v) => (typeof v === "number" ? { value: v, type: Number } : { value: v === null || v === undefined ? "" : String(v), type: String })));
    const notes = (sh.notes ?? []).map((n) => [{ value: n, type: String, textColor: "#6F655F" }]);
    return { sheet: sh.name, data: [header, ...body, ...(notes.length ? [[], ...notes] : [])], columns: sh.header.map((_, i) => ({ width: sh.widths?.[i] ?? 24 })) };
  });
  await writeXlsxFile(data).toFile(fileName);
}

/** A ready-to-fill import template (headers + example rows + short instructions). */
export function downloadTemplate(fileName: string, header: string[], examples: Cell[][], notes: string[] = []) {
  return writeSheets(fileName, [{ name: "Template", header, rows: examples, notes }]);
}

/** Excel export of any on-screen table. */
export function downloadTable(fileName: string, sheetName: string, columns: { header: string; value: (row: never) => Cell }[], rows: unknown[]) {
  return writeSheets(fileName, [{
    name: sheetName.slice(0, 30), header: columns.map((c) => c.header),
    rows: rows.map((r) => columns.map((c) => (c.value as (row: unknown) => Cell)(r))),
  }]);
}
