"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Spinner } from "@/components/ui/misc";
import { useAuth } from "@/lib/auth";
import { rpc } from "@/lib/rpc";
import { errorMessage } from "@/lib/errors";

export default function OnboardingPage() {
  const { session, access, loading, refresh, signOut } = useAuth();
  const router = useRouter();
  const [hrid, setHrid] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (loading) return;
    if (!session) router.replace("/login/");
    else if (access?.hrid) router.replace("/");
  }, [loading, session, access, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError("");
    try {
      const res = await rpc<{ ok: boolean; error?: string }>("link_hrid", { p_hrid: hrid });
      if (!res.ok) { setError(res.error === "HRID_TAKEN" ? "الـ HRID ده مرتبط بحساب تاني." : "الـ HRID غير صحيح أو غير موجود في سجل الموظفين."); return; }
      await refresh(); router.replace("/");
    } catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }

  if (loading || !session) return <Spinner />;
  return (
    <AuthCard title="اربط حسابك بالـ HRID" subtitle="الربط بيتم مرة واحدة ولا يمكن تغييره">
      <form onSubmit={onSubmit} className="grid gap-4">
        <Field label="رقم الـ HRID"><Input required value={hrid} onChange={(e) => setHrid(e.target.value)} dir="ltr" autoComplete="off" /></Field>
        {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-danger">{error}</p>}
        <Button type="submit" size="lg" loading={busy}>ربط الحساب</Button>
        <button type="button" onClick={signOut} className="text-sm text-muted underline">تسجيل الخروج</button>
      </form>
    </AuthCard>
  );
}
