import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <div className={cn("lux-surface overflow-hidden rounded-2xl border bg-white/82 shadow-[0_18px_44px_rgba(35,77,112,.08)]", className)} {...props} />; }
export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <div className={cn("flex items-center justify-between border-b border-sky-100/80 bg-gradient-to-r from-white/78 via-sky-50/48 to-cyan-50/30 px-4 py-3", className)} {...props} />; }
export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) { return <h2 className={cn("text-[13px] font-semibold text-[#173b57]", className)} {...props} />; }
export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) { return <div className={cn("p-4", className)} {...props} />; }
