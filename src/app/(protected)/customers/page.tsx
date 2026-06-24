import { PageHeader } from "@/components/page-header";
import { CustomerManager } from "@/components/customer-manager";
import { requireSession } from "@/lib/auth";
import { customerRepository, masterRepositories } from "@/lib/repositories";
export const dynamic = "force-dynamic";
export default async function CustomersPage() { const [session, customers, contractTypes] = await Promise.all([requireSession(), customerRepository.list(), masterRepositories.contractTypes.list()]); return <><PageHeader title="Customer contracts" description="Control active contracts, maintenance-day consumption, renewal signals, and AE follow-up. Inactive customers stay in Archived." /><CustomerManager customers={customers} contractTypes={contractTypes} role={session.role} /></>; }
