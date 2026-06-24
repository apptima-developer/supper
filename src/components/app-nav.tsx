"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Building2, ClipboardList, Columns3, FileUp, FileText, SlidersHorizontal, Settings, ShieldCheck, Table2, UserPlus } from "lucide-react";
import type { Role } from "@/lib/types";
import { can } from "@/lib/rbac";
import { cn } from "@/lib/utils";

const items = [
  { href: "/dashboard", label: "Overview", icon: BarChart3 },
  { href: "/customers", label: "Customers", icon: Building2 },
  { href: "/tickets", label: "Tickets", icon: ClipboardList },
  { href: "/kanban", label: "Kanban board", icon: Columns3 },
  { href: "/imports", label: "Import center", icon: FileUp, permission: "imports:manage" as const },
  { href: "/effort-matrix", label: "Effort matrix", icon: Table2, permission: "reports:view" as const },
  { href: "/reports", label: "Monthly reports", icon: FileText },
  { href: "/master", label: "Master data", icon: SlidersHorizontal, permission: "master:manage" as const },
  { href: "/accounts", label: "Accounts", icon: UserPlus, permission: "accounts:manage" as const },
  { href: "/audit", label: "Audit log", icon: ShieldCheck, permission: "audit:view" as const },
  { href: "/settings", label: "Settings", icon: Settings, permission: "settings:manage" as const },
];
export function AppNav({ role, collapsed = false }: { role: Role; collapsed?: boolean }) {
  const pathname = usePathname();
  return (
    <nav className={cn("space-y-1", collapsed ? "px-2" : "px-3")}>
      {items.filter((item) => !item.permission || can(role, item.permission)).map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            title={collapsed ? item.label : undefined}
            aria-label={item.label}
            className={cn(
              "flex h-9 items-center rounded-xl text-[12px] font-semibold transition-all",
              collapsed ? "justify-center px-0" : "gap-3 px-3",
              active ? "bg-white/85 text-[#173b57] shadow-sm ring-1 ring-sky-100" : "text-slate-500 hover:bg-white/65 hover:text-[#173b57]",
            )}
          >
            <Icon size={16} strokeWidth={1.8} className={active ? "text-[#0a84ff]" : "text-slate-400"} />
            {!collapsed && item.label}
          </Link>
        );
      })}
    </nav>
  );
}
