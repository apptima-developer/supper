export function PageHeader({ title, description, actions }: { title: string; description: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 overflow-hidden rounded-3xl border border-white/75 bg-white/68 px-5 py-4 shadow-[0_20px_55px_rgba(35,77,112,.09)] backdrop-blur-2xl">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="h-1.5 w-10 rounded-full bg-gradient-to-r from-[#0a84ff] to-[#20c9b7] shadow-[0_0_18px_rgba(10,132,255,.26)]" />
            <span className="text-[10px] font-semibold uppercase tracking-[.18em] text-sky-600/70">Control room</span>
          </div>
          <h1 className="text-[23px] font-semibold tracking-tight text-[#132f46]">{title}</h1>
          <p className="mt-1 max-w-3xl text-[12px] leading-5 text-slate-500">{description}</p>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
