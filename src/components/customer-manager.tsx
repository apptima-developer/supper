"use client";
import { useMemo, useState, type FocusEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Search, SquarePen, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Badge, statusTone } from "./ui/badge";
import { Dialog, DialogContent } from "./ui/dialog";
import { Input, Label, Select, Textarea } from "./ui/input";
import { MultiSelectFilter } from "./ui/multi-select-filter";
import { PaginationControls } from "./ui/pagination-controls";
import { EmptyState } from "./empty-state";
import { Progress } from "./ui/progress";
import { contractLifecycle, contractRowState, manualContractStatus } from "@/lib/domain";
import { formatAmount, formatDate, formatNumber } from "@/lib/utils";
import type { Customer, NamedMaster, Role } from "@/lib/types";

const blank = {
  year: new Date().getFullYear(),
  projectCode: "",
  customerName: "",
  contractType: "",
  contractStatus: "Active",
  mdPurchased: 0,
  carryForward: 0,
  mdRate: 0,
  startPeriod: "",
  endPeriod: "",
  renewalAlert: "",
  aeUpdate: "",
  active: true,
};
const mdStep = "0.00001";
const pageSize = 20;
const contractStatusOrder = { Active: 0, "Pre-sales": 1, Done: 2, Suspended: 3 };

function parseNumber(value: FormDataEntryValue | null) {
  const raw = String(value ?? "").replace(/,/g, "").trim();
  return raw ? Number(raw) : 0;
}

function focusAmount(event: FocusEvent<HTMLInputElement>) {
  event.currentTarget.value = event.currentTarget.value.replace(/,/g, "");
}

function blurAmount(event: FocusEvent<HTMLInputElement>) {
  const value = parseNumber(event.currentTarget.value);
  if (Number.isFinite(value)) event.currentTarget.value = formatAmount(value);
}

function capacity(customer: Customer) {
  return customer.mdPurchased + (customer.carryForward || 0);
}

function remaining(customer: Customer) {
  return capacity(customer) - customer.mdUsed;
}

function rowClass(customer: Customer) {
  const state = contractRowState(customer);
  if (state === "expiring") return "border-l-4 border-l-amber-400 border-t bg-amber-100/70 transition-colors hover:bg-amber-100/90";
  if (state === "expired") return "border-l-4 border-l-slate-400 border-t bg-slate-200/60 transition-colors hover:bg-slate-200/80";
  if (state === "suspended") return "border-l-4 border-l-rose-400 border-t bg-rose-100/70 transition-colors hover:bg-rose-100/90";
  if (state === "done") return "border-l-4 border-l-slate-500 border-t bg-slate-200/70 transition-colors hover:bg-slate-200/90";
  if (state === "pre-sales") return "border-l-4 border-l-violet-400 border-t bg-violet-100/70 transition-colors hover:bg-violet-100/90";
  return "border-l-4 border-l-transparent border-t transition-colors hover:bg-sky-50/70";
}

function contractStatusBadgeClass(status: string) {
  if (status === "Suspended") return "bg-rose-100 text-rose-800 ring-rose-200";
  if (status === "Pre-sales") return "bg-violet-100 text-violet-800 ring-violet-200";
  if (status === "Done") return "bg-slate-200 text-slate-700 ring-slate-300";
  return "bg-emerald-100 text-emerald-800 ring-emerald-200";
}

function lifecycleBadgeClass(lifecycle: string) {
  if (lifecycle === "Expiring") return "bg-amber-100 text-amber-800 ring-amber-200";
  return "bg-slate-200 text-slate-700 ring-slate-300";
}

function compareCustomers(a: Customer, b: Customer) {
  const statusDiff = contractStatusOrder[manualContractStatus(a.contractStatus)] - contractStatusOrder[manualContractStatus(b.contractStatus)];
  if (statusDiff) return statusDiff;
  return (
    a.customerName.localeCompare(b.customerName, undefined, { sensitivity: "base", numeric: true }) ||
    a.projectCode.localeCompare(b.projectCode, undefined, { sensitivity: "base", numeric: true })
  );
}

export function CustomerManager({ customers, contractTypes, role }: { customers: Customer[]; contractTypes: NamedMaster[]; role: Role }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [contractStatuses, setContractStatuses] = useState<string[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [busy, setBusy] = useState(false);
  const manage = role === "admin" || role === "lead";
  const aeOnly = role === "sales";
  const showFinancials = manage || aeOnly;
  const showActions = manage || aeOnly;
  const contractStatusOptions = useMemo(() => {
    const counts = customers.reduce<Record<string, number>>((acc, customer) => {
      const status = manualContractStatus(customer.contractStatus);
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {});
    return ["Active", "Suspended", "Pre-sales", "Done"].map((status) => ({ value: status, label: status, count: counts[status] || 0 }));
  }, [customers]);
  const filtered = useMemo(
    () => customers
      .filter((c) => (
        c.active &&
        `${c.projectCode} ${c.customerName} ${c.contractType}`.toLowerCase().includes(query.toLowerCase()) &&
        (contractStatuses.length === 0 || contractStatuses.includes(manualContractStatus(c.contractStatus)))
      ))
      .sort(compareCustomers),
    [contractStatuses, customers, query],
  );
  const archivedCustomers = useMemo(
    () => customers
      .filter((c) => (
        !c.active &&
        `${c.projectCode} ${c.customerName} ${c.contractType}`.toLowerCase().includes(query.toLowerCase()) &&
        (contractStatuses.length === 0 || contractStatuses.includes(manualContractStatus(c.contractStatus)))
      ))
      .sort(compareCustomers),
    [contractStatuses, customers, query],
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const activePage = Math.min(currentPage, totalPages);
  const pageCustomers = useMemo(() => filtered.slice((activePage - 1) * pageSize, activePage * pageSize), [activePage, filtered]);

  function show(customer?: Customer) {
    setEditing(customer || null);
    setOpen(true);
  }

  async function save(formData: FormData) {
    setBusy(true);
    const base: Partial<Customer> = editing || blank;
    const mdPurchased = parseNumber(formData.get("mdPurchased"));
    const carryForward = parseNumber(formData.get("carryForward"));
    const payload = aeOnly
      ? { aeUpdate: String(formData.get("aeUpdate") || "") }
      : {
          year: Number(formData.get("year")),
          projectCode: String(formData.get("projectCode")),
          customerName: String(formData.get("customerName")),
          contractType: String(formData.get("contractType")),
          contractStatus: String(formData.get("contractStatus")),
          mdPurchased,
          carryForward,
          mdRate: parseNumber(formData.get("mdRate")),
          startPeriod: String(formData.get("startPeriod")),
          endPeriod: String(formData.get("endPeriod")),
          renewalAlert: String(formData.get("renewalAlert")),
          aeUpdate: String(formData.get("aeUpdate")),
          active: formData.get("active") === "on",
          mdUsed: base.mdUsed || 0,
          mdRemaining: mdPurchased + carryForward - (base.mdUsed || 0),
          burnRate: base.burnRate || 0,
          mdStatus: base.mdStatus || "Healthy",
        };

    try {
      const response = await fetch(editing ? `/api/customers/${editing.id}` : "/api/customers", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      toast.success(editing ? "Customer updated" : "Customer created");
      setOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save customer");
    } finally {
      setBusy(false);
    }
  }

  async function remove(customer: Customer) {
    if (!confirm(`Delete ${customer.customerName}?`)) return;
    const response = await fetch(`/api/customers/${customer.id}`, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok) return toast.error(result.error);
    toast.success("Customer deleted");
    router.refresh();
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-64 flex-1">
          <Search className="absolute left-3 top-2.5 text-slate-400" size={15} />
          <Input className="pl-9" value={query} onChange={(e) => { setQuery(e.target.value); setCurrentPage(1); }} placeholder="Search customer, project, contract..." />
        </div>
        <MultiSelectFilter
          className="w-56"
          label="Status"
          allLabel="All contract statuses"
          options={contractStatusOptions}
          selected={contractStatuses}
          onChange={(values) => { setContractStatuses(values); setCurrentPage(1); }}
        />
        <Button variant={showArchived ? "default" : "outline"} onClick={() => setShowArchived((current) => !current)}>
          Archived
          <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${showArchived ? "bg-white/20 text-white" : "bg-slate-100 text-slate-600"}`}>{archivedCustomers.length}</span>
        </Button>
        {manage && <Button onClick={() => show()}><Plus size={15} />Add customer</Button>}
      </div>

      {showArchived && (
        <div className="mb-4 overflow-hidden rounded-lg border bg-white">
          <div className="flex items-center justify-between gap-3 border-b bg-slate-50 px-4 py-3">
            <div>
              <p className="font-semibold text-slate-800">Archived customers</p>
              <p className="mt-0.5 text-[10px] text-slate-400">Inactive customer contracts hidden from the main list.</p>
            </div>
            <Badge tone="slate">{archivedCustomers.length} inactive</Badge>
          </div>
          {archivedCustomers.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
                  <tr>
                    {showActions && <th className="w-20 px-4 py-2.5" />}
                    <th className="px-4 py-2.5">Customer</th>
                    <th className="px-4 py-2.5">Contract</th>
                    <th className="px-4 py-2.5">Period</th>
                    <th className="px-4 py-2.5">Remaining</th>
                  </tr>
                </thead>
                <tbody>
                  {archivedCustomers.map((c) => {
                    const manualStatus = manualContractStatus(c.contractStatus);
                    const lifecycle = contractLifecycle(c);
                    return (
                      <tr key={c.id} className={rowClass(c)}>
                        {showActions && (
                          <td className="px-4 py-2">
                            <div className="flex justify-start gap-1">
                              <Button variant="ghost" size="icon" onClick={() => show(c)} title="Edit"><SquarePen size={14} /></Button>
                              {manage && <Button variant="ghost" size="icon" onClick={() => remove(c)} title="Delete"><Trash2 size={14} className="text-rose-500" /></Button>}
                            </div>
                          </td>
                        )}
                        <td className="min-w-72 px-4 py-2">
                          <div className="flex min-w-0 items-center gap-2 whitespace-nowrap">
                            <Link href={`/customers/${c.id}`} className="shrink-0 font-medium text-slate-900 hover:text-[#0a84ff]">{c.customerName}</Link>
                            <span className="truncate text-[10px] text-slate-400" title={c.projectCode}>{c.projectCode}</span>
                            <Badge className="shrink-0">Inactive</Badge>
                          </div>
                        </td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-1.5 whitespace-nowrap">
                            <span className="font-medium text-slate-800">{c.contractType || "-"}</span>
                            <Badge className={contractStatusBadgeClass(manualStatus)}>{manualStatus}</Badge>
                            {lifecycle === "Expiring" && <Badge className={lifecycleBadgeClass(lifecycle)}>Expiring</Badge>}
                            {lifecycle === "Expired" && <Badge className={lifecycleBadgeClass(lifecycle)}>Expired</Badge>}
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 text-[11px]">
                          {formatDate(c.startPeriod)}{" "}
                          <span className="text-slate-400">to {formatDate(c.endPeriod)}</span>
                        </td>
                        <td className="whitespace-nowrap px-4 py-2 font-semibold text-slate-800">{formatNumber(remaining(c))} MD</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-8 text-center text-[12px] text-slate-400">No archived customers match the current filters.</div>
          )}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border bg-white">
        {filtered.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
                <tr>
                  {showActions && <th className="w-24 px-4 py-2.5">Action</th>}
                  <th className="px-4 py-2.5">Customer</th>
                  <th className="px-4 py-2.5">Contract</th>
                  <th className="px-4 py-2.5">Period</th>
                  <th className="px-4 py-2.5">MD utilization</th>
                  {showFinancials && <th className="px-4 py-2.5">MD rate</th>}
                  {showFinancials && <th className="px-4 py-2.5">Amount</th>}
                  <th className="px-4 py-2.5">Remaining</th>
                  <th className="px-4 py-2.5">Health</th>
                </tr>
              </thead>
              <tbody>
                {pageCustomers.map((c) => {
                  const totalMd = capacity(c);
                  const remainingMd = remaining(c);
                  const amount = c.mdPurchased * c.mdRate;
                  const manualStatus = manualContractStatus(c.contractStatus);
                  const lifecycle = contractLifecycle(c);
                  return (
                    <tr key={c.id} className={rowClass(c)}>
                      {showActions && (
                        <td className="px-4 py-2">
                          <div className="flex justify-start gap-1">
                            <Button variant="ghost" size="icon" onClick={() => show(c)} title="Edit"><SquarePen size={14} /></Button>
                            {manage && <Button variant="ghost" size="icon" onClick={() => remove(c)} title="Delete"><Trash2 size={14} className="text-rose-500" /></Button>}
                          </div>
                        </td>
                      )}
                      <td className="min-w-72 px-4 py-2">
                        <div className="flex min-w-0 items-center gap-2 whitespace-nowrap">
                          <Link href={`/customers/${c.id}`} className="shrink-0 font-medium text-slate-900 hover:text-[#0a84ff]">{c.customerName}</Link>
                          <span className="truncate text-[10px] text-slate-400" title={c.projectCode}>{c.projectCode}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <div className="flex items-center gap-1.5 whitespace-nowrap">
                          <span className="font-medium text-slate-800">{c.contractType || "-"}</span>
                          <Badge className={contractStatusBadgeClass(manualStatus)}>{manualStatus}</Badge>
                          {lifecycle === "Expiring" && <Badge className={lifecycleBadgeClass(lifecycle)}>Expiring</Badge>}
                          {lifecycle === "Expired" && <Badge className={lifecycleBadgeClass(lifecycle)}>Expired</Badge>}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-[11px]">
                        {formatDate(c.startPeriod)}{" "}
                        <span className="text-slate-400">to {formatDate(c.endPeriod)}</span>
                      </td>
                      <td className="min-w-56 px-4 py-2">
                        <div className="flex items-center gap-2 text-[10px]">
                          <span className="w-16 whitespace-nowrap">{formatNumber(c.mdUsed)} / {formatNumber(totalMd)}</span>
                          <div className="min-w-24 flex-1">
                            <Progress value={c.burnRate} tone={c.burnRate >= 100 ? "bg-rose-500" : c.burnRate >= 80 ? "bg-amber-500" : "bg-gradient-to-r from-[#0a84ff] to-[#20c9b7]"} />
                          </div>
                          <span className="w-9 text-right">{formatNumber(c.burnRate, 0)}%</span>
                        </div>
                      </td>
                      {showFinancials && <td className="whitespace-nowrap px-4 py-2 font-semibold text-slate-800">{formatAmount(c.mdRate)}</td>}
                      {showFinancials && <td className="whitespace-nowrap px-4 py-2 font-semibold text-slate-800">{formatAmount(amount)}</td>}
                      <td className="whitespace-nowrap px-4 py-2 font-semibold text-slate-800">{formatNumber(remainingMd)} MD</td>
                      <td className="whitespace-nowrap px-4 py-2"><Badge tone={statusTone(c.mdStatus)}>{c.mdStatus}</Badge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title={customers.length ? "No matching customers" : "No customers yet"} description={customers.length ? "Try a different search or status filter." : "Import Customer_MD_Control or add the first customer contract."} />
        )}
        {filtered.length > 0 && <PaginationControls total={filtered.length} page={activePage} pageSize={pageSize} itemLabel="customers" onPageChange={setCurrentPage} />}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={editing ? (aeOnly ? "Update AE note" : "Edit customer contract") : "New customer contract"} description={aeOnly ? "Sales access is limited to the AE update field." : "Customer identity is the normalized project code and customer name."}>
          <form action={save} className="space-y-4">
            {!aeOnly && (
              <>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div><Label required>Year</Label><Input name="year" type="number" required defaultValue={editing?.year || blank.year} /></div>
                  <div><Label required>Project code</Label><Input name="projectCode" required defaultValue={editing?.projectCode} /></div>
                  <div><Label required>Customer</Label><Input name="customerName" required defaultValue={editing?.customerName} /></div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <Label>Contract type</Label>
                    <Select name="contractType" defaultValue={editing?.contractType}>
                      {contractTypes.map((item) => <option key={item.id}>{item.name}</option>)}
                      {editing?.contractType && !contractTypes.some((i) => i.name === editing.contractType) && <option>{editing.contractType}</option>}
                    </Select>
                  </div>
                  <div>
                    <Label>Contract status</Label>
                    <Select name="contractStatus" defaultValue={manualContractStatus(editing?.contractStatus || "Active")}>
                      <option>Active</option>
                      <option>Suspended</option>
                      <option>Pre-sales</option>
                      <option>Done</option>
                    </Select>
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div><Label required>MD purchased</Label><Input name="mdPurchased" type="number" step={mdStep} required defaultValue={editing?.mdPurchased || 0} /></div>
                  <div><Label>Carry forward</Label><Input name="carryForward" type="number" step={mdStep} defaultValue={editing?.carryForward || 0} /></div>
                  <div><Label>MD rate</Label><Input name="mdRate" type="text" inputMode="decimal" onFocus={focusAmount} onBlur={blurAmount} defaultValue={formatAmount(editing?.mdRate || 0)} /></div>
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <div><Label>Start period</Label><Input name="startPeriod" type="date" defaultValue={editing?.startPeriod?.slice(0, 10)} /></div>
                  <div><Label>End period</Label><Input name="endPeriod" type="date" defaultValue={editing?.endPeriod?.slice(0, 10)} /></div>
                </div>
                <div><Label>Renewal alert</Label><Textarea name="renewalAlert" defaultValue={editing?.renewalAlert} /></div>
              </>
            )}
            <div><Label>AE update</Label><Textarea name="aeUpdate" defaultValue={editing?.aeUpdate} placeholder="Commercial follow-up, renewal context, customer note..." /></div>
            {!aeOnly && <label className="flex items-center gap-2 text-[12px] text-slate-700"><input name="active" type="checkbox" defaultChecked={editing?.active ?? true} /> Customer is active</label>}
            <div className="flex justify-end gap-2 border-t pt-4">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button disabled={busy}>{busy ? "Saving..." : "Save customer"}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
