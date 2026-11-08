import type { Metadata, Viewport } from "next";
import "@fontsource/ibm-plex-sans-arabic/400.css";
import "@fontsource/ibm-plex-sans-arabic/500.css";
import "@fontsource/ibm-plex-sans-arabic/600.css";
import "@fontsource/ibm-plex-sans-arabic/700.css";
import "./globals.css";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "متجر موظفي بريدفاست",
  description: "تسوّق، ادفع، واستلم طلبك من المتجر الداخلي لموظفي بريدفاست.",
};

export const viewport: Viewport = {
  themeColor: "#aa0082",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ar" dir="rtl">
      <body className="min-h-screen bg-white text-ink"><Providers>{children}</Providers></body>
    </html>
  );
}
