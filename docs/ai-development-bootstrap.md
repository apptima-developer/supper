# AI-development administrator bootstrap

## Purpose

`npm run ai:bootstrap-admin` creates or refreshes one administrator in the isolated `supper-ai-dev` Supabase project. It exists only because a clean AI-development database has no SUPPER user from which to create another account.

The requested `admin123` password is deliberately weaker than SUPPER's normal 12-character account password policy. The exception exists only inside this manually executed, environment-guarded script. Normal account create and edit routes retain the production password policy.

The script is not imported by Next.js, a route, build hook, deployment hook, startup hook, or scheduler.

## Required guard

The command refuses to write unless every condition is true:

- `APP_ENV=ai-development`
- `ALLOW_INSECURE_DEV_BOOTSTRAP=true`
- `DATA_BACKEND=supabase-relational`
- `VERCEL_ENV` is not `production`
- `NEXT_PUBLIC_SUPABASE_URL` is a credential-free Supabase HTTPS project origin
- its parsed project ref exactly equals `DEV_BOOTSTRAP_TARGET_PROJECT_REF`
- the ref is not the known production ref, `PRODUCTION_SUPABASE_PROJECT_REF`, or an inferred production target
- the username is exactly `admin`
- all administrator values and the server-only Supabase service role key are present

Do not rely on `NODE_ENV`; Vercel Preview builds can run with production-mode compilation.

## Local execution

Add these values only to ignored `.env.local`, after confirming it points to `supper-ai-dev`:

```dotenv
APP_ENV=ai-development
ALLOW_INSECURE_DEV_BOOTSTRAP=true
DATA_BACKEND=supabase-relational
DEV_BOOTSTRAP_TARGET_PROJECT_REF=your-ai-dev-project-ref
DEV_BOOTSTRAP_ADMIN_USERNAME=admin
DEV_BOOTSTRAP_ADMIN_PASSWORD=admin123
DEV_BOOTSTRAP_ADMIN_EMAIL=admin@supper-ai-dev.test
NEXT_PUBLIC_SUPABASE_URL=https://your-ai-dev-project-ref.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-ai-dev-service-role-key
```

Then run:

```bash
npm run ai:bootstrap-admin
```

The command logs only project ref, action, username, and role. It never prints the password, hash, service key, environment, authorization header, or database row containing the hash.

## Idempotency and rotation

The first run inserts exactly one `support_users` row. A rerun preserves the existing ID, replaces the password hash/name/email/role/active fields, and increments `authVersion` to invalidate old sessions. It checks email ownership and never deletes another user, truncates a table, or seeds business data.

To rotate the development password, change the ignored password value and rerun. After the initial access is no longer needed, set `ALLOW_INSECURE_DEV_BOOTSTRAP=false` and rotate the account through the admin UI to a policy-compliant password. Disable or remove the development account through the normal account administration flow when the environment is retired.

Never run `supabase:seed` or a migration command as part of this bootstrap.
