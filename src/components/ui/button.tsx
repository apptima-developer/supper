import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const variants = cva("inline-flex h-9 items-center justify-center gap-2 rounded-lg px-3 text-[13px] font-medium shadow-sm transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300/70 active:scale-[.99]", { variants: { variant: { default: "bg-gradient-to-r from-[#0a84ff] to-[#20c9b7] text-white shadow-sky-500/20 hover:brightness-[1.04]", outline: "border border-sky-100/80 bg-white/75 text-slate-700 shadow-[0_1px_0_rgba(255,255,255,.8)_inset] hover:border-sky-200 hover:bg-sky-50/80", ghost: "text-slate-600 shadow-none hover:bg-sky-50/80 hover:text-slate-900", danger: "bg-gradient-to-r from-rose-500 to-pink-500 text-white shadow-rose-500/20 hover:brightness-[1.04]" }, size: { default: "h-9 px-3", sm: "h-8 px-2.5 text-[12px]", icon: "h-8 w-8 p-0" } }, defaultVariants: { variant: "default", size: "default" } });
export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof variants> & { asChild?: boolean };
export function Button({ className, variant, size, asChild, ...props }: ButtonProps) { const Comp = asChild ? Slot : "button"; return <Comp className={cn(variants({ variant, size }), className)} {...props} />; }
