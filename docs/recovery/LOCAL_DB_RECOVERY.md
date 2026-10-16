# SUPPER Phase 00 — Local Database Recovery

Verified 2026-10-15, Asia/Bangkok.

## Recovery status

**DATABASE_RECOVERY_PASS**, with pre-existing business-data warnings. **APPLICATION_CONNECTION_PENDING**. The recovered database is readable and ready for read-only analysis. No application smoke test has been claimed.

## Environment and storage convention

- Docker Desktop 4.95.0; Docker Engine 29.8.2; Apple Silicon.
- PostgreSQL 17.6, official `supabase/postgres:17.6.1.136` image, digest `sha256:f371b5f3f2ac0a05703f33d6e6134515fb2498cab708fb948a0aeb7481467c00`.
- Active container: `supper-recovery-pg17`, running as Linux `postgres`, UID 100.
- Database: `supper_restore`; host `127.0.0.1`; host port `5433`; container port `5432`.
- Docker networks: internal `supper-recovery-local`, plus dedicated bridge `supper-recovery-access` with `com.docker.network.bridge.enable_ip_masquerade=false`. Docker Desktop did not forward published ports for an exclusively internal network; the dedicated bridge enables the tested localhost port without outbound IP masquerading. No outbound production integration was started; disabled masquerading is not represented as a complete host firewall.
- Persistent bind mount: `/Volumes/Vault/storage/supper/recovery-20261015/data-root` → `/recovery-data`; PGDATA `/recovery-data/pgdata`.
- Actual PostgreSQL files: `/Volumes/Vault/storage/supper/recovery-20261015/data-root/pgdata`.
- Credentials outside Git: `/Volumes/Vault/storage/supper/recovery-20261015/connection.env` and `postgres-password`; password files mode 600; recovery directory mode 700. Do not print or commit these files.
- Docker shared VM disk: `/Volumes/Vault/storage/docker/DockerDesktop/Docker.raw`. The approximately 228 GiB file is sparse; its apparent size is a limit, not allocated usage.
- User convention for future systems: `/Volumes/Vault/storage/{system-name}`. Written to `/Volumes/Vault/storage/README.md`. Docker images/cache use the shared Docker disk; each system's database uses its own directory.

Docker uses a persistent bind mount rather than a named volume to meet the per-system filesystem layout. Vault must stay mounted while Docker/databases run; stop them before disconnecting it.

## Repository inspection

Read applicable AGENTS.md, package.json, README, next.config.ts, .env.example, Supabase initialization, storage routing, authentication, relational SQL scripts and security migrations. Existing package-lock.json modifications were left untouched.

Supabase-backed application modes use @supabase/supabase-js and a server-side service-role key through Supabase APIs, not a direct PostgreSQL driver. The application supports local-json, supabase/app_store and supabase-relational. Login uses bcrypt/jose and application users, rather than Supabase Auth. Login throttling uses support_record_login_failure. RLS and service_role grants matter. Email Intake is documented as a provider-independent domain foundation without polling, sending or scheduling.

The backup uses app_store. Its relational customer/ticket tables are absent, so do not select supabase-relational or run migrations to make them appear. All 15 active application datasets pass the current repository Zod schemas. Supabase Auth and Storage tables are restored, but standalone PostgreSQL supplies none of those API services. Storage SDK usage was not established. No application configuration was changed and the application was not started.

## Backup and original preservation

Original directory: `/Volumes/Vault/atm/supper/99 - archive`.

- `db_cluster-05-10-2026@16-50-44.backup.gz`: **863,452,506 bytes**. Full decompression/CRC validation passed.
- Decompressed SQL: **4,692,104,974 bytes**, SHA-256 equal to the existing `.backup` file. Both original files were only read.
- Format: **plain SQL full-cluster dump**, from PostgreSQL 17.6, pg_dump 17.11. Correct restore tool: psql, not pg_restore. Image psql 17.6 successfully handled restrict/unrestrict commands.
- Explicit database connections in original SQL: template1 and postgres. The template1 section contains session setup only. Both were redirected to supper_restore in the streamed working input.
- Storage ZIP: valid 22-byte empty archive, zero entries; storage metadata also contains zero objects and buckets. No storage files were imported.
- Available disk at inspection: approximately 1.8 TiB on Vault; approximately 52 GiB on host temporary filesystem. No extracted backup was written inside Git.

## Exact restoration procedure and classified errors

Recovery working files and protected logs are under `/Volumes/Vault/storage/supper/recovery-20261015`.

1. Pulled the official image above after inspecting required extensions. Started a fresh empty cluster using initdb with local superuser supper_recovery_admin and a generated password read from a protected file. No existing database/container/volume was reused or overwritten.
2. Created supper_restore from template0. `restore.py` streamed the original gzip through `docker exec -i supper-recovery-pg17 psql -X -U supper_recovery_admin -d supper_restore -v ON_ERROR_STOP=1 -v VERBOSITY=terse`, mapping only the two connection directives.
3. First stop: role membership GRANTED BY supabase_admin was rejected in the new cluster. Roles already existed, but no schemas/data had yet been imported. `restore-resume.py` continued at original SQL line 110, mapping the membership grantor to supper_recovery_admin. All 18 membership grants succeeded. It then stopped because the resumed client lacked the initial restrict state.
4. `restore-resume2.py` resumed at line 128 with the original restrict token. It completed **all 41 COPY blocks** and post-data constraints/indexes, then stopped at line 14585 because ensure_rls could not be owned by the non-superuser postgres role.
5. `restore-finish.py` resumed exactly at line 14585 with the current restrict token and retained ensure_rls under supper_recovery_admin. All seven event triggers were retained. Final stage **exit code 0**. No data statements were skipped or replayed; no business data was changed to pass validation.
6. First restart exposed macOS bind-root ownership remapping. The stopped initial container was preserved as `supper-recovery-pg17-initial`. Moved the existing pgdata directory, without deleting contents, under data-root/pgdata and started the active non-root container with the bind mount above. Restart and subsequent password-authenticated/read-only checks succeeded, retaining all 6,102 app_store rows.

The final container command is reproducible for a new uniquely named container against these existing files, after ensuring no other server is using them:

```sh
docker run -d --name supper-recovery-pg17 --user postgres \
  --network supper-recovery-access -p 127.0.0.1:5433:5432 \
  --mount type=bind,src=/Volumes/Vault/storage/supper/recovery-20261015/data-root,dst=/recovery-data \
  --entrypoint postgres supabase/postgres:17.6.1.136 \
  -D /recovery-data/pgdata -c listen_addresses='*' \
  -c log_statement=none -c log_min_error_statement=panic \
  -c log_error_verbosity=terse \
  -c shared_preload_libraries=pg_stat_statements -c wal_level=logical
```

The active container also has `supper-recovery-local` attached through `docker network connect supper-recovery-local supper-recovery-pg17`. Do not run this while the named container already exists; use docker start instead. Do not restart the preserved initial container: it records the initial setup and its former mount path is no longer the data location. Restore scripts document this completed operation; rerunning them against the recovered database is not a verification method.

Protected restore logs: restore.log, restore-resume.log, restore-resume2.log, restore-finish.log and matching result JSON. Errors above are environmental/client/ownership differences, all addressed. Original owner/grantor metadata differs only as described; business values match their backup. Required extensions are available; no extension was silently discarded.

## Schema and integrity inventory

- **9 schemas**: auth, extensions, graphql, graphql_public, pgbouncer, public, realtime, storage, vault.
- **42 tables**: 41 dump CREATE TABLE objects plus vault.secrets created by its extension.
- **3 public application/security tables**: app_store, support_login_rate_limits, support_schema_migrations.
- 3 views; 0 materialized views.
- **102 functions**, **8 ordinary triggers**, **7 event triggers**.
- **143 indexes**, zero invalid/not-ready indexes. Primary/unique metadata and full column inventory saved in verification.json.
- **29 foreign keys**, all validated, zero orphan rows from explicit anti-join checks.
- **0 explicit RLS policies**. RLS enabled/forced flags are inventoried separately. The app_store design uses service-role access with RLS and no public policy.
- Extensions: pg_stat_statements 1.11, pgcrypto 1.3, plpgsql 1.0, supabase_vault 0.3.1, uuid-ossp 1.1.
- All backup COPY row counts equal actual restored counts. No count mismatch.
- All **15 active application JSON datasets** have identical canonical SHA-256 hashes before/after restoration. This compares values in memory without storing or logging personal records.
- All **15 datasets pass the current repository Zod schemas**. UTF8 encoding verified; Thai and English ticket text decoded successfully. Numeric/decimal values and valid timestamps were preserved, with the existing date anomalies below.

Complete object/column/constraint metadata is in the protected verification.json; no function bodies, passwords, message bodies or personal records are included here.

## Database size and table counts

Database size at verification: **1,521,863,827 bytes (1,451.362 MiB)**.
Total physical table rows: **6,343**, including system migration/security metadata. This is not a count of independent business entities: app_store contains nested JSON arrays and backup snapshots.

Every restored table, sorted by total size descending:

| Schema.table | Exact rows | Table MiB | Index MiB | Total MiB |
| --- | ---: | ---: | ---: | ---: |
| public.app_store | 6,102 | 1,440.539 | 0.648 | 1,441.188 |
| auth.users | 0 | 0.008 | 0.117 | 0.125 |
| auth.scim_users | 0 | 0.008 | 0.078 | 0.086 |
| auth.one_time_tokens | 0 | 0.008 | 0.078 | 0.086 |
| storage.objects | 0 | 0.008 | 0.062 | 0.070 |
| auth.refresh_tokens | 0 | 0.008 | 0.055 | 0.062 |
| auth.mfa_factors | 0 | 0.008 | 0.047 | 0.055 |
| auth.custom_oauth_providers | 0 | 0.008 | 0.047 | 0.055 |
| auth.scim_tokens | 0 | 0.008 | 0.039 | 0.047 |
| auth.oauth_consents | 0 | 0.008 | 0.039 | 0.047 |
| auth.sessions | 0 | 0.008 | 0.039 | 0.047 |
| storage.migrations | 73 | 0.008 | 0.031 | 0.039 |
| public.support_login_rate_limits | 1 | 0.016 | 0.023 | 0.039 |
| auth.identities | 0 | 0.008 | 0.031 | 0.039 |
| auth.flow_state | 0 | 0.008 | 0.031 | 0.039 |
| auth.oauth_authorizations | 0 | 0.008 | 0.031 | 0.039 |
| auth.saml_relay_states | 0 | 0.008 | 0.031 | 0.039 |
| auth.sso_domains | 0 | 0.008 | 0.023 | 0.031 |
| auth.sso_providers | 0 | 0.008 | 0.023 | 0.031 |
| realtime.subscription | 0 | 0.008 | 0.023 | 0.031 |
| auth.webauthn_challenges | 0 | 0.008 | 0.023 | 0.031 |
| auth.saml_providers | 0 | 0.008 | 0.023 | 0.031 |
| public.support_schema_migrations | 4 | 0.016 | 0.016 | 0.031 |
| auth.webauthn_credentials | 0 | 0.008 | 0.023 | 0.031 |
| storage.buckets_analytics | 0 | 0.008 | 0.016 | 0.023 |
| auth.mfa_challenges | 0 | 0.008 | 0.016 | 0.023 |
| auth.audit_log_entries | 0 | 0.008 | 0.016 | 0.023 |
| auth.mfa_recovery_codes | 0 | 0.008 | 0.016 | 0.023 |
| auth.mfa_amr_claims | 0 | 0.008 | 0.016 | 0.023 |
| auth.oauth_clients | 0 | 0.008 | 0.016 | 0.023 |
| auth.schema_migrations | 82 | 0.008 | 0.016 | 0.023 |
| realtime.schema_migrations | 81 | 0.008 | 0.016 | 0.023 |
| storage.vector_indexes | 0 | 0.008 | 0.016 | 0.023 |
| vault.secrets | 0 | 0.008 | 0.016 | 0.023 |
| auth.mfa_recovery_code_sets | 0 | 0.000 | 0.023 | 0.023 |
| auth.oauth_client_states | 0 | 0.008 | 0.016 | 0.023 |
| storage.buckets | 0 | 0.008 | 0.016 | 0.023 |
| storage.s3_multipart_uploads | 0 | 0.008 | 0.016 | 0.023 |
| auth.instances | 0 | 0.008 | 0.008 | 0.016 |
| storage.s3_multipart_uploads_parts | 0 | 0.008 | 0.008 | 0.016 |
| storage.buckets_vectors | 0 | 0.008 | 0.008 | 0.016 |
| realtime.messages | 0 | 0.000 | 0.000 | 0.000 |

The first ten rows above are the top ten largest tables. app_store dominates physical usage. Its key-prefix breakdown below sums stored JSON column bytes, excluding table/index/TOAST overhead, and must not be added to the physical table totals.

| Functional area | app_store rows | Stored JSON MiB |
| --- | ---: | ---: |
| backups | 6,085 | 1,381.215 |
| core | 3 | 3.466 |
| audit | 1 | 0.284 |
| reports | 2 | 0.069 |
| master | 8 | 0.007 |
| imports | 2 | 0.004 |
| auth | 1 | 0.002 |

The 6,085 backup snapshot rows account for most stored JSON bytes. They were retained intact. This is a finding for future analysis, not authorization to delete them.

## SUPPER business records

| Active dataset | Records | Current application schema |
| --- | ---: | --- |
| core/customers.json | 30 | PASS |
| core/tickets.json | 1,328 | PASS |
| core/ticket-history.json | 5,955 | PASS |
| audit/audit-log.json | 3,341 | PASS |
| master/statuses.json | 12 | PASS |
| master/sla.json | 12 | PASS |
| master/holidays.json | 19 | PASS |
| master/teams.json | 19 | PASS |
| master/categories.json | 12 | PASS |
| master/issue-types.json | 3 | PASS |
| master/contract-types.json | 3 | PASS |
| master/priorities.json | 4 | PASS |
| imports/import-batches.json | 5 | PASS |
| reports/report-jobs.json | 5 | PASS |
| auth/users.json | 14 | PASS |

- Customers/contracts: **30** customer records, all with contractType; no duplicate customer IDs or keys. Customer contract periods parse successfully. All expected numeric fields retain JSON numeric types.
- Tickets: **1,328**, no duplicate ticket IDs; all reference an existing customer key.
- Ticket dates: **1978-02-12** through **2026-09-16** among parseable `date` fields. One date is invalid; one parseable date is in 1978 and deserves review. Ticket createdAt/updatedAt values all parse.
- Ticket titles with Thai: **1,163**; with Latin letters: **1,327**. Counts overlap. No personal text was logged.
- Mandays: **844.035782** total ticket mdUsed; **1,136** tickets contain noninteger mandays. Active JSON hashes confirm exact value preservation.
- Assigned owner: **33** tickets have blank/missing owner; **79** distinct nonblank owner strings. Owner strings are not assumed to be user IDs.
- Attachments: **5** nested ticket-log attachment records. Storage ZIP is empty; these are application JSON attachment records, not evidence of external storage files.
- History: **5,955** records, of which **6** match neither a current ticket ID nor issue ID. Kept unchanged.
- One issue ID duplication-or-missing excess was found by count minus distinct count; investigate before treating issueId as unique. No records were edited.

| Ticket kanban status | Count |
| --- | ---: |
| cancelled | 17 |
| closed | 1,109 |
| in_progress | 79 |
| monitor | 3 |
| resolved | 45 |
| waiting | 75 |

No ticket has kanbanStatus open in the actual distribution. Do not equate all non-closed states with open without an agreed business definition.

| Ticket date year | Count |
| --- | ---: |
| 1978 | 1 |
| 2025 | 24 |
| 2026 | 1,302 |

Per-customer ticket count distribution (customer identifiers withheld): 802, 156, 65, 62, 34, 31, 30, 25, 25, 21, 13, 10, 10, 7, 6, 6, 5, 5, 4, 4, 3, 1, 1, 1, 1.

The business anomalies above already exist in the original backup: active source/restored canonical hashes are equal. SQL foreign keys cannot validate references inside JSON; those were checked separately where actual fields support it. SLA, support teams, statuses, permissions/users, imports and report-job records are present as shown. No separate email-intake table or monthly report file recovery is claimed.

## Application connectivity

**APPLICATION_CONNECTION_PENDING**. Restored PostgreSQL is ready, but the application talks to Supabase APIs. A local PostgREST/Supabase API endpoint and matching local JWT/service-role configuration are needed before an application read-only smoke test. Supabase Auth service is not required by the inspected custom login implementation. Any additional Storage/report-file requirements need separate verification. Use a dedicated ignored environment file and the supabase/app_store backend; never reuse the production URL or keys. Keep email/IMAP/SMTP, external automation and jobs disabled. No architecture rewrite or authentication bypass was made.

## Start, stop and reconnect

Docker CLI is available via /opt/homebrew/bin/docker. Docker Desktop is /Applications/Docker.app.

```sh
# Vault must be mounted first.
open -a /Applications/Docker.app
docker start supper-recovery-pg17
docker exec supper-recovery-pg17 pg_isready -U supper_recovery_admin -d supper_restore

# Read-only inspection session. Keep writes out of this verification session.
docker exec -it -e PGOPTIONS='-c default_transaction_read_only=on' \
  supper-recovery-pg17 psql -X -U supper_recovery_admin -d supper_restore

# Stop database; then stop Docker before disconnecting Vault.
docker stop supper-recovery-pg17
docker desktop stop
```

Host database tools should use 127.0.0.1:5433, supper_restore, supper_recovery_admin and the protected password file; never copy credentials into docs or Git. Published localhost TCP endpoint was tested from macOS with the PostgreSQL protocol; password authentication was separately tested through PostgreSQL TCP inside the container. The container restart test retained 6,102 app_store rows.

## Verify again

Run from the source repository with Docker running:

```sh
python3 scripts/verify-local-recovery.py
```

The script asserts localhost-only port binding and the SUPPER storage prefix, opens only READ ONLY transactions, and prints catalog metadata, exact table counts, sizes, constraints and aggregate dataset metadata. It does not mutate records. Its identifier quoting self-check and actual database execution passed. Protected results from this run are in logs/verification.json and verification-summary.json. Additional one-time aggregate SQL is retained in logs/business-verification.sql; schema validation and source-hash comparison results are saved separately. The original source files remain outside Git.

## Safety and next phase readiness

- Production Supabase was never connected to, modified or reset. No production environment or Vercel settings changed.
- Original downloaded backups remain intact; no data, credentials or recovery payloads were pushed to GitHub.
- No records were deleted, cleaned, archived or migrated. Only local infrastructure, permissions/ownership compatibility and documentation were changed.
- Database is ready for analysis. Archival implementation is **not ready to begin safely** until a separate design reviews the JSON storage model, backup snapshots, history references and date/issue-ID anomalies. No archival code was implemented.
- Full local website use remains pending API setup and actual application smoke testing.
