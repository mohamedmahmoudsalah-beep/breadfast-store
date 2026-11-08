"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useAuth } from "@/lib/auth";
import { useCart } from "@/lib/cart";
import { Logo } from "@/components/brand/logo";
import { Spinner } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { getSupabase } from "@/lib/supabase/client";
import { useLoad, useRealtime } from "@/lib/hooks";
import { egp } from "@/lib/format";

type Guard = { employee?: boolean; role?: string; perm?: string | string[]; anyPerm?: string[]; auth?: boolean };

function useNav() {
  const { access, can, hasRole } = useAuth();
  const links: { href: string; label: string }[] = [];
  if (access?.hrid) links.push({ href: "/", label: "المتجر" }, { href: "/orders/", label: "طلباتي" }, { href: "/wallet/", label: "محفظتي" });
  if (hasRole("picker") || can("picker.work")) links.push({ href: "/picker/", label: "التجهيز" });
  if (hasRole("pickup") || can("pickup.work")) links.push({ href: "/pickup/", label: "الاستلام" });
  if (can("dashboard.view") || can("orders.view")) links.push({ href: "/admin/", label: "الإدارة" });
  return links;
}

export function AppShell({ children, guard = { employee: true } }: { children: React.ReactNode; guard?: Guard }) {
  const { session, access, loading, configured, signOut, can } = useAuth();
  const router = useRouter();
  const path = usePathname();
  const cart = useCart();
  const nav = useNav();
  const badges = useLoad(async () => {
    if (!session || !access?.hrid) return { unread: 0, balance: null as number | null };
    const supabase = getSupabase();
    const [n, w] = await Promise.all([
      supabase.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null),
      supabase.from("wallets").select("balance_piastres").maybeSingle(),
    ]);
    return { unread: n.count ?? 0, balance: w.data ? Number(w.data.balance_piastres) : 0 };
  }, [session?.user.id, access?.hrid]);
  const unread = badges.data?.unread ?? 0;
  const balance = badges.data?.balance ?? null;
  useRealtime("notifications", session ? `user_id=eq.${session.user.id}` : undefined, () => void badges.reload(), 60_000);

  useEffect(() => {
    if (loading || !configured) return;
    if (!session) router.replace("/login/");
    else if (access && guard.employee && !access.hrid) router.replace("/onboarding/");
  }, [loading, configured, session, access, guard.employee, router]);

  if (!configured) return <main className="mx-auto max-w-xl p-8"><p className="rounded-xl bg-amber-50 p-4 text-warning">إعدادات Supabase ناقصة. راجع docs/DEPLOY.md.</p></main>;
  if (loading || !session || !access) return <Spinner />;
  if (!access.is_active) return <main className="p-8 text-center"><p className="text-lg">حسابك موقوف. تواصل مع الإدارة.</p><Button className="mt-4" onClick={signOut}>تسجيل الخروج</Button></main>;
  if (guard.employee && !access.hrid) return <Spinner />;

  const perms = guard.perm ? (Array.isArray(guard.perm) ? guard.perm : [guard.perm]) : [];
  const allowed = (!guard.role || access.roles.includes(guard.role) || access.roles.includes("super_admin"))
    && perms.every((p) => can(p)) && (!guard.anyPerm || guard.anyPerm.some((p) => can(p)));
  const isAdminArea = path.startsWith("/admin");

  return (
    <div className="min-h-screen bg-surface">
      <header className="sticky top-0 z-40 border-b border-line bg-white">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3">
          <Link href="/" className="flex shrink-0 items-center gap-2"><Logo size={36} /><span className="hidden font-bold sm:inline">متجر بريدفاست</span></Link>
          <nav className="flex min-w-0 flex-1 gap-1 overflow-x-auto" aria-label="القائمة الرئيسية">
            {nav.map((l) => {
              const active = l.href === "/" ? path === "/" : path.startsWith(l.href);
              return <Link key={l.href} href={l.href} className={cn("whitespace-nowrap rounded-lg px-3 py-2 text-sm font-semibold", active ? "bg-brand-50 text-brand-700" : "text-muted hover:bg-surface")}>{l.label}</Link>;
            })}
          </nav>
          {access.hrid && <>
            <Link href="/cart/" className="relative rounded-lg px-3 py-2 text-sm font-semibold hover:bg-surface" aria-label="السلة">
              🛒{cart.count > 0 && <span className="absolute -top-0.5 -end-0.5 rounded-full bg-brand-500 px-1.5 text-xs text-white">{cart.count}</span>}
            </Link>
            <Link href="/notifications/" className="relative rounded-lg px-3 py-2 text-sm hover:bg-surface" aria-label="الإشعارات">
              🔔{unread > 0 && <span className="absolute -top-0.5 -end-0.5 rounded-full bg-danger px-1.5 text-xs text-white">{unread}</span>}
            </Link>
            {balance !== null && <Link href="/wallet/" className="hidden rounded-lg bg-brand-50 px-3 py-2 text-sm font-semibold text-brand-700 md:block">{egp(balance)}</Link>}
          </>}
          <Button variant="ghost" size="sm" onClick={signOut}>خروج</Button>
        </div>
        {isAdminArea && <AdminTabs />}
      </header>
      <div className="mx-auto max-w-6xl px-4 py-6">
        {allowed ? children : <div className="rounded-2xl bg-white p-8 text-center"><p className="text-lg font-semibold">ليس لديك صلاحية للوصول لهذه الصفحة.</p><Link className="mt-3 inline-block text-brand-600 underline" href="/">العودة للرئيسية</Link></div>}
      </div>
    </div>
  );
}

function AdminTabs() {
  const path = usePathname();
  const { can } = useAuth();
  const tabs: [string, string, string | null][] = [
    ["/admin/", "لوحة التحكم", "dashboard.view"], ["/admin/orders/", "الطلبات", "orders.view"], ["/admin/products/", "المنتجات", "products.manage"],
    ["/admin/import/", "استيراد المخزون", "stock.import"], ["/admin/stock/", "حركة المخزون", "stock.import"], ["/admin/categories/", "الأقسام والحدود", "categories.manage"],
    ["/admin/schedule/", "المواعيد", "schedule.manage"], ["/admin/users/", "المستخدمون", "users.manage"], ["/admin/finance/", "المدفوعات والاستردادات", "payments.view"],
    ["/admin/reports/", "التقارير", "reports.export"], ["/admin/settings/", "الإعدادات", "settings.manage"], ["/admin/audit/", "سجل المراجعة", "audit.view"],
  ];
  return (
    <div className="border-t border-line bg-white">
      <nav className="mx-auto flex max-w-6xl gap-1 overflow-x-auto px-4 py-2" aria-label="قائمة الإدارة">
        {tabs.filter(([, , p]) => !p || can(p)).map(([href, label]) => (
          <Link key={href} href={href} className={cn("whitespace-nowrap rounded-lg px-3 py-1.5 text-sm", path === href || (href !== "/admin/" && path.startsWith(href)) ? "bg-brand-500 text-white" : "text-muted hover:bg-surface")}>{label}</Link>
        ))}
      </nav>
    </div>
  );
}

export function PageTitle({ title, children }: { title: string; children?: React.ReactNode }) {
  return <div className="mb-5 flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-bold">{title}</h1>{children}</div>;
}
