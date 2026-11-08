import { cn } from "@/lib/utils";

export function Logo({ size = 56, className }: { size?: number; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src="/logo.png"
      alt="بريدفاست"
      width={size}
      height={size}
      className={cn("rounded-2xl", className)}
    />
  );
}
