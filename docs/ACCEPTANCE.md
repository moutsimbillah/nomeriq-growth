# Acceptance status

This is an honest status against the brief. It separates what is proven in this environment from what needs the founder's live credentials or a real spend.

Two things are deliberately **not** claimed: real IONOS delivery/synchronization (no live mailbox was supplied) and live DeepSeek API calls (no `DEEPSEEK_API_KEY` existed in the build environment). The engine itself is proven offline and end to end against a local HTTP stub that speaks the real DeepSeek request shapes.

## The headline objective

> I click "Find 100 New Leads" in Growth, and the system independently researches, verifies, deduplicates and saves qualified trading-signal businesses with personalized email drafts.

**Implemented and verified end to end, at a small target.** The engine runs on the server with no browser or chat session, persists every step in PostgreSQL, hard-caps spend, and produces verified leads with drafts. The 100-lead figure is a setting of a real target, not a number this environment could produce without either a live DeepSeek key or fabricated data — and fabrication is explicitly forbidden.

## Original acceptance tests

| # | Acceptance test | Status | Evidence / boundary |
| --- | --- | --- | --- |
| 1 | Request 100 new providers | **Working** | Research target persisted at any count (25/50/100/250+); the DeepSeek engine is the mechanism that fulfils it. |
| 2 | Genuinely qualified businesses in five categories | **Partially demonstrated** | 2 real verified providers seeded (FXPremiere, P4 Provider) with paid signal products, official sites and sources; the engine added further verified leads under test. The remainder is not fabricated. |
| 3 | Official, publicly sourced emails | **Working** | Emails stored with exact source URLs and verification dates. A verified save is rejected without them, and `resolveContactEmail` refuses any address not actually extracted from a fetched page. |
| 4 | Avoid all saved businesses | **Working** | Service duplicate checks, unique indexes on domain/alias/socials, a partial unique index on business email, and short-lived `candidate_claims` for concurrent workers. Generic inboxes never merge unrelated businesses. |
| 5 | One draft for every qualified lead | **Working** | Seed produced 2 drafts for 2 verified leads; the engine generates a draft per saved lead; a unique first-contact index prevents a second. |
| 6 | Review and edit drafts | **Working** | Lead page editor, revisions, founder-edit flag, save, approve, copy, regenerate. Test confirms AI cannot overwrite founder edits. |
| 7 | Send approved emails through IONOS | **Adapter implemented; live not verified** | IONOS SMTP/STARTTLS path, encrypted credentials, cap/interval, idempotent send ledger and sandbox mode. Only sandbox sending was exercised. |
| 8 | Receive replies in Growth | **Sandbox verified; live not verified** | IMAP INBOX sync, association by headers/exact email, reply classification and unread state implemented; sandbox reply inserted through the production code path. |
| 9 | Synchronize externally sent IONOS mail | **Implemented; live not verified** | Sent-folder sync with UIDVALIDITY/UID tracking and external-send association. |
| 10 | Open reply and send without extra approvals | **Working** | Founder reads, optionally generates a suggestion, edits and sends. Only recipient, suppression, authentication, idempotency and footer safeguards apply. |
| 11 | Prepare follow-ups | **Working** | Due-thread detection, configurable count/delays, deterministic personalized follow-ups, review UI, save/approve/send. |
| 12 | Prevent follow-ups after reply/opt-out | **Working** | Inbound sync cancels active follow-up drafts; opt-out creates suppression and do-not-contact. |
| 13 | Track demo/proposal/sale | **Working** | Ten-stage pipeline and next action on every lead, with UI stage editor and API. |
| 14 | ChatGPT and Claude contribute without duplication | **Working** | Shared MCP + REST, scoped keys, one shared skill, `check_duplicate`, `save_prospect`, `save_draft`, progress. No send/delete/settings/job-control tools. |
| 15 | Repeat for another 100 | **Supported** | New targets continue from database counts; duplicate protection spans the whole database. Not executed to 100 without live research. |
| 16 | Independently operate from Nomeriq | **Working** | Separate repo, database, auth, credentials, mail integration and deployment. No access to the existing Nomeriq project or AWS infrastructure. |

## Autonomous engine acceptance

| Requirement | Status | Evidence / boundary |
| --- | --- | --- |
| DeepSeek official Search | **Implemented** | `POST {base}/v1/tools/search` with `query`, `count`, `ori_question`, `localization`; response items normalized into candidate identities. |
| DeepSeek official Fetch | **Implemented** | `POST {base}/v1/tools/fetch`; fetched page text is the only source of contact emails. |
| DeepSeek chat for verdict + draft | **Implemented** | `chat/completions` with strict JSON verdict parsing and a deterministic fallback draft writer. |
| No second search provider | **Working** | No other search API exists anywhere in the codebase; the engine's only network dependency is the configured DeepSeek base URL. |
| Credentials never reach the frontend | **Working** | The key is encrypted at rest; APIs expose only `keyConfigured`/masked metadata. Verified by inspection and by the settings UI never pre-filling the value. |
| Job runs independently of browser/chat | **Working** | The worker is a server route (`/api/cron/research`) driven by cron; all state is in PostgreSQL. Killing the browser changes nothing. |
| Never restart a completed job from zero | **Working** | Terminal-state guard in `runResearchTick` plus a dedicated test asserting a completed job is not re-run. |
| Actual counts and honest stop reason | **Working** | Counters and `stopReason` are read from the database and rendered verbatim; no estimate is presented as a measurement. |
| Short-lived candidate claims | **Working** | `candidate_claims` with `claim_expires_at`, 15-minute TTL, `FOR UPDATE SKIP LOCKED` dispatch, automatic requeue after expiry. |
| Don't merge on generic emails | **Working** | `prospect_emails_business_email_unique` is partial; generic local-parts are excluded from the identity key. Two tests cover both directions. |
| Budget exhaustion pauses safely | **Working** | Job moves to `budget_paused`, progress preserved, reason recorded; tested. |
| Existing sales workflows preserved | **Working** | The 14 original workflow tests still pass unmodified in behaviour (one assertion was corrected to match the generic-email rule). |
| MCP/REST tools + Product Truth + founder edits preserved | **Working** | Tool list extended with `get_research_job` (read-only) and an engine-aware `report_progress`; no tool was removed, no permission widened and no job-control tool exists. Verified: an assistant calling a job-control action gets `404`, and an assistant can read the job's real `engine`, `spentUsd` and counts. |
| No Docker/K8s/new database | **Working** | Same PGlite/Supabase Postgres, same Vercel model; no infrastructure was added. |
| 10 genuinely new qualified leads, then scale to 25/50/100+ | **Mechanism verified, volume not reached** | Every unit of that path is tested and the target count is a real setting, but producing 10–100 genuine leads requires live DeepSeek spend and real web research. Not fabricated. |
| No live prospecting email sent during testing | **Working** | The engine has no send path; `EMAIL_DELIVERY_MODE=sandbox`; the cron response states no email was sent. |

## Test evidence

```text
Test Files  2 passed (2)
     Tests  33 passed (33)
```

`tests/research-engine.test.ts` (18 tests) exercises the engine through an injected `ResearchProvider`, so autonomous research is provable with no API key and no network:

- discovers, verifies, saves a lead with a draft, and records real itemized cost
- resumes an interrupted job from persisted state instead of restarting
- does not restart a completed job from zero
- duplicate-safe multi-worker claims, claim expiry and requeue
- records engine usage as real DeepSeek operations with cost
- engine-attributed leads are saved as `verified` with `actorType: "deepseek"`
- email extraction refuses model-invented addresses
- evidence rules reject brokers, indicator/bot sellers, education-only and stocks-only sites
- budget exhaustion pauses safely with progress preserved
- cancels cleanly and reports an honest `stopReason`
- a not-configured key fails with an actionable message instead of spending

`tests/workflow.test.ts` (15 tests) covers the original sales workflows plus generic-email deduplication in both directions.

### End-to-end harness

```bash
npm run build
node scripts/e2e-engine.mjs
```

Starts the built app and a local DeepSeek HTTP stub, then drives the real provider adapter over HTTP through the entire path. Verified output:

```text
Real HTTP calls through the provider adapter — searches: 4, fetches: 4,
                                              model calls: 2, model list: 1

verified=1 target=1 status=completed candidates=1 spent=$0.005500
chat   1 call, 1500 in / 300 out = $0.000810
fetch  3 requests               = $0.002250
search 2+ requests              = $0.000750 each

cron auth: 401 without secret, 200 with secret
  "Research only. No email was sent."
assistant scope: get_research_job, report_progress readable
assistant scope: no job-control tool exists (404)
no conversation exists for the lead; the only draft is 'draft' with no sentAt
completed job was not restarted and no further spend occurred
/research renders 200 with the engine panel
```

The "nothing was sent" check is deliberately made at the prospect level rather than through `list_conversations`, because that tool only lists threads that already have a reply — a sent-but-unanswered email would be invisible there and the assertion would prove nothing.

Production build:

```text
✓ Compiled successfully
✓ Generating static pages
```

New routes confirmed in the build output: `/api/cron/research`, `/api/research/[id]/engine`, `/api/research/status`, DeepSeek settings routes, and `/research`.

Migrations were applied to a fresh database end to end, confirming `research_jobs_status_check` accepts `budget_paused`/`cancelled`/`failed` and that the global email unique index was replaced by `prospect_emails_business_email_unique`.

## Not claimed

- No live unsolicited email was sent.
- No live DeepSeek request was made; there was no `DEEPSEEK_API_KEY` in this environment. The unverified variable is the live service's exact response body, not the request shape or the engine logic.
- No real IONOS mailbox was connected here.
- 100 leads were not produced. Two providers were researched and seeded by hand, and the engine produced verified leads under test data. The rest is left genuinely unproduced rather than invented.
- OpenAI/Anthropic calls were not exercised; the deterministic writer and the adapters are present.
- Supabase/Vercel deployment was not executed here; the schema is PostgreSQL-compatible and the runbook is included.
- Sites that require a logged-in browser session or heavy JavaScript rendering may not yield a published email through Fetch; the engine reports such candidates as failed rather than qualifying them.
