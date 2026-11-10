"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/utils";

export function ExcelIcon({ size = 44, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden className={className}>
      <rect x="6" y="4" width="30" height="40" rx="4" fill="#fff" stroke="#1d6f42" strokeWidth="2.5" />
      <rect x="2" y="14" width="26" height="20" rx="3" fill="#1d6f42" />
      <path d="M9 19.5l8 9M17 19.5l-8 9" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
      <path d="M31 12h10M31 19h10M31 26h10M31 33h10" stroke="#1d6f42" strokeWidth="2" strokeLinecap="round" opacity=".55" />
    </svg>
  );
}

/** Big, obvious upload area (click or drag & drop) with an Excel icon. */
export function FileDrop({ onFile, disabled, title = "اضغط هنا لاختيار ملف Excel", hint = "أو اسحب الملف وارميه هنا (.xlsx أو .csv)" }:
  { onFile: (f: File) => void; disabled?: boolean; title?: string; hint?: string }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const pick = (f?: File | null) => { if (f && !disabled) onFile(f); if (input.current) input.current.value = ""; };
  return (
    <label
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files?.[0]); }}
      className={cn("flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors focus-within:outline focus-within:outline-2 focus-within:outline-brand-300",
        over ? "border-brand-500 bg-brand-50" : "border-[#1d6f42]/50 bg-[#f3faf6] hover:bg-[#e8f5ee]", disabled && "cursor-not-allowed opacity-60")}>
      <ExcelIcon size={52} />
      <span className="text-lg font-bold text-[#1d6f42]">{title}</span>
      <span className="text-sm text-muted">{hint}</span>
      <input ref={input} type="file" accept=".xlsx,.csv" disabled={disabled} className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
    </label>
  );
}

/** Button that downloads an Excel file (template or export). */
export function ExcelButton({ onClick, children, disabled }: { onClick: () => void | Promise<void>; children: React.ReactNode; disabled?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={() => void onClick()}
      className="inline-flex items-center gap-2 rounded-lg border border-[#1d6f42]/50 bg-white px-4 py-2 text-sm font-semibold text-[#1d6f42] hover:bg-[#f3faf6] disabled:opacity-50">
      <ExcelIcon size={22} />{children}
    </button>
  );
}
