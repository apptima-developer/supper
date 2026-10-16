# Integrated staging recovery checkpoint

2026-10-16. **Historical checkpoint before Owner sign-in**: canonical staging URL is protected by Vercel SSO. Ordinary GETs of `/api/health/live` and `/login` return 302 to `vercel.com/sso-api`; the available in-app browser reaches the Vercel login screen. Per the Owner's instruction to stop when human authentication is required, no authentication bypass, commit, push or deployment was performed. The login tab is left available for Owner sign-in. This checkpoint does not claim deployed smoke success.

## Preservation and integration

Original worktree remains unchanged on main at `5b6f68ac28b9604f9d44b982397e77072aa2ba4a`, including local account-hash changes and unrelated lockfile edits. Private, unpublished preservation patch/source copies/inventory: `/private/tmp/supper-recovery-preserve-gj6lw17s` (directory 0700/files 0600). Preservation excluded local account hashes, ignored env/secrets, original backups, archives and temporary data.

Separate integration worktree: `/Volumes/Vault/atm/supper/.integration/supper-ai-development`; branch `ai_development`, base `646caccc0c7b34de32ff6e0987f09be9a0338cb4`. All 33 existing staging commits preserved; no merge of older main, rebase, reset or history rewrite. Approved tracked patch applied three-way, approved new source/docs copied, and AWS SDK lock additions merged while preserving unrelated baseline `libc` metadata removed by the old local lock churn.

Conflicts: `.env.example` retained newer bootstrap/ServiceNow disabled-default settings and appended historical recovery settings; `domain.test.ts` had semantically identical required fixture fields in a different order, so the newer fixture was retained. The newer integration runtime, schemas, migrations and tests were not replaced. Other equivalent type-fixture fixes already existed on the new branch and introduce no new diff.

## Updated capture/restore coverage

The old ten-table capture was insufficient on this branch. Source inspection found twenty additional currently applied SUPPER tables required for persistent links, synchronization cursors/results, customer mappings/events, channels/identities/binding history, conversations/messages/attachment metadata, sessions, events/deliveries, ticket links and outbox intent. The staging-only command now derives table inventory from repository SQL **and actual applied staging migration versions**, excluding only the migration ledger and transient login-rate-limit state. It fails on unknown schema versions or incomplete table reads.

Actual integrated validation captured **30 SUPPER business tables + auxiliary app_store = 31 datasets**, including nonempty ServiceNow/Intake records. Verified Vault manual bundle/export, reconstructed all applied business DDL/11 migrations in a fresh isolated local DB, restored all columns, compared every row and checked **31 foreign keys**, ticket/customer/history joins and effective user auth versions. Restore temporarily suppressed local triggers only to avoid re-emitting copied delivery/event ledgers; explicit foreign-key checks followed. No staging schema/data or protected recovery DB was modified. Artifact/hash/count detail: `STAGING_BUSINESS_CAPTURE_EVIDENCE.json`.

`202607230001_servicenow_write_kernel.sql` is present in the branch but **not applied** on staging; its nine tables are absent. This migration explicitly describes itself as unapplied. No migration was applied to staging and no provider write was enabled. Those absent, disabled feature tables contain no staging business rows to capture; deploying this branch does not certify or enable ServiceNow write functionality. Capture rejects an enabled write flag while that migration is pending. A separately approved write-feature rollout must address its schema/configuration.

The reference endpoint in local config remains only the previously approved staging identity anchor; it is never called as object storage. Capture is GET-only from `supper-staging`. Vault remains local only. Approved RPO is 24 hours, additional capture before bulk import/restore; Owner/local maintenance process is responsible. Automation deferred. Real-data prune execution on the canonical root is hard-blocked, and all 6,085 authoritative historical snapshots remain unchanged.

## Integrated gates

- Exact optimized build `npm run build -- --webpack`: exit 0, using staging credentials, the Owner-confirmed canonical APP_ORIGIN, NODE_ENV production and Vercel Preview identity; includes newer integration routes.
- Full suite: **620 passed / 16 skipped / 0 failed** (67 passed suites / 6 skipped).
- Full TypeScript after Next route-type generation: exit 0. Initial typecheck before generation lacked the newer `RouteContext` global; no obsolete route rewrites were made.
- Full lint, architecture, 12-file migration inventory, runtime asset inventory, diff checks: pass.
- All three synthetic SQL acceptance suites (ServiceNow sync, ServiceNow write kernel, Intake): pass using a dedicated network-isolated PostgreSQL tool container. Host `initdb` was absent; container tooling resolved the environment limitation without altering existing validators, source SQL, staging or recovery DBs.
- Mounted Vault integration: **1 passed**, verifies all 6,085 historical object/hash/metadata entries, synthetic write/immutable conflict/restart/catalog protection/dry-run and isolated synthetic prune; no historical deletion.
- `npm ci --dry-run --ignore-scripts --offline`: exit 0; merged dependency lock accepted.
- Secret scan: no actual staging credentials, local env/account changes, recovery archives, payload exports, temporary fixtures or files >1 MiB in proposed integration set. Sanitized evidence summaries contain counts/hashes/paths only. Local env link is ignored/untracked.
- Next server artifacts contain no canonical `/Volumes/Vault/storage/supper` path. Local maintenance module is not a Vercel entry point; `SUPPER_EXTERNAL_SNAPSHOTS=0` remains mandatory.

## Build configuration

`vercel.json` encodes a branch-specific command: `ai_development` runs the verified webpack build; other branches retain `npm run build`. A dispatch test invokes a harmless stub npm and verifies both branches. No package build-script behavior or production branch was changed. Vercel documents `buildCommand` as overriding the dashboard setting: https://vercel.com/docs/project-configuration/vercel-json . No manual Build Command change is required for this tree.

## Owner action and remaining deployment

In the open Codex in-app browser tab, **sign in to Vercel with an account authorized for team apptima/project supper**, then return to `https://supper-git-aidevelopment-apptima.vercel.app` and confirm access. Do not send passwords, OTPs, cookies or tokens in chat. No instruction to disable Vercel protection is given.

After ordinary authorized browser access is available, recheck this remaining gate, review the exact file manifest, create the one clean approved integration commit, fetch/check non-force ancestry and push only to `ai_development`. Verify Vercel's new commit status and canonical alias, then perform ordinary application login/core navigation/ticket read and one harmless staging ticket update/readback/revert. Do not treat baseline deployment success as proof for the new tree.

Monthly Report Factory filesystem/PDF limitations remain deferred: code inspection shows they do not prevent core dashboard/ticket/customer navigation, but deployed behavior has not been checked behind SSO. No redesign performed. No Production mutation, push/promotion or real-data prune.

The original worktree remains dirty/preserved. The integration worktree has approved staged/unstaged/new source and documentation pending commit; exact candidate paths are in `APPROVED_INTEGRATION_FILES.json`. No commit SHA exists yet for this integration.

## Owner sign-in resumed

Owner confirmed Vercel sign-in and the browser now reaches the SUPPER application login at the canonical staging URL through ordinary authorized access. Final local gates were repeated successfully (620 tests, TypeScript, lint and production build). Commit/push is now authorized; this document records pre-deployment evidence, while the resulting commit/deployment and actual smoke outcomes are reported separately. No security protection was disabled or bypassed.
