import { Children, isValidElement, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn("h-9 w-full rounded-lg border border-sky-100/90 bg-white/80 px-3 text-[13px] text-slate-800 shadow-[0_1px_0_rgba(255,255,255,.9)_inset] outline-none placeholder:text-slate-400 transition-all focus:border-sky-300 focus:bg-white focus:ring-4 focus:ring-sky-200/35", className)} {...props} />;
}

export function Select({ className, children, value, defaultValue, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const selected = value ?? defaultValue;
  const hasSelectedOption = selected == null || Children.toArray(children).some((child) => {
    if (!isValidElement<{ value?: string; children?: React.ReactNode }>(child)) return false;
    return String(child.props.value ?? child.props.children) === String(selected);
  });
  return <select className={cn("h-9 w-full rounded-lg border border-sky-100/90 bg-white/80 px-2 text-[13px] text-slate-800 shadow-[0_1px_0_rgba(255,255,255,.9)_inset] outline-none transition-all focus:border-sky-300 focus:bg-white focus:ring-4 focus:ring-sky-200/35", className)} value={value} defaultValue={defaultValue} {...props}>{!hasSelectedOption && <option value={String(selected)}>{String(selected)}</option>}{children}</select>;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn("min-h-20 w-full resize-y rounded-lg border border-sky-100/90 bg-white/80 px-3 py-2 text-[13px] text-slate-800 shadow-[0_1px_0_rgba(255,255,255,.9)_inset] outline-none transition-all placeholder:text-slate-400 focus:border-sky-300 focus:bg-white focus:ring-4 focus:ring-sky-200/35", className)} {...props} />;
}

export function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">{children}{required && <span className="ml-1 text-rose-500">*</span>}</label>;
}
