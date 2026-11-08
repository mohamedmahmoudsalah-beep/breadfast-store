"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export function Spinner({ label = "جاري التحميل..." }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-3 py-12 text-muted">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand-200 border-t-brand-500" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line px-6 py-12 text-center">
      <p className="text-lg font-semibold">{title}</p>
      {hint && <p className="mt-1 text-muted">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-xl bg-red-50 p-4 text-danger">
      <p>{message}</p>
      {onRetry && <button onClick={onRetry} className="mt-2 font-semibold underline">إعادة المحاولة</button>}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-semibold">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-sm text-muted">{hint}</span>}
    </label>
  );
}

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, ...props }, ref) => (
    <select ref={ref} className={cn("h-11 w-full rounded-xl border border-line bg-white px-3 text-base", className)} {...props} />
  ),
);
Select.displayName = "Select";

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn("min-h-24 w-full rounded-xl border border-line bg-white px-4 py-2 text-base", className)} {...props} />
  ),
);
Textarea.displayName = "Textarea";

export function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: React.ReactNode }) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}
        className="max-h-[90vh] w-full overflow-y-auto rounded-t-3xl bg-white p-6 sm:max-w-lg sm:rounded-3xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold">{title}</h2>
          <button onClick={onClose} aria-label="إغلاق" className="rounded-full px-3 py-1 text-xl text-muted hover:bg-surface">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function DataTable({ head, children }: { head: string[]; children: React.ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-line">
      <table className="w-full min-w-max text-start text-sm">
        <thead className="bg-surface text-muted">
          <tr>{head.map((h) => <th key={h} className="whitespace-nowrap px-4 py-3 text-start font-semibold">{h}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-line">{children}</tbody>
      </table>
    </div>
  );
}
export const Td = ({ className, ...p }: React.TdHTMLAttributes<HTMLTableCellElement>) => <td className={cn("whitespace-nowrap px-4 py-3", className)} {...p} />;

type ToastItem = { id: number; text: string; tone: "success" | "error" };
const ToastContext = React.createContext<(text: string, tone?: "success" | "error") => void>(() => {});
export const useToast = () => React.useContext(ToastContext);

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([]);
  const push = React.useCallback((text: string, tone: "success" | "error" = "success") => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, text, tone }]);
    setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" className="fixed inset-x-0 bottom-4 z-[60] mx-auto flex max-w-md flex-col gap-2 px-4">
        {items.map((t) => (
          <div key={t.id} className={cn("rounded-xl px-4 py-3 font-medium text-white shadow-lg", t.tone === "success" ? "bg-success" : "bg-danger")}>{t.text}</div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
