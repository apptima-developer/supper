export function PageHeader({ title, description, actions }: { title: string; description: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-4 overflow-hidden rounded-3xl border border-white/75 bg-white/68 px-5 py-3 shadow-[0_20px_55px_rgba(35,77,112,.09)] backdrop-blur-2xl">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="h-1.5 w-10 rounded-full bg-gradient-to-r from-[#0a84ff] to-[#20c9b7] shadow-[0_0_18px_rgba(10,132,255,.26)]" />
            <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[.18em] text-sky-600/70">{title}</span>
            <span className="min-w-0 text-[12px] leading-5 text-slate-500">{description}</span>
          </div>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
