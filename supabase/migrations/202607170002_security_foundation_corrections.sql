-- SUPPER Phase 0.2.1: close the default PUBLIC execution privilege on the
-- SECURITY DEFINER login rate-limit RPC without replacing the function or state.

begin;

-- PostgreSQL grants function execution to PUBLIC by default. Leaving that grant
-- on a SECURITY DEFINER RPC would let untrusted roles execute with owner rights.
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

-- Keep catalog resolution trusted while retaining access to the existing public
-- rate-limit table. This changes configuration only; function behavior is intact.
alter function public.support_record_login_failure(
  text,
  timestamptz,
  integer,
  integer,
  integer
) set search_path = pg_catalog, public;

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
) is 'Server-only atomic login failure recorder. SECURITY DEFINER execution is revoked from PUBLIC, anon, and authenticated.';

insert into public.support_schema_migrations (version, description, checksum, applied_by)
values ('202607170002', 'SUPPER Phase 0.2.1 security foundation corrections', null, current_user)
on conflict (version) do nothing;

commit;
