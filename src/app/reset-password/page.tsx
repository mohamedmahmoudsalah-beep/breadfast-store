"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/misc";
import { getSupabase } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) { setError("كلمة المرور لازم تكون 8 حروف على الأقل."); return; }
    setBusy(true); setError("");
    const { error: err } = await getSupabase().auth.updateUser({ password });
    setBusy(false);
    if (err) setError("تعذر تغيير كلمة المرور. افتح رابط الاستعادة من الرسالة تاني."); else router.replace("/");
  }
  return (
    <AuthCard title="كلمة مرور جديدة">
      <form onSubmit={onSubmit} className="grid gap-4">
        <Field label="كلمة المرور الجديدة"><Input type="password" required autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" /></Field>
        {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-danger">{error}</p>}
        <Button type="submit" size="lg" loading={busy}>حفظ</Button>
      </form>
    </AuthCard>
  );
}
