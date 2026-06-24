"use client";

import { useRef, useState } from "react";
import { Save, ShieldCheck, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input, Label, Select } from "./ui/input";
import type { Role } from "@/lib/types";

type AccountRow = {
  id: string;
  username: string;
  email: string;
  role: Role;
  active: boolean;
};

const roles: Role[] = ["admin", "lead", "support", "sales"];
type AccountDraft = { username: string; password: string; email: string; role: Role; active: boolean };

function accountDraft(user: AccountRow, draft?: Partial<AccountDraft>): AccountDraft {
  return {
    username: draft?.username ?? user.username,
    password: draft?.password ?? "",
    email: draft?.email ?? user.email,
    role: draft?.role ?? user.role,
    active: draft?.active ?? user.active,
  };
}

function draftFromUsers(users: AccountRow[]) {
  return Object.fromEntries(users.map((user) => [user.id, accountDraft(user)])) as Record<string, AccountDraft>;
}

export function AccountManager({ initialUsers, currentUserId }: { initialUsers: AccountRow[]; currentUserId: string }) {
  const [users, setUsers] = useState(initialUsers);
  const [drafts, setDrafts] = useState<Record<string, AccountDraft>>(() => draftFromUsers(initialUsers));
  const [busy, setBusy] = useState(false);
  const [savingId, setSavingId] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  function patchDraft(user: AccountRow, patch: Partial<AccountDraft>) {
    setDrafts((current) => ({ ...current, [user.id]: accountDraft(user, { ...current[user.id], ...patch }) }));
  }

  async function createAccount(formData: FormData) {
    setBusy(true);
    try {
      const payload = {
        username: String(formData.get("username") || ""),
        password: String(formData.get("password") || ""),
        email: String(formData.get("email") || ""),
        role: String(formData.get("role") || "support"),
        active: formData.get("active") === "on",
      };
      const response = await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setUsers((current) => [...current, result].sort((a, b) => a.username.localeCompare(b.username)));
      setDrafts((current) => ({ ...current, [result.id]: accountDraft(result) }));
      formRef.current?.reset();
      toast.success(`Created account ${result.username}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create account");
    } finally {
      setBusy(false);
    }
  }

  async function saveAccount(user: AccountRow) {
    const draft = accountDraft(user, drafts[user.id]);
    setSavingId(user.id);
    try {
      const response = await fetch(`/api/accounts/${user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setUsers((current) => current
        .map((item) => item.id === user.id ? result : item)
        .sort((a, b) => a.username.localeCompare(b.username)));
      setDrafts((current) => ({ ...current, [user.id]: accountDraft(result) }));
      toast.success(`Updated ${result.username}`);
    } catch (error) {
      setDrafts((current) => ({ ...current, [user.id]: accountDraft(user) }));
      toast.error(error instanceof Error ? error.message : "Could not update account");
    } finally {
      setSavingId("");
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[.8fr_1.2fr]">
      <Card>
        <CardHeader>
          <CardTitle>Create account</CardTitle>
          <UserPlus size={16} className="text-[#0a84ff]" />
        </CardHeader>
        <CardContent>
          <form ref={formRef} action={createAccount} className="space-y-4">
            <div>
              <Label required>Username</Label>
              <Input name="username" required minLength={3} autoComplete="username" placeholder="username" />
            </div>
            <div>
              <Label required>Password</Label>
              <Input name="password" type="password" required minLength={6} autoComplete="new-password" placeholder="minimum 6 characters" />
            </div>
            <div>
              <Label required>Email</Label>
              <Input name="email" type="email" required autoComplete="email" placeholder="name@example.com" />
            </div>
            <div>
              <Label required>Role</Label>
              <Select name="role" defaultValue="support">
                {roles.map((role) => <option key={role} value={role}>{role}</option>)}
              </Select>
            </div>
            <label className="flex items-center gap-2 text-[12px] font-medium text-slate-700">
              <input name="active" type="checkbox" defaultChecked /> Active
            </label>
            <Button className="w-full" disabled={busy}>
              <ShieldCheck size={15} />
              {busy ? "Creating..." : "Create account"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>System accounts</CardTitle>
          <span className="text-[10px] text-slate-400">{users.length} users</span>
        </CardHeader>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-[12px]">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5">Username</th>
                <th className="px-4 py-2.5">New password</th>
                <th className="px-4 py-2.5">Email</th>
                <th className="px-4 py-2.5">Role</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="w-24 px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {users.map((user) => {
                const draft = accountDraft(user, drafts[user.id]);
                const changed = draft.username !== user.username || draft.password.length > 0 || draft.email !== user.email || draft.role !== user.role || draft.active !== user.active;
                const self = user.id === currentUserId;
                return (
                  <tr key={user.id} className="border-t hover:bg-slate-50/70">
                    <td className="min-w-44 px-4 py-2">
                      <Input value={draft.username} onChange={(event) => patchDraft(user, { username: event.target.value })} />
                      {self && <p className="mt-0.5 text-[10px] text-slate-400">Current admin</p>}
                    </td>
                    <td className="min-w-44 px-4 py-2">
                      <Input type="password" value={draft.password} placeholder="Leave blank to keep" autoComplete="new-password" onChange={(event) => patchDraft(user, { password: event.target.value })} />
                    </td>
                    <td className="min-w-56 px-4 py-2">
                      <Input type="email" value={draft.email} onChange={(event) => patchDraft(user, { email: event.target.value })} />
                    </td>
                    <td className="min-w-36 px-4 py-2">
                      <Select value={draft.role} onChange={(event) => patchDraft(user, { role: event.target.value as Role })}>
                        {roles.map((role) => <option key={role} value={role}>{role}</option>)}
                      </Select>
                    </td>
                    <td className="px-4 py-2">
                      <label className="flex items-center gap-2 text-[12px] font-medium text-slate-700">
                        <input type="checkbox" checked={draft.active} onChange={(event) => patchDraft(user, { active: event.target.checked })} />
                        <Badge tone={draft.active ? "emerald" : "slate"}>{draft.active ? "Active" : "Inactive"}</Badge>
                      </label>
                    </td>
                    <td className="px-4 py-2 text-right">
                      <Button size="sm" variant={changed ? "default" : "outline"} disabled={!changed || savingId === user.id} onClick={() => saveAccount(user)}>
                        <Save size={13} />
                        {savingId === user.id ? "Saving" : "Save"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
