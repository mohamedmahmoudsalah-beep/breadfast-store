"use client";

import { AuthProvider } from "@/lib/auth";
import { CartProvider } from "@/lib/cart";
import { ToastProvider } from "@/components/ui/misc";

export function Providers({ children }: { children: React.ReactNode }) {
  return <ToastProvider><AuthProvider><CartProvider>{children}</CartProvider></AuthProvider></ToastProvider>;
}
