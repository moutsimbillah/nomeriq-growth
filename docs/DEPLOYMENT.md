# Deploy Nomeriq Growth

This is the short, production-focused runbook for **leads.nomeriq.com**.

## 1. Create the independent database

Create a new Supabase project dedicated only to Growth.

- Do not reuse the main Nomeriq database.
- Do not put Growth tables in the main Nomeriq project.
- Copy the PostgreSQL connection string. The pooled connection string is suitable for Vercel, for example:
  `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres?sslmode=require`
- Keep the database password in a secret manager. Growth connects server-side only.

Apply the schema from this checkout before deploying:

```bash
# .env.local or an inline environment
DATABASE_URL="postgresql://..." AUTO_MIGRATE=true npm run db:migrate
```

You should see both migrations applied. Migration `002_supabase_security.sql` enables RLS and revokes `anon`/`authenticated` access when those Supabase roles exist. Growth never uses the Supabase Data API.

Confirm in Supabase that the `public` schema tables exist and that the Data API is not needed. If the project exposes the Data API by default, keep the RLS/revoke migration in place or disable API exposure for the schema.

## 2. Configure Vercel

Import this repository as a new Vercel project. Node.js 22+ runtime.

Set these environment variables in Production (and Preview if desired):

| Variable | Value |
| --- | --- |
| `APP_URL` | `https://leads.nomeriq.com` |
| `DATABASE_URL` | Supabase PostgreSQL connection string |
| `DATABASE_POOL_MAX` | `5` |
| `SESSION_SECRET` | 48+ random bytes, base64 |
| `APP_ENCRYPTION_KEY` | Exactly 32 random bytes, base64 |
| `CRON_SECRET` | Random secret used by the optional cron |
| `EMAIL_DELIVERY_MODE` | `sandbox` for the first deploy |
| `AI_PROVIDER` | `none`, `openai` or `anthropic` |
| `OPENAI_API_KEY` | Optional |
| `ANTHROPIC_API_KEY` | Optional |
| `AUTO_MIGRATE` | `false` |

Do **not** use the local PGlite database in production. Vercel's filesystem is not a durable database. Growth intentionally fails with an actionable message if production starts without `DATABASE_URL`.

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

`APP_ENCRYPTION_KEY` must never change after mailbox credentials are stored. If it is lost, the encrypted SMTP/IMAP passwords cannot be recovered and must be re-entered.

## 3. Domain and first login

1. Add `leads.nomeriq.com` in Vercel → Domains and follow the DNS instructions.
2. Open the deployed URL.
3. If the database is empty, `/setup` creates the first founder account. If you imported a backup, use that account instead.
4. Change the seeded/local password before any live use.
5. Add your registered business postal address, signature and footer under **Settings → Sending identity**.

## 4. Connect IONOS

1. **Settings → Email accounts → Add mailbox → IONOS**
2. Use the full mailbox address, mailbox/app password, `smtp.ionos.com:587` (STARTTLS) and `imap.ionos.com:993` (TLS).
3. Save. Growth verifies SMTP and IMAP once and records the exact failure if either fails.
4. Keep the app's configured safety cap conservative. These are app limits; they are not claims about IONOS's provider ceilings.
5. Send a sandbox test first.
6. When ready, change `EMAIL_DELIVERY_MODE` to `live` in Vercel and redeploy.
7. Make the IONOS mailbox the default.

The first IMAP run imports up to 40 recent messages per folder over the last 30 days and marks the mailbox history as partial. The UI will show that warning. Later syncs advance by UID and detect UIDVALIDITY changes. Emails sent directly in IONOS are captured from the Sent folder and associated to the prospect by exact email/thread headers.

## 5. Optional daily follow-up preparation

`vercel.json` schedules:

```
GET /api/cron/follow-ups   daily at 07:00 UTC
Authorization: Bearer $CRON_SECRET
```

The route prepares follow-up **drafts only**. It never sends. Remove the cron from `vercel.json` if you prefer manual preparation. Vercel Hobby plans may have restrictions on cron frequency; run it manually or from another scheduler if needed.

## 6. Assistant access

In **Settings → AI integrations**, create one key for ChatGPT and one for Claude.

- MCP URL: `https://leads.nomeriq.com/api/mcp`
- REST: `https://leads.nomeriq.com/api/agent/v1`
- OpenAPI for ChatGPT Actions: `https://leads.nomeriq.com/api/agent/openapi`
- Shared skill: `get_instructions` tool / Settings download

The keys do not have a send permission because no send permission exists. Keep them in the assistants' secure credential storage, not in prompts or documents.

## 7. Backups and retention

- Supabase point-in-time recovery / scheduled backups are the primary recovery mechanism. Enable them according to the plan.
- Growth also exposes an authenticated JSON export at `/api/backup`. It excludes password hashes, sessions, API-key hashes and encrypted mailbox credentials.
- Archiving a prospect adds the contact to the suppression list, cancels active drafts and keeps historical messages for audit.
- Retain only what the business needs. Remove stale data through the archive control and a documented retention policy.

## 8. Production verification

After deployment:

- `/api/health` returns `ok: true` and `database: reachable`.
- Sign in and confirm the session cookie is `HttpOnly`, `Secure` and `SameSite=Lax`.
- Confirm `/dashboard`, `/leads`, `/email`, `/product-truth` and `/settings` load with no 500s.
- Create a sandbox mailbox if no IONOS account is connected yet.
- Send one sandbox draft and simulate one reply. Confirm follow-ups cancel and the reply thread is preserved.
- Test one real email to your own business address before contacting prospects.
- Verify the unsubscribe link using a test suppression token.
- Disable sandbox mode only after the sender identity, postal address, footer and account health are correct.

## Cost shape

The intended production setup is one Vercel project, one small Supabase database, one optional daily cron, and IONOS mail. No containers, queues, separate workers or paid enrichment API are required. AI usage is optional and pay-per-call.
