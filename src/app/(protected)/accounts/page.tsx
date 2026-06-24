import { redirect } from "next/navigation";
import { AccountManager } from "@/components/account-manager";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth";
import { readJson } from "@/lib/json-store";
import { userListSchema } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  const session = await requireSession();
  if (session.role !== "admin") redirect("/dashboard");

  const users = (await readJson("auth/users.json", userListSchema))
    .map((user) => ({
      id: user.id,
      username: user.username,
      email: user.email,
      role: user.role,
      active: user.active,
    }))
    .sort((a, b) => a.username.localeCompare(b.username, undefined, { sensitivity: "base", numeric: true }));

  return (
    <>
      <PageHeader
        title="Account administration"
        description="Create system login accounts and assign access roles. Admin role only."
      />
      <AccountManager initialUsers={users} currentUserId={session.userId} />
    </>
  );
}
