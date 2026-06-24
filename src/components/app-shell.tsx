"use client";
import { useState } from "react";
import { Bell, CircleHelp, Headphones, LogOut, PanelLeftClose, PanelLeftOpen, Search } from "lucide-react";
import { AppNav } from "./app-nav";
import type { Session } from "@/lib/auth";
import { cn } from "@/lib/utils";

export function AppShell({ session, children }: { session: Session; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const initials = session.name.split(" ").map((part) => part[0]).join("").slice(0, 2);
  const CollapseIcon = collapsed ? PanelLeftOpen : PanelLeftClose;

  return (
    <div className="app-shell min-h-screen">
      <aside className={cn(
        "fixed inset-y-0 left-0 z-30 hidden flex-col border-r border-white/70 bg-white/70 shadow-[18px_0_45px_rgba(35,77,112,.08)] backdrop-blur-2xl transition-[width] duration-200 lg:flex",
        collapsed ? "w-[76px]" : "w-[228px]",
      )}>
        <div className={cn("relative flex h-16 items-center border-b border-sky-100/80", collapsed ? "justify-center px-2" : "gap-3 px-5")}>
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-gradient-to-br from-[#0a84ff] to-[#20c9b7] text-white shadow-lg shadow-sky-500/20">
            <Headphones size={18} />
          </div>
          {!collapsed && <div>
            <p className="text-[13px] font-semibold text-[#173b57]">SupportDesk</p>
            <p className="text-[10px] uppercase tracking-[.16em] text-sky-600/70">MD Control</p>
          </div>}
          <button
            type="button"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setCollapsed((current) => !current)}
            className={cn(
              "grid h-8 w-8 place-items-center rounded-xl text-slate-500 transition-colors hover:bg-sky-50 hover:text-slate-800",
              collapsed ? "absolute -right-4 top-4 bg-white shadow-sm ring-1 ring-sky-100" : "ml-auto",
            )}
          >
            <CollapseIcon size={16} />
          </button>
        </div>

        {!collapsed && <div className="px-5 pb-2 pt-5 text-[10px] font-semibold uppercase tracking-[.14em] text-sky-700/55">Workspace</div>}
        {collapsed && <div className="h-5" />}
        <AppNav role={session.role} collapsed={collapsed} />

        <div className={cn("mt-auto border-t border-sky-100/80", collapsed ? "p-2" : "p-4")}>
          <div className={cn(
            "flex items-center rounded-2xl bg-gradient-to-br from-white/85 to-sky-50/70 ring-1 ring-white/80",
            collapsed ? "flex-col gap-2 p-2" : "gap-3 p-3",
          )}>
            <div className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-sky-100 to-cyan-100 text-[11px] font-semibold text-sky-700">
              {initials}
            </div>
            {!collapsed && <div className="min-w-0 flex-1">
              <p className="truncate text-[12px] font-semibold text-[#173b57]">{session.name}</p>
              <p className="capitalize text-[10px] text-slate-500">{session.role}</p>
            </div>}
            <form action="/api/auth/logout" method="post">
              <button title="Sign out" className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-sky-50 hover:text-slate-700">
                <LogOut size={15} />
              </button>
            </form>
          </div>
        </div>
      </aside>

      <div className={cn("transition-[padding] duration-200", collapsed ? "lg:pl-[76px]" : "lg:pl-[228px]")}>
        <header className="sticky top-0 z-20 flex h-16 items-center border-b border-white/70 bg-white/70 px-5 shadow-[0_10px_30px_rgba(35,77,112,.05)] backdrop-blur-2xl md:px-7">
          <div className="relative hidden w-full max-w-md md:block">
            <Search className="absolute left-3 top-2.5 text-sky-500/70" size={15} />
            <input className="h-9 w-full rounded-xl bg-white/80 pl-9 pr-3 text-[12px] text-slate-700 outline-none ring-1 ring-sky-100 transition-all placeholder:text-slate-400 focus:bg-white focus:ring-4 focus:ring-sky-200/35" placeholder="Search tickets, customers, issue IDs..." />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <button className="rounded-xl p-2 text-slate-500 transition-colors hover:bg-sky-50 hover:text-slate-800">
              <CircleHelp size={17} />
            </button>
            <button className="relative rounded-xl p-2 text-slate-500 transition-colors hover:bg-sky-50 hover:text-slate-800">
              <Bell size={17} />
              <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-gradient-to-r from-rose-500 to-pink-500 shadow-sm" />
            </button>
          </div>
        </header>
        <main className="page-enter p-5 md:p-7">{children}</main>
      </div>
    </div>
  );
}
