"use client";

import Link from "next/link";
import { useState } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/misc";
import { getSupabase } from "@/lib/supabase/client";

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (password.length < 8) { setError("كلمة المرور لازم تكون 8 حروف على الأقل."); return; }
    if (password !== confirm) { setError("كلمتا المرور غير متطابقتين."); return; }
    setBusy(true); setError("");
    const { error: err } = await getSupabase().auth.signUp({
      email: email.trim(), password, options: { emailRedirectTo: `${window.location.origin}/login/` },
    });
    setBusy(false);
    if (err) { setError(/registered|exists/i.test(err.message) ? "البريد ده مسجل قبل كده. جرب تسجيل الدخول." : "تعذر إنشاء الحساب. تأكد من البيانات وحاول تاني."); return; }
    setDone(true);
  }

  if (done) {
    return (
      <AuthCard title="تحقق من بريدك" subtitle="بعتنالك رابط تفعيل">
        <p className="text-center text-muted">افتح الرسالة على <b dir="ltr">{email}</b> واضغط على رابط التفعيل، وبعدها سجّل الدخول واربط رقم الـ HRID بتاعك.</p>
        <Link href="/login/" className="mt-6 block text-center font-semibold text-brand-600 underline">الذهاب لتسجيل الدخول</Link>
      </AuthCard>
    );
  }
  return (
    <AuthCard title="إنشاء حساب" subtitle="استخدم بريدك الإلكتروني، وبعدها هتربط الـ HRID">
      <form onSubmit={onSubmit} className="grid gap-4">
        <Field label="البريد الإلكتروني"><Input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" /></Field>
        <Field label="كلمة المرور" hint="8 حروف على الأقل"><Input type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" /></Field>
        <Field label="تأكيد كلمة المرور"><Input type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} dir="ltr" /></Field>
        {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-danger">{error}</p>}
        <Button type="submit" size="lg" loading={busy}>إنشاء الحساب</Button>
        <p className="text-center text-sm text-muted">عندك حساب؟ <Link href="/login/" className="font-semibold text-brand-600 underline">سجّل الدخول</Link></p>
      </form>
    </AuthCard>
  );
}
