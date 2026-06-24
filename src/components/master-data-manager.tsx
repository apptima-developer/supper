"use client";

import { useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Input, Select } from "./ui/input";
import type { Holiday, NamedMaster, Sla, Status } from "@/lib/types";

type Tab = "sla" | "holidays" | "teams" | "statuses" | "priorities" | "issueTypes" | "contractTypes";
type DataMap = {
  sla: Sla[];
  holidays: Holiday[];
  teams: NamedMaster[];
  statuses: Status[];
  priorities: NamedMaster[];
  issueTypes: NamedMaster[];
  contractTypes: NamedMaster[];
};

const labels: Record<Tab, string> = {
  sla: "SLA",
  holidays: "Holidays",
  teams: "Teams",
  statuses: "Statuses",
  priorities: "Priorities",
  issueTypes: "Issue types",
  contractTypes: "Contract types",
};

export function MasterDataManager({ initial }: { initial: DataMap }) {
  const [tab, setTab] = useState<Tab>("sla");
  const [data, setData] = useState(initial);
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
    else setItems([...(items as NamedMaster[]), { id, name: "", active: true }]);
  }

  function patch(id: string, field: string, value: string | number | boolean) {
    setItems(items.map((item) => item.id === id ? { ...item, [field]: value } : item) as DataMap[Tab]);
  }

  async function save() {
    setBusy(true);
    try {
      const response = await fetch(`/api/master/${tab}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(items),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
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
          <table className="w-full text-left">
            <thead className="text-[10px] uppercase text-slate-400">
              <tr><th className="pb-2">Customer name</th><th className="pb-2">P1 hours</th><th className="pb-2">P2 hours</th><th className="pb-2">P3 hours</th><th className="pb-2">P4 hours</th><th /></tr>
            </thead>
            <tbody>
              {(items as Sla[]).map((item) => (
                <tr key={item.id}>
                  <td className="py-1 pr-2"><Input value={item.customerName} onChange={(e) => patch(item.id, "customerName", e.target.value)} /></td>
                  {(["p1", "p2", "p3", "p4"] as const).map((field) => (
                    <td className="py-1 pr-2" key={field}><Input type="number" min="1" value={item[field]} onChange={(e) => patch(item.id, field, Number(e.target.value))} /></td>
                  ))}
                  <td><Button variant="ghost" size="icon" onClick={() => setItems(items.filter((i) => i.id !== item.id) as DataMap[Tab])}><Trash2 size={14} className="text-rose-500" /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : tab === "holidays" ? (
          <table className="w-full text-left">
            <thead className="text-[10px] uppercase text-slate-400">
              <tr><th className="pb-2">Date</th><th className="pb-2">Holiday name</th><th /></tr>
            </thead>
            <tbody>
              {(items as Holiday[]).map((item) => (
                <tr key={item.id}>
                  <td className="w-52 py-1 pr-2"><Input type="date" value={item.date} onChange={(e) => patch(item.id, "date", e.target.value)} /></td>
                  <td className="py-1 pr-2"><Input value={item.name} onChange={(e) => patch(item.id, "name", e.target.value)} /></td>
                  <td><Button variant="ghost" size="icon" onClick={() => setItems(items.filter((i) => i.id !== item.id) as DataMap[Tab])}><Trash2 size={14} className="text-rose-500" /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : tab === "statuses" ? (
          <table className="w-full text-left">
            <thead className="text-[10px] uppercase text-slate-400">
              <tr><th className="pb-2">Raw code</th><th className="pb-2">Raw label</th><th className="pb-2">Kanban mapping</th><th className="pb-2">Color</th><th /></tr>
            </thead>
            <tbody>
              {(items as Status[]).map((item) => (
                <tr key={item.id}>
                  <td className="w-28 py-1 pr-2"><Input value={item.id} disabled /></td>
                  <td className="py-1 pr-2"><Input value={item.label} onChange={(e) => patch(item.id, "label", e.target.value)} /></td>
                  <td className="w-44 py-1 pr-2">
                    <Select value={item.kanban} onChange={(e) => patch(item.id, "kanban", e.target.value)}>
                      {["open", "in_progress", "waiting", "monitor", "resolved", "closed", "cancelled"].map((v) => <option key={v}>{v}</option>)}
                    </Select>
                  </td>
                  <td className="w-32 py-1 pr-2"><Input value={item.color} onChange={(e) => patch(item.id, "color", e.target.value)} /></td>
                  <td><Button variant="ghost" size="icon" onClick={() => setItems(items.filter((i) => i.id !== item.id) as DataMap[Tab])}><Trash2 size={14} className="text-rose-500" /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : tab === "teams" ? (
          <table className="w-full text-left">
            <thead className="text-[10px] uppercase text-slate-400">
              <tr><th className="pb-2">Name</th><th className="pb-2">LOB</th><th className="pb-2">Email</th><th className="pb-2">Phone</th><th className="w-40 pb-2">State</th><th /></tr>
            </thead>
            <tbody>
              {(items as NamedMaster[]).map((item) => (
                <tr key={item.id}>
                  <td className="min-w-48 py-1 pr-2"><Input value={item.name} onChange={(e) => patch(item.id, "name", e.target.value)} /></td>
                  <td className="min-w-40 py-1 pr-2"><Input value={item.lob || ""} placeholder="LOB" onChange={(e) => patch(item.id, "lob", e.target.value)} /></td>
                  <td className="min-w-64 py-1 pr-2"><Input type="email" value={item.email || ""} placeholder="name@example.com" onChange={(e) => patch(item.id, "email", e.target.value)} /></td>
                  <td className="min-w-44 py-1 pr-2"><Input value={item.phone || ""} placeholder="Phone number" onChange={(e) => patch(item.id, "phone", e.target.value)} /></td>
                  <td className="py-1 pr-2">
                    <Select value={item.active ? "active" : "inactive"} onChange={(e) => patch(item.id, "active", e.target.value === "active")}>
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </Select>
                  </td>
                  <td><Button variant="ghost" size="icon" onClick={() => setItems(items.filter((i) => i.id !== item.id) as DataMap[Tab])}><Trash2 size={14} className="text-rose-500" /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-left">
            <thead className="text-[10px] uppercase text-slate-400">
              <tr><th className="pb-2">Name</th><th className="w-40 pb-2">State</th><th /></tr>
            </thead>
            <tbody>
              {(items as NamedMaster[]).map((item) => (
                <tr key={item.id}>
                  <td className="py-1 pr-2"><Input value={item.name} onChange={(e) => patch(item.id, "name", e.target.value)} /></td>
                  <td className="py-1 pr-2">
                    <Select value={item.active ? "active" : "inactive"} onChange={(e) => patch(item.id, "active", e.target.value === "active")}>
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </Select>
                  </td>
                  <td><Button variant="ghost" size="icon" onClick={() => setItems(items.filter((i) => i.id !== item.id) as DataMap[Tab])}><Trash2 size={14} className="text-rose-500" /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
