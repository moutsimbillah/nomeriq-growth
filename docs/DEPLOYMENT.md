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

You should see all migrations applied. Migration `002_supabase_security.sql` enables RLS and revokes `anon`/`authenticated` access when those Supabase roles exist, and `003`/`004` extend that parity to the research-engine tables. Growth never uses the Supabase Data API.

Confirm in Supabase that the `public` schema tables exist and that the Data API is not needed. If the project exposes the Data API by default, keep the RLS/revoke migration in place or disable API exposure for the schema.

Verify the engine tables and the research status constraint before going live:

```sql
select id from _migrations order by id;
select conname from pg_constraint where conname = 'research_jobs_status_check';
select column_name from information_schema.columns
  where table_name = 'research_candidates' and column_name in ('identity_key', 'prospect_id', 'draft_id');
select indexname from pg_indexes where tablename = 'prospect_emails';
-- Spend must be stored at the same scale as the usage rows it sums, or the
-- budget gate drifts. Both must report 6.
select table_name, numeric_scale from information_schema.columns
  where (table_name = 'research_jobs' and column_name = 'spent_usd')
     or (table_name = 'research_usage' and column_name = 'cost_usd');
```

The index query must show `prospect_emails_business_email_unique` and must **not** show a global unique index on `normalized_email`. That partial index is what stops two unrelated businesses with a shared `info@` inbox from colliding.

Migration `005_spend_precision.sql` widens `spent_usd`/`budget_usd` to six decimals and repairs any drift already recorded by re-deriving it from the real usage rows. It is additive and safe to re-run.

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
| `CRON_SECRET` | Random secret used by the cron routes |
| `EMAIL_DELIVERY_MODE` | `sandbox` for the first deploy |
| `AI_PROVIDER` | `none`, `openai` or `anthropic` |
| `OPENAI_API_KEY` | Optional |
| `ANTHROPIC_API_KEY` | Optional |
| `DEEPSEEK_API_KEY` | Optional; required for the autonomous research engine |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` |
| `DEEPSEEK_MODEL` | `deepseek-flash` |
| `RESEARCH_WORKER_MAX_JOBS` | `3` — due jobs advanced per cron invocation |
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

## 5b. Autonomous DeepSeek research engine

`vercel.json` also schedules the research worker:

```
POST /api/cron/research   every 5 minutes
Authorization: Bearer $CRON_SECRET
```

This is the process that makes research durable and independent of any browser or chat session. One invocation:

1. Fails closed if `CRON_SECRET` is unset or the database is unreachable.
2. Marks runs from crashed workers as interrupted so they do not look active.
3. Advances at most `RESEARCH_WORKER_MAX_JOBS` due `deepseek` jobs by one bounded tick each.

It **only researches**. The response body states that no email was sent, and there is no send path reachable from this route.

Set the key one of two ways:

- **Recommended for production:** `DEEPSEEK_API_KEY` in Vercel. The key stays server-side and is never returned to the browser.
- **Runtime:** save it under **Settings → DeepSeek**, where it is encrypted with `APP_ENCRYPTION_KEY` and overrides the environment value. Use **Test connection** to verify the base URL and model.

Then, in Growth:

1. **Settings → Workspace** — set the default research budget, concurrency and the DeepSeek Search/Fetch QPS limits to match your plan's quota.
2. **Research → New research target** — choose the **DeepSeek engine**, set the target count and a budget you are willing to spend. The target is created **paused**.
3. Press **Start**. The engine will spend only against the recorded budget and will pause with `budget_paused` rather than overrun it.

### Cost and behaviour to expect

- DeepSeek Search and Fetch are billed per **successful** request; chat is billed per token. Every operation is written to `research_usage` and the UI's spend figure is the sum of those rows.
- Job spend is stored at full six-decimal precision, so the budget gate compares against the founder's limit exactly rather than drifting by accumulated rounding. If you are upgrading a database that ran before `005_spend_precision.sql`, that migration also repairs the recorded totals.
- Verifications that fail are retried at most `MAX_CANDIDATE_ATTEMPTS` times, then recorded as failed. They never become leads.
- A candidate claim lasts 15 minutes and then expires, so a worker that dies mid-candidate never blocks that business permanently.
- Budget exhaustion pauses and preserves progress. Resuming after a top-up continues from the persisted candidate queue — it never restarts a finished job or recounts existing leads.
- Vercel function duration is capped at 300s for this route. If a deployment's plan allows less, the worker still makes progress: each tick is bounded and the next invocation continues.

### Verifying the engine without spending money

`scripts/e2e-engine.mjs` starts the built app plus a local DeepSeek HTTP stub and drives the whole path through the real provider adapter:

```bash
npm run build
node scripts/e2e-engine.mjs
```

It asserts lead creation, draft creation, itemized usage, cron authorization and that no email was sent. It never contacts `api.deepseek.com`.

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
- Confirm `/dashboard`, `/leads`, `/email`, `/product-truth`, `/research` and `/settings` load with no 500s.
- **Settings → DeepSeek**: confirm the key status reads configured, run **Test connection**, and confirm the key itself is never displayed.
- Trigger the research cron by hand with the wrong secret and confirm `401`; with the right secret and confirm `200` plus `note: "Research only. No email was sent."`.
- Create a small DeepSeek target with a deliberately tiny budget, start it, and confirm the UI shows real spend, real candidate counters and a truthful **Why it stopped** line. Confirm a completed target does not restart from zero.
- Create a sandbox mailbox if no IONOS account is connected yet.
- Send one sandbox draft and simulate one reply. Confirm follow-ups cancel and the reply thread is preserved.
- Test one real email to your own business address before contacting prospects.
- Verify the unsubscribe link using a test suppression token.
- Disable sandbox mode only after the sender identity, postal address, footer and account health are correct.

## Cost shape

The intended production setup is one Vercel project, one small Supabase database, two cron entries (daily follow-ups at 07:00 UTC and the research worker every 5 minutes), and IONOS mail. No containers, queues, separate workers, Redis or paid enrichment API are required. DeepSeek usage is pay-per-call and hard-capped by each target's recorded budget.
