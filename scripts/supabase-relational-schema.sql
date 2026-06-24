create table if not exists public.support_customers (
  id text primary key,
  customer_key text not null unique,
  customer_name text not null,
  project_code text not null default '',
  active boolean not null default true,
  end_period date,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.support_tickets (
  id text primary key,
  issue_id text not null unique,
  customer_key text not null,
  customer_name text not null default '',
  kanban_status text not null default '',
  status text not null default '',
  issue_type text not null default '',
  severity text not null default '',
  ticket_date date,
  start_date date,
  due_date date,
  close_date date,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.support_ticket_history (
  id text primary key,
  ticket_id text not null,
  issue_id text not null,
  field text not null,
  source text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.support_audit_log (
  id text primary key,
  action text not null,
  entity text not null,
  entity_id text not null,
  actor text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.support_users (
  id text primary key,
  username text not null unique,
  email text not null default '',
  role text not null,
  active boolean not null default true,
  data jsonb not null
);

create table if not exists public.support_master_data (
  kind text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.support_import_batches (
  id text primary key,
  status text not null,
  kind text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.support_import_snapshots (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.support_report_jobs (
  id text primary key,
  customer_key text not null,
  month text not null,
  status text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.support_report_assets (
  file_name text primary key,
  content_type text not null,
  data jsonb not null,
  created_at timestamptz not null default now()
);

create unique index if not exists support_users_email_unique
  on public.support_users (email)
  where email <> '';

create index if not exists support_customers_active_idx on public.support_customers (active);
create index if not exists support_customers_name_idx on public.support_customers (customer_name);
create index if not exists support_tickets_customer_key_idx on public.support_tickets (customer_key);
create index if not exists support_tickets_kanban_status_idx on public.support_tickets (kanban_status);
create index if not exists support_tickets_start_date_idx on public.support_tickets (start_date);
create index if not exists support_tickets_due_date_idx on public.support_tickets (due_date);
create index if not exists support_tickets_updated_at_idx on public.support_tickets (updated_at desc);
create index if not exists support_ticket_history_ticket_id_idx on public.support_ticket_history (ticket_id);
create index if not exists support_ticket_history_issue_id_idx on public.support_ticket_history (issue_id);
create index if not exists support_ticket_history_created_at_idx on public.support_ticket_history (created_at desc);
create index if not exists support_audit_log_created_at_idx on public.support_audit_log (created_at desc);
create index if not exists support_import_batches_created_at_idx on public.support_import_batches (created_at desc);
create index if not exists support_report_jobs_created_at_idx on public.support_report_jobs (created_at desc);

alter table public.support_customers enable row level security;
alter table public.support_tickets enable row level security;
alter table public.support_ticket_history enable row level security;
alter table public.support_audit_log enable row level security;
alter table public.support_users enable row level security;
alter table public.support_master_data enable row level security;
alter table public.support_import_batches enable row level security;
alter table public.support_import_snapshots enable row level security;
alter table public.support_report_jobs enable row level security;
alter table public.support_report_assets enable row level security;

-- The app uses SUPABASE_SERVICE_ROLE_KEY from server-only code.
-- Service-role requests bypass RLS, so no public policy is required.
grant usage on schema public to service_role;
grant select, insert, update, delete on table public.support_customers to service_role;
grant select, insert, update, delete on table public.support_tickets to service_role;
grant select, insert, update, delete on table public.support_ticket_history to service_role;
grant select, insert, update, delete on table public.support_audit_log to service_role;
grant select, insert, update, delete on table public.support_users to service_role;
grant select, insert, update, delete on table public.support_master_data to service_role;
grant select, insert, update, delete on table public.support_import_batches to service_role;
grant select, insert, update, delete on table public.support_import_snapshots to service_role;
grant select, insert, update, delete on table public.support_report_jobs to service_role;
grant select, insert, update, delete on table public.support_report_assets to service_role;
