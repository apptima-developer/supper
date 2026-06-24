import { Button } from "./button";

function pageWindow(page: number, totalPages: number) {
  return Array.from(new Set([1, page - 1, page, page + 1, totalPages]))
    .filter((item) => item >= 1 && item <= totalPages)
    .sort((a, b) => a - b);
}

export function PaginationControls({
  total,
  page,
  pageSize,
  itemLabel,
  onPageChange,
}: {
  total: number;
  page: number;
  pageSize: number;
  itemLabel: string;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const start = total ? (safePage - 1) * pageSize + 1 : 0;
  const end = Math.min(safePage * pageSize, total);
  const pages = pageWindow(safePage, totalPages);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-white/50 px-4 py-3">
      <p className="text-[11px] text-slate-500">
        Showing <span className="font-semibold text-slate-700">{start}-{end}</span> of{" "}
        <span className="font-semibold text-slate-700">{total}</span> {itemLabel}
      </p>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" disabled={safePage <= 1} onClick={() => onPageChange(safePage - 1)}>
          Previous
        </Button>
        {pages.map((item, index) => (
          <div key={item} className="flex items-center gap-1">
            {index > 0 && item - pages[index - 1] > 1 && <span className="px-1 text-[11px] text-slate-400">...</span>}
            <Button
              variant={item === safePage ? "default" : "outline"}
              size="sm"
              className="min-w-8 px-2"
              onClick={() => onPageChange(item)}
            >
              {item}
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" disabled={safePage >= totalPages} onClick={() => onPageChange(safePage + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}
