# Production operations safety

Production: `gpzmmxckiywkdqxqlkct`, relational backend. Local-only tools; no application runtime or Vercel configuration changes. No automatic pruning. This Owner policy replaces the earlier proposed daily capture cadence with a weekly scheduled capture plus manual pre-risk captures.

## Installed schedules

Native LaunchAgents for user `nosanni`, Mac timezone **Asia/Bangkok**:

- `com.supper.ops.backup`: Sunday **02:30** (Sunday early morning).
- `com.supper.ops.capacity`: daily **03:00**.

Requires the Mac to be running with this user logged in. launchd calendar jobs missed during sleep run on wake; powered-off/logged-out execution is not guaranteed. No terminal needs to stay open. Keep the Mac timezone at Asia/Bangkok; `TZ` alone does not change launchd calendar scheduling.

Sources: `scripts/ops/`. Installed supervisor/dependencies/config/state/logs: `/Users/nosanni/Library/Application Support/SUPPER/ops`. These small operational files remain on the internal disk deliberately, so an unavailable Vault can still produce a failure log and email. **No snapshot payload is saved there.** Secrets are private `production.env` (0600); directory 0700. No credentials belong in Git.

Jobs: `/Users/nosanni/Library/LaunchAgents/com.supper.ops.{backup,capacity}.plist`.

## Capture and on-demand operation

```sh
/usr/local/bin/node '/Users/nosanni/Library/Application Support/SUPPER/ops/run.mjs' backup
```

Run before bulk import, restore, major migration or major data transformation. Operator must complete and verify capture before starting the risky operation; this does not add application-side enforcement.

Supervisor checks the real external mount, canonical root and existing archive structure before connecting for backup. Vault worker repeats the existing VaultAuthority guards. Missing Vault explicitly fails before capture; no recursive mountpoint creation or payload fallback exists. Controlled test:

```sh
/usr/local/bin/node '/Users/nosanni/Library/Application Support/SUPPER/ops/run.mjs' simulate-vault-unavailable
```

Capture uses one **REPEATABLE READ READ ONLY** PostgreSQL transaction, all columns of 30 required business tables plus `app_store`, and the applied migration versions. No REST pagination truncation. Unknown migration/table-coverage changes fail pending review; managed schemas, transient rate limits and migration ledger rows are excluded. Auxiliary app_store is currently captured in full because Production retains recovered migration source records there.

The in-memory payload is passed to the existing VaultAuthority/LocalFilesystemSnapshotStore. Destination: `/Volumes/Vault/storage/supper/snapshot-archives/local-vault`. Immutable manual-category snapshots, checksum/gzip read verification and an immutable `production-business-<UUID>` catalog pin protect each capture. No pruning command is called. It checks the existing frozen manifest as part of the normal store contract; it does not requalify historical objects.

Restore: use the recorded `backupPath` with existing `scripts/vault-snapshots.mjs verify` / `export`, then restore exported `tables` into a safe isolated target with the recorded base schema/migrations. Do not restore directly into live Production without separate authorization. Retain known legacy orphan history rows; capture does not change business semantics.

## Capacity and email

```sh
/usr/local/bin/node '/Users/nosanni/Library/Application Support/SUPPER/ops/run.mjs' monitor
/usr/local/bin/node '/Users/nosanni/Library/Application Support/SUPPER/ops/run.mjs' notify-test
```

Actual SQL: `pg_database_size(current_database())`. Decimal MB: 1 MB = 1,000,000 bytes. Configurable `CAPACITY_MB=500`, `WARNING_PERCENT=80`; warning begins at **400,000,000 bytes**. Daily monitor can run without Vault; its PostgreSQL driver, TLS CA and config are internal. Exact Production project identity is enforced. TLS certificate verification remains enabled using the public Supabase CA linked by the authenticated Production dashboard (`prod-ca-2021.crt`, expires April 26, 2031).

Recipient is fixed to `thanapong.tong-u-thai@iamconsulting.co.th`. Configure only in private local `production.env`:

- `SMTP_HOST`: approved outbound SMTP relay.
- `SMTP_PORT=587`: STARTTLS submission port.
- `SMTP_USERNAME`, `SMTP_PASSWORD`: relay credentials/app password.
- `SMTP_FROM`: sender address authorized by that relay.

SMTP uses mandatory STARTTLS, verified certificates and authenticated submission. No usable existing outbound email was found: macOS Postfix has no configured relay/auth, and SUPPER has no outbound email adapter. No password should be sent in chat. After configuration, run notification test and confirm receipt. SMTP acceptance alone does not prove inbox delivery.

`capacity-state.json` stores only the warning latch. 79 → 81 → 83 → 78 → 82% yields alerts only at 81 and 82. Failed sends do not set the latch, so next daily check retries. Dropping below threshold re-arms. State corruption fails explicitly rather than spamming. `running.lock` prevents overlapping capture/monitor operations. If a process is killed and leaves the lock, confirm no job is running and inspect logs before manually removing that lock; do not remove snapshot objects.

## Evidence and limitations

2026-10-16 manual installed backup PASS: **31 datasets**, existing Vault store write/read/hash verification and catalog pin. Snapshot: `backups/recovery/business-state-1792142177720-d33e8104-ba24-4d0d-9b5e-e902964c8616.json`; checksum `40d635908ef97cdcb52e1643c0e6b968308c80b37d74edf74cad0aeb1fbc82d7`.

Compressed size **5,149,000 bytes (5.15 MB)**, raw **17,200,578 bytes**. At unchanged size, 52 snapshots ≈ **267.75 MB/year**; measured current size, estimated future growth. Existing duplicate migration source JSON contributes to payload size; no cleanup was performed.

Actual monitor: **33,978,035 bytes / 500,000,000 = 6.795607%**, HEALTHY. Synthetic threshold/re-arm tests: 2 PASS. Vault-unavailable simulation: explicit FAIL; notification attempt logged, no capture/SQL initiated. **Email currently blocked: EMAIL_NOT_CONFIGURED.** Scheduled jobs are installed; email is not operational until SMTP is configured and tested.

Concise local audit: `operations.jsonl`, `launchd-backup.{out,err}.log`, `launchd-capacity.{out,err}.log`. Snapshot identifiers, hashes, dataset counts and capacity metrics only; no payloads/secrets. Logs and the latch are small operational metadata, not a backup fallback. Do not invoke scripts with shell tracing.

No Production business writes, staging changes, deployment, historical archive modification, pruning or ServiceNow write activation. Monthly Report Factory upload/PDF remains deferred. Owner authorized commit/push of this local operations implementation. Email setup is explicitly deferred by Owner; backup/monitor schedules remain installed, but email delivery is not operational.
