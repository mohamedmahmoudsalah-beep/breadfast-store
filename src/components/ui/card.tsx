import * as React from "react";
import { cn } from "@/lib/utils";

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-xl border border-line bg-white p-5 shadow-[0_1px_2px_rgba(60,40,20,.06)]", className)} {...props} />;
}
