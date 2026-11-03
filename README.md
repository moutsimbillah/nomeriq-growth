# Nomeriq Growth

An independent, founder-controlled B2B sales portal for Nomeriq. It exists to run one loop exceptionally well:

**Find commercial trading-signal providers → verify the signal business and public email → reject duplicates → save evidence → write a personalized first email → founder review → send → receive and thread replies → respond or follow up → track the outcome → repeat.**

This is a standalone application with its own Git repository, database, authentication, encrypted mailbox credentials and deployment. It has no dependency on the main Nomeriq application, production database, AWS workers or auth system. If Nomeriq is offline, Growth is unaffected.

![Dashboard](artifacts/screenshots/02-dashboard.png)

## What is working

- **Dashboard** with live lead, draft, reply, opportunity and mailbox counts.
- **Research targets** persisted in PostgreSQL, with database-derived progress and a resumable brief for ChatGPT or Claude.
- **Global deduplication** on domain, business name/aliases, contact email, Instagram, YouTube, X and Telegram. Unique indexes enforce identity even if an assistant skips the pre-check.
- **Evidence-first leads**: a verified lead cannot be saved without an official website, a published contact email, the exact email source URL and at least one public evidence source.
- **Product Truth** controlled by the founder, with claim warnings on AI drafts and a deliberate no-ceremony path for founder-written replies.
- **Personalized first-contact drafts** from OpenAI/Anthropic when configured, or a deterministic founder-style writer without an API key. Drafts are always saved for review.
- **Email delivery** through IONOS SMTP (or another SMTP/IMAP provider) with encrypted credentials, rate caps, idempotency, opt-out footers and an explicit sandbox mode.
- **IMAP synchronization** for Inbox and Sent, thread association by headers/exact email, external sent-mail capture, unmatched inbound visibility and mailbox-history warnings.
- **Simple reply workflow**: open thread → read → write or generate a suggestion → send. No extra internal approval step for a personally reviewed reply.
- **Follow-ups** prepared from unanswered threads, stopped by replies, opt-outs and suppression, and never sent automatically.
- **Campaigns** from approved first-contact drafts, with explicit founder authorization, progress, pause/resume and duplicate-send prevention.
- **ChatGPT + Claude integration** through a shared, scoped MCP endpoint and an equivalent REST/OpenAPI API. Research keys have no send permission.
- **Suppression**, archive controls, JSON backup export, audit logging, security headers, CSRF/origin checks and encrypted credentials.

## Local workspace

The app runs at **http://localhost:3100**.

The bundled `.env.local` contains a local founder seed:

```
founder@nomeriq.com
Founder!Nomeriq2026
```

**Change this password before any real deployment.** It exists only to make the local slice immediately inspectable.

The local database is seeded with two genuinely researched, publicly verified providers:

| Lead | Markets | Public email | Evidence |
| --- | --- | --- | --- |
| [FXPremiere](https://www.fxpremiere.com/) | Forex, gold/metals, crypto, indices | `daniel@fxpremiere.com` | [Official terms/contact footer](https://www.fxpremiere.com/terms-of-service/), [paid plans](https://www.fxpremiere.com/) |
| [P4 Provider](https://p4provider.com/) | Forex, crypto | `contact@p4provider.com` | [Official pricing](https://p4provider.com/pricing), [contact page](https://p4provider.com/contact) |

Both were observed on 3 November 2026. Their paid signal services and public emails are recorded with source URLs. No email was sent to either business. A duplicate FXPremiere attempt is recorded as rejected, proving the database-backed duplicate path.

The research target is **2 / 100** because the system does not fabricate the other 98 providers. ChatGPT and Claude can continue that same target through MCP without restarting discovery.

The checked-in local database also contains a clearly labelled **sandbox** thread and campaign created during verification. Sandbox messages never leave Growth.

## Stack

- Next.js 15.5, React 19, TypeScript, Tailwind CSS 4
- PostgreSQL in production (Supabase compatible)
- Embedded PGlite PostgreSQL for local development — no Docker
- Custom Growth-only auth: scrypt password hashing, opaque HttpOnly session cookies
- Nodemailer + ImapFlow + mailparser for SMTP/IMAP
- AES-256-GCM for mailbox credentials at rest
- Vercel-compatible routes; one optional daily cron for follow-up **draft preparation**
- No Docker, Kubernetes, queue cluster, Redis, separate worker service or enterprise CRM

## Run locally

Requirements: Node.js 22+ and npm.

```bash
npm install
cp .env.example .env.local
# Fill in SESSION_SECRET, APP_ENCRYPTION_KEY and ADMIN_PASSWORD.
# Generate secrets with:
node -e "const c=require('crypto'); console.log(c.randomBytes(48).toString('base64'))"
node -e "const c=require('crypto'); console.log(c.randomBytes(32).toString('base64'))"
npm run db:seed
npm run dev
```

`db:seed` creates the local PGlite database, migrates it, creates the founder account and seeds the two verified providers and drafts. It is idempotent where identity permits.

Useful commands:

```bash
npm run db:migrate      # Apply migrations to DATABASE_URL or local PGlite
npm run db:reset-local  # Remove ONLY the local PGlite database
npm run db:seed         # Seed founder + verified vertical slice
npm run typecheck
npm test
npm run build
```

## IONOS setup

1. Go to **Settings → Email accounts → Add mailbox**.
2. Choose **IONOS**. Defaults are `smtp.ionos.com:587` with STARTTLS and `imap.ionos.com:993` with TLS.
3. Use the full mailbox address and mailbox/app password. Growth encrypts it with `APP_ENCRYPTION_KEY`.
4. Save. Growth tests SMTP and IMAP and shows the precise failure if either is unhealthy.
5. Set the registered postal address and truthful sender identity under **Settings → Sending identity**.
6. Keep `EMAIL_DELIVERY_MODE=sandbox` until the sender, footer and legal details are correct.
7. Test with the sandbox first. When ready, set `EMAIL_DELIVERY_MODE=live`, restart/redeploy, and make the IONOS account the default.

The app's visible daily cap and minimum interval are **app-configured safety limits**, not claims about IONOS limits. SMTP acceptance is recorded as accepted, never as guaranteed inbox delivery.

Initial IMAP sync covers the last 30 days and imports at most 40 messages per folder per run. The UI warns while mailbox history is incomplete. Subsequent runs continue forward from the last UID and UIDVALIDITY is tracked.

## ChatGPT and Claude

Create separate keys in **Settings → AI integrations**.

- **MCP endpoint:** `https://leads.nomeriq.com/api/mcp`
- **REST base:** `https://leads.nomeriq.com/api/agent/v1`
- **OpenAPI schema for ChatGPT Actions:** `https://leads.nomeriq.com/api/agent/openapi`
- **Shared skill:** served by the `get_instructions` tool and downloadable from Settings

Claude can use a custom connector with the MCP URL and `Authorization: Bearer <key>`. ChatGPT can use a Custom GPT Action by importing the OpenAPI schema and setting bearer authentication. Both read and write the same PostgreSQL records; neither has a second prospect database and neither has a send tool.

Available tools: `get_instructions`, `read_product_truth`, `list_research_jobs`, `report_progress`, `search_prospects`, `get_prospect`, `check_duplicate`, `save_prospect`, `save_draft`, `list_conversations`, `get_conversation`, `suggest_reply`, `suggest_follow_up`, `get_conversation_context`.

There is intentionally **no** send, delete, settings, permission, Product Truth mutation or suppression-removal tool.

## Tests

```bash
npm test
```

The integration suite uses a temporary PGlite database and the sandbox mailbox. It verifies 14 workflows, including:

- duplicate detection in the service and at the unique-index level
- refusal of leads without a public email or evidence
- founder-edit preservation against AI overwrite
- idempotent sandbox sending
- reply classification, follow-up cancellation and no follow-up after a reply
- reviewed reply sending with idempotency
- explicit campaign authorization, one-send-per-draft and completion
- immediate unsubscribe suppression and reply blocking
- unsubscribe capability-token handling
- scoped assistant tools with no send action
- database-derived research progress
- quoted-history-safe classification
- archive + suppression behavior

The production build is also validated:

```bash
npm run build
```

## Deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for the full Vercel + Supabase runbook and [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) for an item-by-item acceptance status.

Short version:

1. Create a Supabase PostgreSQL project.
2. Set `DATABASE_URL` and the required secrets locally, run `npm run db:migrate` against Supabase.
3. Import this repository into Vercel.
4. Set `APP_URL`, `DATABASE_URL`, `SESSION_SECRET`, `APP_ENCRYPTION_KEY`, `CRON_SECRET`, `EMAIL_DELIVERY_MODE=sandbox`, `AUTO_MIGRATE=false`.
5. Deploy and attach `leads.nomeriq.com`.
6. Sign in, change the founder password, connect IONOS, approve Product Truth, then enable live sending deliberately.

## Security and compliance

See [SECURITY.md](SECURITY.md). Important boundaries:

- Growth never treats a website or inbound email as instructions to an AI with side effects.
- All mailbox credentials are encrypted at rest; they are never returned by an API.
- Mutating cookie-authenticated routes require a same-origin request.
- Sending requires a verified recipient, an approved draft or explicit reply action, a healthy account, a non-suppressed address and an idempotent send record.
- Commercial footers include the sender identity, postal address (blocked live if missing) and a unique unsubscribe link.
- Opt-outs are recorded immediately and stop promotional mail.
- Supabase RLS/revoke migration is included for defense in depth. The app does not use the Supabase Data API.

## Deliberate limits

- The 100-lead target is a real target, not a fabricated count. Only two providers were researched and seeded.
- Live IONOS SMTP/IMAP cannot be verified without your real credentials; the adapters are implemented and the sandbox workflow is tested end to end.
- IMAP attachment storage is capped; large attachments are recorded as metadata but not downloadable.
- There is no autonomous browser-running research worker. Research happens in a connected ChatGPT/Claude session or through the API, and progress persists. The optional daily Vercel cron prepares follow-up drafts only.
- Product Truth is seeded as **needs review**. The founder must approve actual capabilities, pricing and limitations before those can be used in outreach.
- The login rate limiter is in-process. For multi-instance production, put a platform-level rate limit/WAF in front of `/api/auth/login`.

## Project map

```
src/app/(app)/          dashboard, research, leads, email, Product Truth, settings
src/app/api/            auth, leads, drafts, conversations, campaigns, MCP, agent API
src/lib/db/             Postgres/PGlite adapter and migrations runner
src/db/migrations/      complete SQL schema + Supabase deny-by-default migration
src/lib/services/       workflow services and database transactions
src/lib/email/          SMTP/IMAP adapters, sync, classification
src/lib/ai/             draft/reply writers and claim validation
src/lib/agent/          shared MCP/REST tools and one skill document
tests/                  integration workflow suite
```
