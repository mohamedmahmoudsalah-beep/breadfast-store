"use client";

import Link from "next/link";
import { useState } from "react";
import { AuthCard } from "@/components/auth/auth-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/misc";
import { getSupabase } from "@/lib/supabase/client";

/** Turns the real Supabase error into a clear Arabic explanation (so setup problems are visible, not hidden). */
function explainSignupError(err: { message: string; code?: string; status?: number }): string {
  const code = err.code ?? "";
  const msg = err.message ?? "";
  if (code === "user_already_exists" || /already registered|already exists/i.test(msg)) return "البريد ده مسجل قبل كده. جرب تسجيل الدخول.";
  if (code === "over_email_send_rate_limit" || /rate limit/i.test(msg)) return "تخطيت الحد المسموح لإرسال الإيميلات. استنى ساعة وجرب تاني، أو فعّل SMTP مخصص في Supabase (الجزء 4-ج).";
  if (code === "email_address_not_authorized" || /not authorized/i.test(msg)) return "خدمة الإيميل الافتراضية في Supabase بتبعت لأعضاء المشروع بس. فعّل SMTP مخصص (Authentication > Emails > SMTP Settings).";
  if (/sending (confirmation|email)|error sending/i.test(msg)) return "فشل إرسال رسالة التأكيد. راجع إعدادات الإيميل (SMTP) في Supabase.";
  if (/database error/i.test(msg)) return "خطأ في قاعدة البيانات أثناء إنشاء الحساب. تأكد إنك شغلت ملفات supabase/migrations كلها بالترتيب (من 0001 لـ 0008).";
  if (code === "signup_disabled" || /signups? not allowed|disabled/i.test(msg)) return "التسجيل مقفول في Supabase. فعّله من Authentication > Sign In / Providers.";
  if (code === "email_address_invalid" || /invalid.*email|email.*invalid/i.test(msg)) return "البريد الإلكتروني غير مقبول. جرب بريد تاني.";
  if (code === "weak_password" || /password/i.test(msg)) return `كلمة المرور غير مقبولة: ${msg}`;
  return `تعذر إنشاء الحساب: ${msg}${code ? ` (${code})` : ""}`;
}

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
    if (err) { setError(explainSignupError(err)); return; }
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
