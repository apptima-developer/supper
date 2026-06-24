import { Headphones, LockKeyhole, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const errorMessage = error === "setup"
    ? "Storage setup is incomplete. Verify Supabase environment variables, app_store SQL permissions, and seed data before signing in."
    : error ? "Invalid username or password." : "";

  return (
    <main className="grid min-h-screen bg-[radial-gradient(circle_at_18%_-8%,rgba(125,211,252,.42),transparent_34%),radial-gradient(circle_at_86%_0%,rgba(196,181,253,.24),transparent_30%),linear-gradient(180deg,#fbfdff,#eef8ff_52%,#f8fbff)] lg:grid-cols-[1.08fr_.92fr]">
      <section className="relative hidden overflow-hidden p-12 text-white lg:flex lg:flex-col">
        <div className="absolute inset-6 rounded-[2rem] bg-gradient-to-br from-[#0b5cad] via-[#0a84ff] to-[#20c9b7] shadow-[0_32px_90px_rgba(10,132,255,.25)]" />
        <div className="absolute right-4 top-6 h-72 w-72 rounded-full bg-white/10 blur-3xl" />
        <div className="absolute bottom-0 left-8 h-80 w-80 rounded-full bg-cyan-200/20 blur-3xl" />

        <div className="relative flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-2xl bg-white/18 ring-1 ring-white/25">
            <Headphones size={20} />
          </div>
          <div>
            <p className="text-[14px] font-semibold">SupportDesk</p>
            <p className="text-[10px] uppercase tracking-[.18em] text-white/65">MD Control</p>
          </div>
        </div>

        <div className="relative my-auto max-w-lg">
          <div className="mb-6 h-1 w-12 rounded-full bg-white/75" />
          <h1 className="text-[38px] font-semibold leading-[1.18] tracking-tight">Support operations, contracts, and service health in one refined workspace.</h1>
          <p className="mt-5 max-w-md text-[13px] leading-6 text-white/78">Track every maintenance day, customer commitment, ticket, SLA, and monthly report from a calm internal control center.</p>
          <div className="mt-10 grid grid-cols-3 gap-4 border-t border-white/18 pt-6">
            {[
              ["One source", "Contracts & tickets"],
              ["Full trail", "Every data change"],
              ["Role ready", "Controlled access"],
            ].map(([title, caption]) => (
              <div key={title} className="rounded-2xl bg-white/12 p-4 ring-1 ring-white/14">
                <p className="text-[17px] font-semibold">{title}</p>
                <p className="mt-1 text-[11px] text-white/65">{caption}</p>
              </div>
            ))}
          </div>
        </div>
        <p className="relative text-[10px] text-white/55">Internal use only • SupportDesk Control</p>
      </section>

      <section className="flex items-center justify-center p-6">
        <div className="lux-surface w-full max-w-[400px] rounded-3xl border bg-white/80 p-8 shadow-[0_28px_70px_rgba(35,77,112,.12)]">
          <div className="mb-8 lg:hidden">
            <div className="flex items-center gap-2 text-[#0a84ff]">
              <Headphones size={21} />
              <span className="text-[15px] font-semibold">SupportDesk</span>
            </div>
          </div>
          <p className="text-[11px] font-semibold uppercase tracking-[.15em] text-sky-600">Welcome back</p>
          <h2 className="mt-2 text-[26px] font-semibold tracking-tight text-[#132f46]">Sign in to your workspace</h2>
          <p className="mt-2 text-[12px] text-slate-500">Use your internal SupportDesk credentials.</p>

          <form action="/api/auth/login" method="post" className="mt-8 space-y-5">
            <div>
              <label className="mb-2 block text-[12px] font-medium text-slate-700">Username</label>
              <div className="relative">
                <UserRound className="absolute left-3 top-3 text-sky-500/70" size={16} />
                <input required autoFocus name="username" autoComplete="username" className="h-10 w-full rounded-xl border border-sky-100/90 bg-white/80 pl-10 pr-3 text-[13px] outline-none transition-all placeholder:text-slate-400 focus:border-sky-300 focus:bg-white focus:ring-4 focus:ring-sky-200/35" placeholder="Enter username" />
              </div>
            </div>
            <div>
              <label className="mb-2 block text-[12px] font-medium text-slate-700">Password</label>
              <div className="relative">
                <LockKeyhole className="absolute left-3 top-3 text-sky-500/70" size={16} />
                <input required name="password" type="password" autoComplete="current-password" className="h-10 w-full rounded-xl border border-sky-100/90 bg-white/80 pl-10 pr-3 text-[13px] outline-none transition-all placeholder:text-slate-400 focus:border-sky-300 focus:bg-white focus:ring-4 focus:ring-sky-200/35" placeholder="Enter password" />
              </div>
            </div>
            {errorMessage && <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-[12px] text-rose-700">{errorMessage}</div>}
            <Button className="h-10 w-full">Sign in</Button>
          </form>

        </div>
      </section>
    </main>
  );
}
