# Nomeriq Growth

**Open-source, AI-assisted B2B prospect research and outreach software, licensed under the GNU Affero General Public License v3.0 (AGPLv3).**

Nomeriq Growth is a self-hostable, founder-controlled platform for researching potential business customers, checking public evidence, preventing duplicate leads, preparing personalized outreach for human review, managing email conversations, and tracking sales opportunities. The workflow can serve as a starting point for independent founders, small and medium-sized teams, and larger organizations willing to configure or extend it for their needs.

The implemented workflow is:

**Find commercial trading-signal providers → verify the signal business and published contact email → reject duplicates → save evidence → draft a personalized first email → founder review → send → thread replies → respond or follow up → track outcomes → repeat.**

The application is independent of the main Nomeriq platform: it has its own Git repository, database, authentication, encrypted mailbox credentials, and deployment. It does not rely on the main Nomeriq application's production database, AWS workers, or authentication system. It supports **OpenAI, Anthropic Claude, DeepSeek, and custom AI APIs**, as well as **ChatGPT, Claude, and Hermes agent integrations via MCP and shared skills**. API connections and agent integrations are separate features, described below.

![Dashboard](artifacts/screenshots/02-dashboard.png)

## Open-source scope

- **Run and extend it:** Source code is available under the [AGPLv3 license](LICENSE). You can deploy and customize it subject to that license's conditions.
- **Current implementation:** Research, verification, drafting, conversations, follow-ups, and campaigns are implemented for the maintainer's trading-signals prospecting workflow. The repository is not presented as a ready-made multi-tenant enterprise CRM or a built-in calendar meeting-booking service.
- **Other industries:** Adapt the market-specific research queries, eligibility/verification rules, seeded examples, Product Truth, and outreach content; then rerun the tests and verify behavior against real public evidence before using it for a different market.
- **Your own instance:** Configure your own database, secrets, domain, email service, sender identity, AI providers, and compliance settings. Do not reuse the maintainer's credentials, contacts, or production service endpoints.
- **Early public release:** Adoption, production-scale performance, and compatibility across unrelated industries have not yet been established by independent deployments.

## What is working

- **Dashboard** with live lead, draft, reply, opportunity and mailbox counts.
- **Autonomous research engine**: run background prospect discovery, evidence checks, deduplication, saving and drafting from the application. The documented DeepSeek adapter uses Search and Fetch; other configured AI providers may have different capabilities and tool requirements. Research state is stored in PostgreSQL, with budget controls and resumable jobs.
- **Research targets** persisted in PostgreSQL, with database-derived progress and a resumable brief for connected agents such as ChatGPT, Claude, or Hermes.
- **Global deduplication** on domain, business name/aliases, contact email, Instagram, YouTube, X and Telegram. Unique indexes enforce identity even if an assistant skips the pre-check, and short-lived database claims let several workers research at once without duplicating a business. Generic inboxes (`info@`, `support@`, …) are valid contact addresses but never a deduplication key on their own.
- **Evidence-first leads**: a verified lead cannot be saved without an official website, a published contact email, the exact email source URL and at least one public evidence source.
- **Product Truth** controlled by the founder, with claim warnings on AI drafts and a deliberate no-ceremony path for founder-written replies.
- **Personalized first-contact drafts** with configured AI model APIs (OpenAI, Claude, DeepSeek or a compatible custom provider, where supported by the selected workflow), or a deterministic founder-style writer without an API key. Drafts are saved for human review.
- **Email delivery** through IONOS SMTP (or another SMTP/IMAP provider) with encrypted credentials, rate caps, idempotency, opt-out footers and an explicit sandbox mode.
- **IMAP synchronization** for Inbox and Sent, thread association by headers/exact email, external sent-mail capture, unmatched inbound visibility and mailbox-history warnings.
- **Simple reply workflow**: open thread → read → write or generate a suggestion → send. No extra internal approval step for a personally reviewed reply.
- **Follow-ups** prepared from unanswered threads, stopped by replies, opt-outs and suppression, and never sent automatically.
- **Campaigns** from approved first-contact drafts, with explicit founder authorization, progress, pause/resume and duplicate-send prevention.
- **Agent integrations for ChatGPT, Claude and Hermes**, using scoped Growth MCP tools and shared skill instructions; REST/OpenAPI access is also documented for compatible clients. Research keys have no send permission.
- **Suppression**, archive controls, JSON backup export, audit logging, security headers, CSRF/origin checks and encrypted credentials.

## AI providers and agent integrations

Nomeriq Growth supports two distinct ways to work with AI:

| Connection | Supported options | Purpose |
| --- | --- | --- |
| **Model/API providers** | **OpenAI API**, **Anthropic Claude API**, **DeepSeek API**, and **custom API endpoints** | Supply models and, where the configured provider supports them, tools for AI-assisted research, assessment, and outreach drafting. |
| **Connected AI assistants** | **ChatGPT**, **Claude**, and **Hermes Agent** | Work with the Growth database and workflows through its permission-scoped **MCP tools** and **shared skills/instructions**. The REST/OpenAPI interface offers another client integration path. |

**These are not interchangeable connections.** For example, configuring an OpenAI API key inside Growth is different from connecting ChatGPT as an agent client. The same distinction applies to the Claude API versus Claude as an assistant. Hermes is an external agent integration, not another built-in model API provider.

- Each model API or custom endpoint requires its own configuration and credentials. Provider support does **not** imply identical models, Search/Fetch features, tool-calling behavior, pricing, or availability. Test the particular provider and workflow before running a paid research job.
- A custom API must implement the interface required by its selected workflow. A general chat-completion endpoint alone might not provide web research or fetching tools.
- MCP clients and skill instructions use the app's configured tool scopes. Research and drafting access does **not** grant permission to send email, alter settings, or control research jobs through tools that are not exposed.
- The detailed steps below document the earlier **DeepSeek Search/Fetch workflow** and the shared MCP/REST interface; other provider-specific setup may differ by deployment/version.

## Local workspace

The app runs at **http://localhost:3100** by default.

The initial administrator (called the "founder" in this workflow) is created by `npm run db:seed` from `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env.local` (see `.env.example`). Set your own values before seeding, and never publish credentials in the README or anywhere in the repo.

The documented local seed uses two publicly researched trading-signal providers as **examples for the existing vertical**:

| Lead | Markets | Public email | Evidence |
| --- | --- | --- | --- |
| [FXPremiere](https://www.fxpremiere.com/) | Forex, gold/metals, crypto, indices | `daniel@fxpremiere.com` | [Official terms/contact footer](https://www.fxpremiere.com/terms-of-service/), [paid plans](https://www.fxpremiere.com/) |
| [P4 Provider](https://p4provider.com/) | Forex, crypto | `contact@p4provider.com` | [Official pricing](https://p4provider.com/pricing), [contact page](https://p4provider.com/contact) |

These sources and publicly listed contact details were observed on 3 November 2026; they are historical test examples, not a claim that the businesses' details remain current. No email was sent to either business during the documented verification. A duplicate FXPremiere attempt was recorded as rejected, exercising the database-backed duplicate path. Users of a new instance should verify public contact details and compliance requirements independently.

In the documented local seed, the research target begins at **2 / 100**; this is seed/test state, **not a live usage metric** or a claim about the current hosted instance. The system does not fabricate the other 98 providers. Connected agents such as ChatGPT, Claude, or Hermes can continue a configured research target through the exposed scoped tools, subject to the installed integration and its permissions.

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

## Autonomous research engine — DeepSeek configuration example

The platform supports multiple model API providers as described above. This section retains the detailed, previously documented **DeepSeek Search/Fetch** setup; do not assume the same provider-specific endpoints or tool support apply to OpenAI, Claude, or a custom API.

Growth can research leads by itself. Nothing depends on a browser tab, a chat session or a connected assistant: every piece of state is a PostgreSQL row, so a timeout, a redeploy or a crash simply means the next run continues where the last one stopped.

### Configure the DeepSeek adapter

1. **Settings → DeepSeek**: paste the API key, confirm the base URL (`https://api.deepseek.com`) and model (`deepseek-flash`), then use **Test connection**.
   The key is stored encrypted with `APP_ENCRYPTION_KEY` and is **never** returned to the browser. Alternatively set `DEEPSEEK_API_KEY` on the server; a key saved in Settings overrides the environment.
   If you paste the base URL as `https://api.deepseek.com/v1` (the spelling DeepSeek's OpenAI-compatible docs use), Growth normalises it automatically — a trailing `/v1` is stripped because every endpoint path already carries its own version segment. If a step fails, the error names the step, the exact URL, the base URL in use, and what to check.
   A DeepSeek-compatible gateway works too. If it mounts Search and Fetch somewhere other than DeepSeek's proprietary paths, leave the two path fields blank and **Test connection** finds, reports and remembers what answered; or set the paths yourself. A host that serves only chat is reported as such instead of failing with a bare "not found".
2. **Settings → Workspace**: set the default research budget, concurrency, and the DeepSeek Search/Fetch QPS limits.
3. **Research → New research target**: choose the **DeepSeek engine**, set the target count and a USD budget.
   A DeepSeek target is created **paused** on purpose, so the founder sees the budget before any money is spent.

### Run it

The engine panel on **Research** has `Start`, `Pause`, `Resume`, `Cancel` and `Step once`, plus live counters, real spend against the budget, and a **Why it stopped** line.

#### Live activity

While a job is active the panel shows a **live activity** transcript that fills in as the engine works — each search query and how many results it returned, each candidate found, each official page read, the model verdict, every duplicate blocked and every rejection with its reason, and the lead and draft that came out of it. Lines appear only once the database has accepted them, so the transcript cannot run ahead of the real work, and the per-line costs sum to the job's recorded spend rather than being estimated separately.

The transcript is served by `GET /api/research/[id]/activity`, which merges the job's events, usage rows, worker runs and failed candidates into one ordered log. A search or fetch writes both an event and a usage row for the same physical request, so those are paired: the event supplies the description and the usage row supplies the real cost.

#### Who advances a job

`POST /api/research/[id]/engine` runs a bounded step on demand, and an **open panel drives the job itself**, one step at a time, so a target never sits still just because no scheduler is running. This is deliberately slower than the cron and is not a substitute for it. Two tabs, or a tab and the cron firing together, cannot double-spend: `claimJobLease` takes a short-lived exclusive lease on the job as a single conditional `UPDATE`, so the database picks the winner and an expired lease is taken over automatically. The panel says plainly whether *this* tab is driving, and lets you stop it.

In production, `vercel.json` drives it:

```
POST /api/cron/research   every 5 minutes
Authorization: Bearer $CRON_SECRET
```

The route fails closed if `CRON_SECRET` is unset or the database is unreachable, advances at most `RESEARCH_WORKER_MAX_JOBS` due jobs per invocation, and is **research only** — its response states explicitly that no email was sent. `POST /api/research/[id]/engine` exposes the same controls to the founder's session.

### How one candidate is researched

1. A rotating query plan across markets × commercial intent (`VIP`, `subscription`, `monthly`, …) × 12 languages × surfaces (Instagram, Telegram, YouTube, Discord) issues DeepSeek **Search** calls.
2. Result identities are recorded as candidates. A unique `(job_id, identity_key)` and short-lived `candidate_claims` rows make this duplicate-safe and multi-worker safe; claims expire automatically so a dead worker never blocks an identity.
3. The worker claims pending candidates with `FOR UPDATE SKIP LOCKED`, fetches the site and same-domain follow-up pages through DeepSeek **Fetch**, and extracts emails only from what was actually retrieved.
4. `assessSignalEvidence` requires **both** signal-product evidence and commercial/pricing evidence, and rejects brokers, indicator/bot sellers, education-only, stocks/options-only and news sites.
5. Duplicates are checked before saving. A qualified lead is saved with `actorType: "deepseek"` and `qualificationStatus: "verified"`, then one first-contact draft is generated for founder review.

### Honesty rules encoded in the engine

- The model can never introduce an email that was not extracted from a fetched page — `resolveContactEmail` only accepts a model suggestion if that address was really seen.
- A model failure or a failed verification never produces a qualified lead; it is recorded as a failed attempt and retried at most `MAX_CANDIDATE_ATTEMPTS` times.
- Budget exhaustion **pauses** the job with `status: "budget_paused"`, preserving all progress and recording why.
- Search and Fetch are billed per **successful** request and chat is billed per token; every one of those is written to `research_usage`, and the UI's spend figure is the sum of real recorded rows — not an estimate. The live transcript is built from those same rows, so the log and the budget can never disagree.
- The engine only ever writes drafts. There is no send path in the engine, in the research API scopes or in the assistant tools.
- A job that has done nothing shows an empty transcript rather than invented progress, and a job that is paused reports that it is paused rather than a fabricated "another worker is running" conflict.

If a target is not reached, Growth reports the real count and the recorded `stopReason` (budget exhausted, query plan exhausted, verifications failing). It never pads a count with weak leads and never claims a stopped job is still running.

## ChatGPT, Claude and Hermes — MCP and shared skills

Create separate, appropriately scoped keys in **Settings → AI integrations** for each connected assistant.

For your own deployment, substitute **your deployed domain** for the URLs below (the maintainer's current deployment uses `leads.nomeriq.com`):

- **MCP endpoint:** `https://YOUR-DOMAIN/api/mcp`
- **REST base:** `https://YOUR-DOMAIN/api/agent/v1`
- **OpenAPI schema for ChatGPT Actions:** `https://YOUR-DOMAIN/api/agent/openapi`
- **Shared skill:** served by the `get_instructions` tool and downloadable from Settings

Claude can use a custom connector with the MCP URL and `Authorization: Bearer <key>`. ChatGPT can use the REST/OpenAPI interface through a Custom GPT Action or a supported MCP integration. Hermes Agent can use the scoped MCP endpoint and its shared Growth skill/instructions through a compatible Hermes MCP configuration. All three work against the same Growth database; the integrations do not create separate prospect databases. Available actions depend on the granted tool scopes, and none of these integrations is granted an email-send tool by this documented interface.

Available tools: `get_instructions`, `read_product_truth`, `list_research_jobs`, `get_research_job`, `report_progress`, `search_prospects`, `get_prospect`, `check_duplicate`, `save_prospect`, `save_draft`, `list_conversations`, `get_conversation`, `suggest_reply`, `suggest_follow_up`, `get_conversation_context`.

There is intentionally **no** send, delete, settings, permission, Product Truth mutation, suppression-removal or **job-control** tool in the documented integration. An assistant can read a research job's recorded status, spend and stop reason, but only an authorized application user can start, pause, resume or cancel it. **Installing a skill does not bypass these permissions.**

## Tests

```bash
npm test
```

The integration and engine suites use a temporary PGlite database and the sandbox mailbox, with no network access: the engine is exercised through an injected `ResearchProvider`, so autonomous research is provable offline without an API key.

```text
Test Files  12 passed (12)
     Tests  117 passed (117)
```

The 14 workflow tests cover:

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
- generic inboxes (`info@`) not merging unrelated businesses, while a non-generic contact email still deduplicates

The 21 engine tests cover:

- **reaching the brief's 10-lead acceptance bar** — exactly 10 verified leads, each with a published email, its source URL, a website and one unsent draft, with broker decoys rejected
- **scaling the same target beyond 10** without duplicating earlier leads, and a completed target adding nothing on re-run
- discovering, verifying, saving a lead with a draft, and recording itemized real cost
- resuming an interrupted job from persisted state instead of restarting
- never restarting a completed job from zero
- duplicate-safe multi-worker claims, claim expiry and requeue
- recording each engine operation as real DeepSeek usage with cost
- honouring the `search_prospects` filters it advertises (`jobId`, `qualification`)
- email extraction that refuses model-invented addresses
- evidence rules that reject brokers, indicator/bot sellers and education-only sites
- budget exhaustion pausing safely with progress preserved
- terminal-state guards, cancellation, and honest `stopReason` reporting

The 5 spend-reconciliation tests guard budget accuracy: job spend must stay exactly equal to the sum of its usage rows, including on a database that had already accumulated drift before migration 005, and that migration must apply idempotently.

The 10 live-activity tests guard the transcript the founder watches: that it invents no lines for a job that has done nothing, that searches, page reads, verdicts, rejections and the saved draft all appear, that an unreadable site surfaces the provider's real error (including the upstream Firecrawl message) instead of failing silently, that each operation appears **once** rather than once per source table, that per-line costs sum to the job's recorded spend, and that the job lease refuses a second concurrent worker while never replacing a paused job's real status with a fabricated conflict.

The DeepSeek provider tests pin the exact endpoints the adapter calls (`/models`, `/v1/tools/search`, `/v1/tools/fetch`) for both base-URL spellings, prove a `/v1` base URL never produces a doubled `/v1/v1` path, and prove a connection failure names the failing step, the URL, and the base URL in use instead of surfacing the provider's bare "not found". Further tests cover custom endpoints: configurable and auto-detected Search/Fetch paths, refusal of unsafe path values, and the honesty rules that a capability which was never exercised is never reported as working — a Fetch path is returned only when a page was actually retrieved.

A separate end-to-end harness runs the real provider adapter over HTTP against a local DeepSeek stub, alongside the built app:

```bash
node scripts/e2e-engine.mjs
```

It creates a target, starts it, drives the worker through the cron route, and asserts lead creation, draft creation, itemized usage, cron auth enforcement and that no email was sent. It then runs the brief's acceptance bar itself: the stub serves 11 qualifying providers plus a broker, and the harness drives the real HTTP path to **10 verified leads with 10 drafts**, rejecting the broker and proving job spend equals the sum of its usage rows.

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
4. Set `APP_URL`, `DATABASE_URL`, `SESSION_SECRET`, `APP_ENCRYPTION_KEY`, `CRON_SECRET`, `EMAIL_DELIVERY_MODE=sandbox`, and `AUTO_MIGRATE=false`. Configure credentials for the AI provider(s) you actually intend to use (`DEEPSEEK_API_KEY` is the documented DeepSeek example).
5. Deploy and attach **your own application domain** (`leads.nomeriq.com` is the maintainer's example, not a required domain).
6. Sign in, change the initial administrator password, configure your chosen SMTP/IMAP provider (IONOS is the documented example), approve Product Truth, then enable live sending deliberately.
7. Confirm the `/api/cron/research` schedule appears in Vercel and advances the research target configured for your deployment.

## Security and compliance

See [SECURITY.md](SECURITY.md). Important boundaries:

- Growth never treats a website or inbound email as instructions to an AI with side effects.
- All mailbox credentials are encrypted at rest; they are never returned by an API.
- The documented DeepSeek API key is server-only and encrypted at rest; the application does not return its raw value to the browser. Apply equivalent secret-handling checks to OpenAI, Claude, and custom provider credentials in your chosen deployment.
- Mutating cookie-authenticated routes require a same-origin request.
- Sending requires a verified recipient, an approved draft or explicit reply action, a healthy account, a non-suppressed address and an idempotent send record.
- Commercial footers include the sender identity, postal address (blocked live if missing) and a unique unsubscribe link.
- Opt-outs are recorded immediately and stop promotional mail.
- Supabase RLS/revoke migration is included for defense in depth. The app does not use the Supabase Data API.
- API keys carry an expiry (default 90 days) and are rate-limited per key. Neither the key value nor mailbox credentials are ever returned by an API.

## Deliberate limits

- The 100-lead target is a real target, not a fabricated count. The engine provably reaches the brief's 10-lead bar in the test suite and the target count scales from there; the local database additionally holds two hand-researched providers. Running to 100 against the live web needs live search spend.
- The historical test results below describe the original DeepSeek adapter. Live DeepSeek calls could not be exercised in that build environment because no `DEEPSEEK_API_KEY` was available; tests used an injected provider and a local DeepSeek HTTP stub. Those results do **not** by themselves verify live OpenAI, Claude, or custom API behavior; test each configured provider separately.
- Live IONOS SMTP/IMAP cannot be verified without your real credentials; the adapters are implemented and the sandbox workflow is tested end to end.
- IMAP attachment storage is capped; large attachments are recorded as metadata but not downloadable.
- The documented DeepSeek workflow is not a browser-driving agent. It uses its Search and Fetch tools; other providers require equivalent capabilities for autonomous web research. Sites requiring a logged-in browser or heavy JavaScript rendering may not yield a published email.
- API pricing and metering vary by AI provider. The documented DeepSeek Search/Fetch requests have their own billing rules. Set budgets and verify usage accounting for the particular provider and endpoint before running research.
- Product Truth is seeded as **needs review**. The founder must approve actual capabilities, pricing and limitations before those can be used in outreach.
- The login rate limiter is in-process. For multi-instance production, put a platform-level rate limit/WAF in front of `/api/auth/login`.

## Project map

```
src/app/(app)/          dashboard, research, leads, email, Product Truth, settings
src/app/api/            auth, leads, drafts, conversations, campaigns, MCP, agent API
src/app/api/cron/       research worker + follow-up draft preparation
src/app/api/research/   research jobs, engine control, status
src/lib/deepseek/       documented DeepSeek Search/Fetch/chat adapter and evidence rules
src/lib/db/             Postgres/PGlite adapter and migrations runner
src/db/migrations/      complete SQL schema + Supabase deny-by-default migration
src/lib/services/       workflow services, research engine, worker, candidate claims
src/lib/email/          SMTP/IMAP adapters, sync, classification
src/lib/ai/             draft/reply writers and claim validation
src/lib/agent/          shared scoped MCP/REST tools and agent skill instructions
tests/                  workflow + autonomous engine suites
scripts/                e2e engine harness
```

## Contributing

Issues, bug reports, security-conscious improvements, documentation updates, and pull requests are welcome. Please describe the problem and proposed change, run `npm run typecheck`, `npm test`, and `npm run build` when applicable, and do not include private business data, credentials, or unsolicited messages in test fixtures. Security vulnerabilities should be reported using the instructions in [SECURITY.md](SECURITY.md) rather than posted publicly.

## License

Copyright (c) 2026 Muhammad Moutsim Billah.

Nomeriq Growth is distributed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**. See the [LICENSE](LICENSE) file for the full terms. In general, AGPLv3 permits use, modification, and commercial deployment, while imposing source-availability and other obligations, including for modified versions made available to users over a network. Third-party components retain their respective licenses.
