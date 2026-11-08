"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/misc";
import { getSupabase } from "@/lib/supabase/client";
import { useAuth } from "@/lib/auth";

export default function LoginPage() {
  const router = useRouter();
  const { session } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  // arriving from the e-mail confirmation link already signs the user in
  useEffect(() => { if (session) router.replace("/"); }, [session, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(""); setInfo("");
    const { error: err } = await getSupabase().auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (err) {
      setError(/confirm/i.test(err.message) ? "لازم تأكد بريدك الإلكتروني الأول (راجع رسالة التفعيل)." : "البريد الإلكتروني أو كلمة المرور غير صحيحة.");
      return;
    }
    router.replace("/");
  }

  async function forgot() {
    if (!email.trim()) { setError("اكتب بريدك الإلكتروني الأول."); return; }
    setError("");
    const { error: err } = await getSupabase().auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/reset-password/` });
    if (err) setError("تعذر إرسال رسالة الاستعادة. حاول لاحقًا."); else setInfo("لو البريد مسجل هيوصلك رابط لاستعادة كلمة المرور.");
  }

  return (
    <AuthCard title="تسجيل الدخول" subtitle="متجر موظفي بريدفاست">
      <form onSubmit={onSubmit} className="grid gap-4">
        <Field label="البريد الإلكتروني"><Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" /></Field>
        <Field label="كلمة المرور"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" /></Field>
        {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-danger">{error}</p>}
        {info && <p className="rounded-xl bg-green-50 p-3 text-success">{info}</p>}
        <Button type="submit" size="lg" loading={busy}>دخول</Button>
        <button type="button" onClick={forgot} className="text-sm text-brand-600 underline">نسيت كلمة المرور؟</button>
        <p className="text-center text-sm text-muted">موظف جديد؟ <Link href="/register/" className="font-semibold text-brand-600 underline">أنشئ حسابك</Link></p>
      </form>
    </AuthCard>
  );
}
