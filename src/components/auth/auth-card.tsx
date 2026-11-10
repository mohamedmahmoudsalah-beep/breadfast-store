import { Logo } from "@/components/brand/logo";

const WORDS = ["متجر", "موظفي", "بريدفاست"];

/**
 * Animated sign-in shell: the company building (public/login-bg.jpg) slowly zooms and pans,
 * a soft light passes over it, the logo springs in, floats and shines, the title appears word by word.
 * (All motion is CSS-only and is disabled automatically for people who prefer reduced motion.)
 */
export function AuthCard({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-brand-900 px-4 py-10">
      <div aria-hidden className="absolute inset-0 overflow-hidden">
        <div className="bf-bg absolute inset-0"
          style={{ backgroundImage: "url(/login-bg.jpg), radial-gradient(circle at 20% 20%, #8e006b 0%, #570041 45%, #2a0020 100%)" }} />
      </div>
      <div aria-hidden className="absolute inset-0 bg-gradient-to-b from-brand-900/55 via-brand-900/40 to-brand-900/90" />
      <div aria-hidden className="bf-sweep-bg" />
      <div aria-hidden className="bf-glow" />
      <div aria-hidden className="bf-fade-in absolute inset-x-0 top-0 h-1 bg-gold" />

      <div className="relative z-10 w-full max-w-md">
        <div className="mb-6 flex flex-col items-center text-center text-white">
          <div className="bf-logo-in"><div className="bf-logo-float"><div className="bf-logo-wrap ring-4 ring-white/50 shadow-2xl"><Logo size={96} className="block rounded-none" /></div></div></div>
          <p className="mt-5 flex flex-wrap justify-center gap-x-3 font-[family-name:var(--font-display)] text-4xl font-bold drop-shadow-lg">
            {WORDS.map((w, i) => <span key={w} className="bf-word" style={{ animationDelay: `${0.5 + i * 0.22}s` }}>{w}</span>)}
          </p>
          <span aria-hidden className="bf-rule mt-3 block h-[3px] w-28 rounded-full bg-gold" />
          <p className="bf-fade-in mt-2 text-sm tracking-[0.25em] text-brand-100">BREADFAST EMPLOYEE STORE</p>
        </div>
        <div className="bf-card-in rounded-2xl border border-white/25 bg-white/92 p-8 shadow-2xl backdrop-blur-md">
          <h1 className="text-center text-2xl">{title}</h1>
          {subtitle && <p className="mt-1 text-center text-muted">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </main>
  );
}
