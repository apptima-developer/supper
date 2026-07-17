-- SUPPER Phase 0.2: non-destructive data and security foundation.
-- Apply manually after the existing app_store and relational schema scripts.
-- Rollback is intentionally manual: remove the RPC and rate-limit table only after
-- disabling login traffic. The auth_version column can remain safely at version 1.

begin;

create table if not exists public.support_schema_migrations (
  version text primary key,
  description text not null,
  checksum text,
  applied_at timestamptz not null default now(),
  applied_by text
);

comment on table public.support_schema_migrations is
  'Reviewable record of manually applied SUPPER SQL migrations.';

alter table if exists public.support_users
  add column if not exists auth_version integer not null default 1;

do $$
begin
  if to_regclass('public.support_users') is not null then
    comment on column public.support_users.auth_version is
      'Increments when security-sensitive account details change so stale JWT sessions are rejected.';
  end if;
end;
$$;

create table if not exists public.support_login_rate_limits (
  key_hash text primary key,
  failure_count integer not null default 0,
  window_started_at timestamptz not null,
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.support_login_rate_limits is
  'Hashed identity and network login throttling state; contains no usernames, passwords, or raw IP addresses.';

create index if not exists support_login_rate_limits_locked_until_idx
  on public.support_login_rate_limits (locked_until)
  where locked_until is not null;

create or replace function public.support_record_login_failure(
  p_key_hash text,
  p_now timestamptz,
  p_window_seconds integer default 900,
  p_max_failures integer default 5,
  p_lock_seconds integer default 900
)
returns table (
  key_hash text,
  failure_count integer,
  window_started_at timestamptz,
  locked_until timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if length(p_key_hash) < 32 or p_window_seconds < 1 or p_max_failures < 1 or p_lock_seconds < 1 then
    raise exception 'Invalid login rate-limit input';
  end if;

  return query
  insert into public.support_login_rate_limits as current_state (
    key_hash,
    failure_count,
    window_started_at,
    locked_until,
    updated_at
  ) values (
    p_key_hash,
    1,
    p_now,
    case when p_max_failures <= 1 then p_now + make_interval(secs => p_lock_seconds) else null end,
    p_now
  )
  on conflict (key_hash) do update set
    failure_count = case
      when current_state.locked_until is not null and current_state.locked_until > p_now then current_state.failure_count
      when p_now >= current_state.window_started_at + make_interval(secs => p_window_seconds) then 1
      else current_state.failure_count + 1
    end,
    window_started_at = case
      when current_state.locked_until is not null and current_state.locked_until > p_now then current_state.window_started_at
      when p_now >= current_state.window_started_at + make_interval(secs => p_window_seconds) then p_now
      else current_state.window_started_at
    end,
    locked_until = case
      when current_state.locked_until is not null and current_state.locked_until > p_now then current_state.locked_until
      when (
        case
          when p_now >= current_state.window_started_at + make_interval(secs => p_window_seconds) then 1
          else current_state.failure_count + 1
        end
      ) >= p_max_failures then p_now + make_interval(secs => p_lock_seconds)
      else null
    end,
    updated_at = p_now
  returning
    current_state.key_hash,
    current_state.failure_count,
    current_state.window_started_at,
    current_state.locked_until,
    current_state.updated_at;
end;
$$;

alter table public.support_schema_migrations enable row level security;
alter table public.support_login_rate_limits enable row level security;

grant usage on schema public to service_role;
grant select on table public.support_schema_migrations to service_role;
grant select, insert, update, delete on table public.support_login_rate_limits to service_role;
grant execute on function public.support_record_login_failure(text, timestamptz, integer, integer, integer) to service_role;

insert into public.support_schema_migrations (version, description, checksum, applied_by)
values ('202607170001', 'SUPPER Phase 0.2 data and security foundation', null, current_user)
on conflict (version) do nothing;

commit;
