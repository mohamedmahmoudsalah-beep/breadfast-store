"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Logo } from "@/components/brand/logo";
import { getSupabaseEnv } from "@/lib/supabase/client";
import { APP_TIMEZONE } from "@/lib/config";

type Check = "checking" | "ok" | "fail" | "missing";

export default function StatusPage() {
  const { url, anonKey } = getSupabaseEnv();
  const envMissing = !url || !anonKey;
  const [supabase, setSupabase] = useState<Check>(envMissing ? "missing" : "checking");
  const [detail, setDetail] = useState("");

  useEffect(() => {
    if (envMissing) return;
    fetch(`${url}/auth/v1/health`, { headers: { apikey: anonKey } })
      .then((res) => {
        setSupabase(res.ok ? "ok" : "fail");
        setDetail(`HTTP ${res.status}`);
      })
      .catch((err: unknown) => {
        setSupabase("fail");
        setDetail(err instanceof Error ? err.message : "network error");
      });
  }, [envMissing, url, anonKey]);

  const tone = supabase === "ok" ? "success" : supabase === "checking" ? "neutral" : "danger";
  const label =
    supabase === "ok"
      ? "متصل"
      : supabase === "checking"
        ? "جاري الفحص..."
        : supabase === "missing"
          ? "المتغيرات ناقصة"
          : "فشل الاتصال";

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <div className="flex items-center gap-4">
        <Logo size={48} />
        <h1 className="text-2xl font-bold">فحص الاتصال</h1>
      </div>
      <div className="mt-8 grid gap-4">
        <Card className="flex items-center justify-between">
          <div>
            <p className="font-semibold">Supabase</p>
            <p className="text-sm text-muted">{detail || "قاعدة البيانات والمصادقة"}</p>
          </div>
          <Badge tone={tone}>{label}</Badge>
        </Card>
        <Card className="flex items-center justify-between">
          <div>
            <p className="font-semibold">المنطقة الزمنية</p>
            <p className="text-sm text-muted">كل الحسابات الزمنية بتتم بتوقيت القاهرة</p>
          </div>
          <Badge tone="brand">{APP_TIMEZONE}</Badge>
        </Card>
      </div>
      {supabase === "missing" && (
        <p className="mt-6 rounded-xl bg-amber-50 p-4 text-warning">
          ضيف NEXT_PUBLIC_SUPABASE_URL و NEXT_PUBLIC_SUPABASE_ANON_KEY (شوف docs/SETUP.md).
        </p>
      )}
    </main>
  );
}
