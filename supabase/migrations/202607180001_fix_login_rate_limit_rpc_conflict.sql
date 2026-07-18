-- SUPPER Phase 0.2.1 hotfix: disambiguate the login failure upsert without
-- deleting existing throttling state or changing the RPC contract.

begin;

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
set search_path = pg_catalog, public
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
  on conflict on constraint support_login_rate_limits_pkey do update set
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

-- CREATE OR REPLACE preserves existing grants, but repeat the explicit policy
-- so this immutable correction remains independently reviewable and safe.
revoke all privileges on function public.support_record_login_failure(
  text,
  timestamptz,
  integer,
  integer,
  integer
) from public;

revoke execute on function public.support_record_login_failure(
  text,
  timestamptz,
  integer,
  integer,
  integer
) from anon, authenticated;

grant execute on function public.support_record_login_failure(
  text,
  timestamptz,
  integer,
  integer,
  integer
) to service_role;

comment on function public.support_record_login_failure(
  text,
  timestamptz,
  integer,
  integer,
  integer
) is 'Server-only atomic login failure recorder. Uses the primary-key constraint to avoid PL/pgSQL output-column ambiguity.';

insert into public.support_schema_migrations (version, description, checksum, applied_by)
values ('202607180001', 'Fix login rate-limit RPC conflict target ambiguity', null, current_user)
on conflict (version) do nothing;

commit;
