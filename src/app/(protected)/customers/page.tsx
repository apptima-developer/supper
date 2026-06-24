import { PageHeader } from "@/components/page-header";
import { CustomerManager } from "@/components/customer-manager";
import { requireSession } from "@/lib/auth";
import { loadCustomerManagerData } from "@/lib/repositories";
export const dynamic = "force-dynamic";
export default async function CustomersPage() { const [session, data] = await Promise.all([requireSession(), loadCustomerManagerData()]); return <><PageHeader title="Customer contracts" description="Control active contracts, maintenance-day consumption, renewal signals, and AE follow-up. Inactive customers stay in Archived." /><CustomerManager customers={data.customers} contractTypes={data.contractTypes} role={session.role} /></>; }
