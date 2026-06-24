create table if not exists public.app_store (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.app_store enable row level security;

-- The app uses SUPABASE_SERVICE_ROLE_KEY from server-only code.
-- Service-role requests bypass RLS, so no public policy is required.
grant usage on schema public to service_role;
grant select, insert, update, delete on table public.app_store to service_role;
