import { redirect } from "next/navigation";
import { AccountManager } from "@/components/account-manager";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth";
import { userRepository } from "@/lib/repositories";
import { toAdminUserDto } from "@/lib/user-dto";

export const dynamic = "force-dynamic";

export default async function AccountsPage() {
  const session = await requireSession();
  if (session.role !== "admin") redirect("/dashboard");

  const users = (await userRepository.list())
    .map(toAdminUserDto)
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
