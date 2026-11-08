import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-11 w-full rounded-xl border border-line bg-white px-4 text-base placeholder:text-muted focus:border-brand-500",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";
