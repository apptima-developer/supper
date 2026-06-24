"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Bell, Headphones, LogOut, Monitor, Moon, PanelLeftClose, PanelLeftOpen, Search, Sun } from "lucide-react";
import { AppNav } from "./app-nav";
import type { Session } from "@/lib/auth";
import { cn } from "@/lib/utils";

type ThemeMode = "system" | "light" | "dark";
type NotificationItem = {
  id: string;
  title: string;
  message: string;
  href: string;
  tone: "slate" | "blue" | "amber" | "emerald" | "rose";
  kind: "assigned" | "sla";
};
type NotificationResponse = {
  count: number;
  assigned: number;
  slaAlerts: number;
  items: NotificationItem[];
};

const themeOrder: ThemeMode[] = ["system", "light", "dark"];

function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = mode === "dark" || (mode === "system" && systemDark);
  root.classList.toggle("theme-dark", dark);
  root.classList.toggle("theme-light", !dark);
  root.dataset.theme = mode;
}

function notificationTone(tone: NotificationItem["tone"]) {
  if (tone === "rose") return "bg-rose-50 text-rose-700 ring-rose-200";
  if (tone === "amber") return "bg-amber-50 text-amber-700 ring-amber-200";
  if (tone === "emerald") return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  if (tone === "blue") return "bg-sky-50 text-sky-700 ring-sky-200";
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

export function AppShell({ session, children }: { session: Session; children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (typeof window === "undefined") return "system";
    const stored = window.localStorage.getItem("supportdesk-theme") as ThemeMode | null;
    return stored && themeOrder.includes(stored) ? stored : "system";
  });
  const [notifications, setNotifications] = useState<NotificationResponse>({ count: 0, assigned: 0, slaAlerts: 0, items: [] });
  const [notificationOpen, setNotificationOpen] = useState(false);
  const initials = session.name.split(" ").map((part) => part[0]).join("").slice(0, 2);
  const CollapseIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const ThemeIcon = themeMode === "dark" ? Moon : themeMode === "light" ? Sun : Monitor;

  useEffect(() => {
    applyTheme(themeMode);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handleSystemChange = () => {
      if (themeMode === "system") applyTheme("system");
    };
    media.addEventListener("change", handleSystemChange);
    return () => media.removeEventListener("change", handleSystemChange);
  }, [themeMode]);

  useEffect(() => {
    let active = true;
    async function loadNotifications() {
      try {
        const response = await fetch("/api/notifications", { cache: "no-store" });
        if (!response.ok) return;
        const data = await response.json() as NotificationResponse;
        if (active) setNotifications(data);
      } catch {
        // Notification fetch is non-blocking UI chrome.
      }
    }
    loadNotifications();
    const timer = window.setInterval(loadNotifications, 60_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  function cycleTheme() {
    const next = themeOrder[(themeOrder.indexOf(themeMode) + 1) % themeOrder.length];
    window.localStorage.setItem("supportdesk-theme", next);
    setThemeMode(next);
  }

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
          <div className="relative ml-auto flex items-center gap-1">
            <button
              type="button"
              title={`Theme: ${themeMode}`}
              onClick={cycleTheme}
              className="rounded-xl p-2 text-slate-500 transition-colors hover:bg-sky-50 hover:text-slate-800"
            >
              <ThemeIcon size={17} />
            </button>
            <button
              type="button"
              onClick={() => setNotificationOpen((current) => !current)}
              className="relative rounded-xl p-2 text-slate-500 transition-colors hover:bg-sky-50 hover:text-slate-800"
              title="Notifications"
            >
              <Bell size={17} />
              {notifications.count > 0 && (
                <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-gradient-to-r from-rose-500 to-pink-500 px-1.5 text-center text-[10px] font-semibold leading-5 text-white shadow-sm">
                  {notifications.count > 99 ? "99+" : notifications.count}
                </span>
              )}
            </button>
            {notificationOpen && (
              <div className="absolute right-0 top-11 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-2xl border border-sky-100 bg-white/95 shadow-[0_22px_70px_rgba(35,77,112,.18)] backdrop-blur-xl">
                <div className="border-b border-sky-100/80 bg-gradient-to-r from-white via-sky-50/70 to-cyan-50/50 px-4 py-3">
                  <p className="text-[13px] font-semibold text-[#173b57]">Notifications</p>
                  <p className="mt-0.5 text-[10px] text-slate-400">{notifications.assigned} assigned · {notifications.slaAlerts} SLA alerts</p>
                </div>
                {notifications.items.length ? (
                  <div className="max-h-[420px] divide-y divide-sky-100/70 overflow-y-auto">
                    {notifications.items.map((item) => (
                      <Link
                        key={item.id}
                        href={item.href}
                        onClick={() => setNotificationOpen(false)}
                        className="block px-4 py-3 transition-colors hover:bg-sky-50/70"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-[12px] font-semibold text-slate-800">{item.title}</p>
                            <p className="mt-1 line-clamp-2 text-[11px] leading-5 text-slate-500">{item.message}</p>
                          </div>
                          <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ring-1", notificationTone(item.tone))}>
                            {item.kind === "sla" ? "SLA" : "Assign"}
                          </span>
                        </div>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <div className="px-4 py-8 text-center text-[12px] text-slate-400">No assigned work or SLA alerts right now.</div>
                )}
              </div>
            )}
          </div>
        </header>
        <main className="page-enter p-5 md:p-7">{children}</main>
      </div>
    </div>
  );
}
