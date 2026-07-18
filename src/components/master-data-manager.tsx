"use client";

import { useMemo, useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Input, Select } from "./ui/input";
import type { Category, Customer, Holiday, NamedMaster, Sla, Status } from "@/lib/types";

type Tab = "sla" | "holidays" | "teams" | "statuses" | "priorities" | "issueTypes" | "contractTypes" | "categories";
type DataMap = {
  sla: Sla[];
  holidays: Holiday[];
  teams: NamedMaster[];
  statuses: Status[];
  priorities: NamedMaster[];
  issueTypes: NamedMaster[];
  contractTypes: NamedMaster[];
  categories: Category[];
};

const labels: Record<Tab, string> = {
  sla: "SLA",
  holidays: "Holidays",
  teams: "Teams",
  statuses: "Statuses",
  priorities: "Priorities",
  issueTypes: "Issue types",
  contractTypes: "Contract types",
  categories: "Categories",
};

function customerNameKey(value: string) {
  return value.trim().toLowerCase();
}

function resolvedCategoryCustomerName(item: Category, customerNameByKey: Map<string, string>) {
  return item.customerName || customerNameByKey.get(item.customerKey) || "";
}

function compareCategoryItems(a: Category, b: Category, customerNameByKey: Map<string, string>) {
  return resolvedCategoryCustomerName(a, customerNameByKey).localeCompare(resolvedCategoryCustomerName(b, customerNameByKey), undefined, { sensitivity: "base", numeric: true }) ||
    a.category.localeCompare(b.category, undefined, { sensitivity: "base", numeric: true });
}

function sortCategoryItems(items: Category[], customerNameByKey: Map<string, string>) {
  return [...items].sort((a, b) => compareCategoryItems(a, b, customerNameByKey));
}

function normalizeCategoryItems(items: Category[], customerNameByKey: Map<string, string>) {
  return sortCategoryItems(
    items.map((item) => ({
      ...item,
      customerKey: "",
      customerName: resolvedCategoryCustomerName(item, customerNameByKey),
    })),
    customerNameByKey,
  );
}

export function MasterDataManager({ initial, customers }: { initial: DataMap; customers: Customer[] }) {
  const customerNameByKey = useMemo(() => new Map(customers.map((customer) => [customer.key, customer.customerName])), [customers]);
  const customerOptions = useMemo(
    () => {
      const options = new Map<string, { name: string; projects: number }>();
      for (const customer of customers) {
        const key = customerNameKey(customer.customerName);
        const current = options.get(key);
        options.set(key, { name: current?.name || customer.customerName, projects: (current?.projects || 0) + 1 });
      }
      return [...options.values()].sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }));
    },
    [customers],
  );
  const [tab, setTab] = useState<Tab>("sla");
  const [data, setData] = useState<DataMap>(() => ({
    ...initial,
    categories: normalizeCategoryItems(initial.categories, customerNameByKey),
  }));
  const [busy, setBusy] = useState(false);
  const items = data[tab];

  function setItems(value: DataMap[Tab]) {
    setData((current) => ({ ...current, [tab]: value }));
  }

  function add() {
    const id = crypto.randomUUID();
    if (tab === "sla") setItems([...(items as Sla[]), { id, customerName: "", p1: 4, p2: 8, p3: 16, p4: 24 }]);
    else if (tab === "holidays") setItems([...(items as Holiday[]), { id, date: "", name: "" }]);
    else if (tab === "statuses") setItems([...(items as Status[]), { id, label: "", kanban: "open", color: "slate" }]);
    else if (tab === "teams") setItems([...(items as NamedMaster[]), { id, name: "", lob: "", email: "", phone: "", active: true }]);
    else if (tab === "categories") {
      const customer = customerOptions[0];
      setItems([...(items as Category[]), {
        id,
        customerKey: "",
        customerName: customer?.name || "",
        category: "",
        active: true,
      }]);
    }
    else setItems([...(items as NamedMaster[]), { id, name: "", active: true }]);
  }

  function patch(id: string, field: string, value: string | number | boolean) {
    setItems(items.map((item) => item.id === id ? { ...item, [field]: value } : item) as DataMap[Tab]);
  }

  function patchCategoryCustomer(id: string, customerName: string) {
    setItems((items as Category[]).map((item) => item.id === id ? {
      ...item,
      customerKey: "",
      customerName,
    } : item) as DataMap[Tab]);
  }

  async function save() {
    setBusy(true);
    const payload = tab === "categories"
      ? normalizeCategoryItems(items as Category[], customerNameByKey).map((item) => ({ ...item, category: item.category.trim(), customerName: item.customerName.trim() }))
      : items;
    try {
      const response = await fetch(`/api/master/${tab}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (tab === "categories") setItems(payload as DataMap[Tab]);
      toast.success(`${labels[tab]} saved`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save master data");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-white">
      <div className="flex flex-wrap items-center gap-1 border-b bg-slate-50 px-3 pt-3">
        {(Object.keys(labels) as Tab[]).map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`rounded-t-md px-4 py-2.5 text-[12px] font-medium ${tab === key ? "border border-b-white bg-white text-[#0a84ff] -mb-px" : "text-slate-500 hover:text-slate-800"}`}
          >
            {labels[key]}
          </button>
        ))}
      </div>
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div>
          <p className="font-semibold text-slate-800">{labels[tab]}</p>
          <p className="mt-0.5 text-[10px] text-slate-400">
            {items.length} configured records
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={add}>
            <Plus size={14} />Add row
          </Button>
          <Button size="sm" onClick={save} disabled={busy}>
            <Save size={14} />{busy ? "Saving..." : "Save changes"}
          </Button>
        </div>
      </div>
      <div className="overflow-x-auto p-4">
        {tab === "sla" ? (
          <table className="mobile-form-table w-full text-left">
            <thead className="text-[10px] uppercase text-slate-400">
              <tr><th className="pb-2">Customer name</th><th className="pb-2">P1 hours</th><th className="pb-2">P2 hours</th><th className="pb-2">P3 hours</th><th className="pb-2">P4 hours</th><th /></tr>
            </thead>
            <tbody>
              {(items as Sla[]).map((item) => (
                <tr key={item.id}>
                  <td data-label="Customer name" className="py-1 pr-2"><Input value={item.customerName} onChange={(e) => patch(item.id, "customerName", e.target.value)} /></td>
                  {(["p1", "p2", "p3", "p4"] as const).map((field) => (
                    <td data-label={`${field.toUpperCase()} hours`} className="py-1 pr-2" key={field}><Input type="number" min="1" value={item[field]} onChange={(e) => patch(item.id, field, Number(e.target.value))} /></td>
                  ))}
                  <td data-action><Button variant="ghost" size="icon" onClick={() => setItems(items.filter((i) => i.id !== item.id) as DataMap[Tab])}><Trash2 size={14} className="text-rose-500" /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : tab === "holidays" ? (
          <table className="mobile-form-table w-full text-left">
            <thead className="text-[10px] uppercase text-slate-400">
              <tr><th className="pb-2">Date</th><th className="pb-2">Holiday name</th><th /></tr>
            </thead>
            <tbody>
              {(items as Holiday[]).map((item) => (
                <tr key={item.id}>
                  <td data-label="Date" className="w-52 py-1 pr-2"><Input type="date" value={item.date} onChange={(e) => patch(item.id, "date", e.target.value)} /></td>
                  <td data-label="Holiday name" className="py-1 pr-2"><Input value={item.name} onChange={(e) => patch(item.id, "name", e.target.value)} /></td>
                  <td data-action><Button variant="ghost" size="icon" onClick={() => setItems(items.filter((i) => i.id !== item.id) as DataMap[Tab])}><Trash2 size={14} className="text-rose-500" /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : tab === "statuses" ? (
          <table className="mobile-form-table w-full text-left">
            <thead className="text-[10px] uppercase text-slate-400">
              <tr><th className="pb-2">Raw code</th><th className="pb-2">Raw label</th><th className="pb-2">Kanban mapping</th><th className="pb-2">Color</th><th /></tr>
            </thead>
            <tbody>
              {(items as Status[]).map((item) => (
                <tr key={item.id}>
                  <td data-label="Raw code" className="w-28 py-1 pr-2"><Input value={item.id} disabled /></td>
                  <td data-label="Raw label" className="py-1 pr-2"><Input value={item.label} onChange={(e) => patch(item.id, "label", e.target.value)} /></td>
                  <td data-label="Kanban mapping" className="w-44 py-1 pr-2">
                    <Select value={item.kanban} onChange={(e) => patch(item.id, "kanban", e.target.value)}>
                      {["open", "in_progress", "waiting", "monitor", "resolved", "closed", "cancelled"].map((v) => <option key={v}>{v}</option>)}
                    </Select>
                  </td>
                  <td data-label="Color" className="w-32 py-1 pr-2"><Input value={item.color} onChange={(e) => patch(item.id, "color", e.target.value)} /></td>
                  <td data-action><Button variant="ghost" size="icon" onClick={() => setItems(items.filter((i) => i.id !== item.id) as DataMap[Tab])}><Trash2 size={14} className="text-rose-500" /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : tab === "categories" ? (
          <table className="mobile-form-table w-full text-left">
            <thead className="text-[10px] uppercase text-slate-400">
              <tr><th className="pb-2">Customer</th><th className="pb-2">Category</th><th className="w-40 pb-2">State</th><th /></tr>
            </thead>
            <tbody>
              {sortCategoryItems(items as Category[], customerNameByKey).map((item) => (
                <tr key={item.id}>
                  <td data-label="Customer" className="min-w-72 py-1 pr-2">
                    <Select value={resolvedCategoryCustomerName(item, customerNameByKey)} onChange={(e) => patchCategoryCustomer(item.id, e.target.value)}>
                      <option value="">Select customer</option>
                      {customerOptions.map((customer) => <option key={customer.name} value={customer.name}>{customer.name}{customer.projects > 1 ? ` (${customer.projects} projects)` : ""}</option>)}
                      {resolvedCategoryCustomerName(item, customerNameByKey) && !customerOptions.some((customer) => customer.name === resolvedCategoryCustomerName(item, customerNameByKey)) && (
                        <option value={resolvedCategoryCustomerName(item, customerNameByKey)}>{resolvedCategoryCustomerName(item, customerNameByKey)}</option>
                      )}
                    </Select>
                  </td>
                  <td data-label="Category" className="min-w-64 py-1 pr-2"><Input value={item.category} onChange={(e) => patch(item.id, "category", e.target.value)} placeholder="Category" /></td>
                  <td data-label="State" className="py-1 pr-2">
                    <Select value={item.active ? "active" : "inactive"} onChange={(e) => patch(item.id, "active", e.target.value === "active")}>
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </Select>
                  </td>
                  <td data-action><Button variant="ghost" size="icon" onClick={() => setItems(items.filter((i) => i.id !== item.id) as DataMap[Tab])}><Trash2 size={14} className="text-rose-500" /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : tab === "teams" ? (
          <table className="mobile-form-table w-full text-left">
            <thead className="text-[10px] uppercase text-slate-400">
              <tr><th className="pb-2">Name</th><th className="pb-2">LOB</th><th className="pb-2">Email</th><th className="pb-2">Phone</th><th className="w-40 pb-2">State</th><th /></tr>
            </thead>
            <tbody>
              {(items as NamedMaster[]).map((item) => (
                <tr key={item.id}>
                  <td data-label="Name" className="min-w-48 py-1 pr-2"><Input value={item.name} onChange={(e) => patch(item.id, "name", e.target.value)} /></td>
                  <td data-label="LOB" className="min-w-40 py-1 pr-2"><Input value={item.lob || ""} placeholder="LOB" onChange={(e) => patch(item.id, "lob", e.target.value)} /></td>
                  <td data-label="Email" className="min-w-64 py-1 pr-2"><Input type="email" value={item.email || ""} placeholder="name@example.com" onChange={(e) => patch(item.id, "email", e.target.value)} /></td>
                  <td data-label="Phone" className="min-w-44 py-1 pr-2"><Input value={item.phone || ""} placeholder="Phone number" onChange={(e) => patch(item.id, "phone", e.target.value)} /></td>
                  <td data-label="State" className="py-1 pr-2">
                    <Select value={item.active ? "active" : "inactive"} onChange={(e) => patch(item.id, "active", e.target.value === "active")}>
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </Select>
                  </td>
                  <td data-action><Button variant="ghost" size="icon" onClick={() => setItems(items.filter((i) => i.id !== item.id) as DataMap[Tab])}><Trash2 size={14} className="text-rose-500" /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="mobile-form-table w-full text-left">
            <thead className="text-[10px] uppercase text-slate-400">
              <tr><th className="pb-2">Name</th><th className="w-40 pb-2">State</th><th /></tr>
            </thead>
            <tbody>
              {(items as NamedMaster[]).map((item) => (
                <tr key={item.id}>
                  <td data-label="Name" className="py-1 pr-2"><Input value={item.name} onChange={(e) => patch(item.id, "name", e.target.value)} /></td>
                  <td data-label="State" className="py-1 pr-2">
                    <Select value={item.active ? "active" : "inactive"} onChange={(e) => patch(item.id, "active", e.target.value === "active")}>
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </Select>
                  </td>
                  <td data-action><Button variant="ghost" size="icon" onClick={() => setItems(items.filter((i) => i.id !== item.id) as DataMap[Tab])}><Trash2 size={14} className="text-rose-500" /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
