"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

export type MultiSelectFilterOption = {
  value: string;
  label: string;
  count?: number;
};

export function MultiSelectFilter({
  label,
  allLabel,
  options,
  selected,
  onChange,
  className,
}: {
  label: string;
  allLabel: string;
  options: MultiSelectFilterOption[];
  selected: string[];
  onChange: (values: string[]) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const filteredOptions = useMemo(
    () => options.filter((option) => `${option.label} ${option.value}`.toLowerCase().includes(query.trim().toLowerCase())),
    [options, query],
  );
  const summary = selected.length === 0
    ? allLabel
    : selected.length === 1
      ? options.find((option) => option.value === selected[0])?.label || selected[0]
      : `${selected.length} selected`;

  useEffect(() => {
    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  function toggle(value: string) {
    const next = new Set(selectedSet);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange([...next]);
  }

  function selectAllVisible() {
    onChange([...new Set([...selected, ...filteredOptions.map((option) => option.value)])]);
  }

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className={cn(
          "flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-sky-100/90 bg-white/80 px-3 text-left text-[12px] font-medium text-slate-700 shadow-sm outline-none transition-all hover:bg-sky-50/70 focus:ring-4 focus:ring-sky-200/35",
          selected.length > 0 && "border-sky-200 bg-sky-50/80 text-[#173b57]",
        )}
      >
        <span className="min-w-0 truncate">
          <span className="text-slate-400">{label}: </span>{summary}
        </span>
        <ChevronDown size={14} className={cn("shrink-0 text-slate-400 transition-transform", open && "rotate-180")} />
      </button>

      {open && (
        <div className="absolute left-0 top-10 z-40 w-72 overflow-hidden rounded-2xl border border-sky-100 bg-white/95 shadow-[0_22px_70px_rgba(35,77,112,.18)] backdrop-blur-xl">
          <div className="border-b border-sky-100/80 p-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
            <div className="relative mt-2">
              <Search className="absolute left-2.5 top-2.5 text-slate-400" size={13} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search filter..."
                className="h-8 w-full rounded-lg border border-sky-100 bg-white/80 pl-8 pr-8 text-[12px] text-slate-700 outline-none focus:ring-4 focus:ring-sky-200/35"
              />
              {query && (
                <button type="button" onClick={() => setQuery("")} className="absolute right-2 top-2 rounded p-0.5 text-slate-400 hover:bg-sky-50 hover:text-slate-700">
                  <X size={12} />
                </button>
              )}
            </div>
            <div className="mt-2 flex gap-2">
              <button type="button" onClick={selectAllVisible} className="rounded-md px-2 py-1 text-[10px] font-semibold text-sky-700 hover:bg-sky-50">Select visible</button>
              <button type="button" onClick={() => onChange([])} className="rounded-md px-2 py-1 text-[10px] font-semibold text-slate-500 hover:bg-slate-50">Clear</button>
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto p-2">
            {filteredOptions.length ? filteredOptions.map((option) => {
              const checked = selectedSet.has(option.value);
              return (
                <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded-xl px-2 py-2 text-[12px] text-slate-700 hover:bg-sky-50/70">
                  <span className={cn("grid h-4 w-4 place-items-center rounded border", checked ? "border-sky-500 bg-sky-500 text-white" : "border-sky-200 bg-white")}>
                    {checked && <Check size={11} />}
                  </span>
                  <input type="checkbox" className="sr-only" checked={checked} onChange={() => toggle(option.value)} />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  {typeof option.count === "number" && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500">{option.count}</span>}
                </label>
              );
            }) : (
              <div className="px-3 py-8 text-center text-[12px] text-slate-400">No values found.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
