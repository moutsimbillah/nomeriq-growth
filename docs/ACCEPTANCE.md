# Acceptance status

This is an honest status against the brief. It separates what is proven in this environment from what needs the founder's live credentials or a real spend.

Two things are deliberately **not** claimed: real IONOS delivery/synchronization (no live mailbox was supplied) and live DeepSeek API calls (no `DEEPSEEK_API_KEY` existed in the build environment). The engine itself is proven offline and end to end against a local HTTP stub that speaks the real DeepSeek request shapes.

## The headline objective

> I click "Find 100 New Leads" in Growth, and the system independently researches, verifies, deduplicates and saves qualified trading-signal businesses with personalized email drafts.

**Implemented and verified end to end, including at the brief's 10-lead acceptance bar.** The engine runs on the server with no browser or chat session, persists every step in PostgreSQL, hard-caps spend, and produces verified leads with drafts. A test drives one target to exactly 10 verified leads with real per-lead emails, sources and drafts, while rejecting broker decoys.

What this environment cannot do is run that same path against the live web: there is no `DEEPSEEK_API_KEY` here, and the 100-lead figure would require real search spend. That target is a real setting with a real mechanism behind it, and the missing volume is left genuinely unproduced rather than invented.

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
| Visible progress while it runs | **Working** | `GET /api/research/[id]/activity` serves a live transcript of real recorded steps — searches, candidates found, pages read, verdicts, duplicates, rejections, the saved lead and draft — polled every 2s while active. The panel also drives the job itself, one bounded step at a time, so an install with no scheduler still progresses. |
| Two tabs cannot double-spend | **Working** | `claimJobLease` takes a short-lived exclusive lease with a single conditional `UPDATE`, so the database picks one winner; an expired lease is reclaimed. Tested directly, including that a paused job still reports its real status rather than a fabricated conflict. |
| Never restart a completed job from zero | **Working** | Terminal-state guard in `runResearchTick` plus a dedicated test asserting a completed job is not re-run. |
| Actual counts and honest stop reason | **Working** | Counters and `stopReason` are read from the database and rendered verbatim; no estimate is presented as a measurement. |
| Short-lived candidate claims | **Working** | `candidate_claims` with `claim_expires_at`, 15-minute TTL, `FOR UPDATE SKIP LOCKED` dispatch, automatic requeue after expiry. |
| Don't merge on generic emails | **Working** | `prospect_emails_business_email_unique` is partial; generic local-parts are excluded from the identity key. Two tests cover both directions. |
| Budget exhaustion pauses safely | **Working** | Job moves to `budget_paused`, progress preserved, reason recorded; tested. |
| Existing sales workflows preserved | **Working** | The 14 original workflow tests still pass unmodified in behaviour (one assertion was corrected to match the generic-email rule). |
| MCP/REST tools + Product Truth + founder edits preserved | **Working** | Tool list extended with `get_research_job` (read-only) and an engine-aware `report_progress`; no tool was removed, no permission widened and no job-control tool exists. Verified: an assistant calling a job-control action gets `404`, and an assistant can read the job's real `engine`, `spentUsd` and counts. |
| No Docker/K8s/new database | **Working** | Same PGlite/Supabase Postgres, same Vercel model; no infrastructure was added. |
| 10 genuinely new qualified leads, then scale to 25/50/100+ | **Reached in test, mechanism verified** | A dedicated test drives one target to exactly 10 verified leads through the real engine path, each with a published email, its source URL, a website and one unsent draft, with 5 broker decoys rejected and 10 distinct inboxes. A second test confirms the count is a real setting and that re-running a completed target adds nothing. Producing 10–100 leads against the live web still requires live DeepSeek spend; nothing is fabricated to inflate a count. |
| No live prospecting email sent during testing | **Working** | The engine has no send path; `EMAIL_DELIVERY_MODE=sandbox`; the cron response states no email was sent. |

## Test evidence

```text
Test Files  8 passed (8)
     Tests  86 passed (86)
```

`tests/research-engine.test.ts` (21 tests) exercises the engine through an injected `ResearchProvider`, so autonomous research is provable with no API key and no network:

- **reaches the brief's 10-lead acceptance bar**: exactly 10 verified leads, each with a published email, source URL, website and one unsent draft, with 5 broker decoys rejected and 10 distinct inboxes
- **scales the same target beyond 10** without duplicating earlier leads, and a completed target adds nothing on re-run
- discovers, verifies, saves a lead with a draft, and records real itemized cost
- resumes an interrupted job from persisted state instead of restarting
- does not restart a completed job from zero
- duplicate-safe multi-worker claims, claim expiry and requeue
- records engine usage as real DeepSeek operations with cost
- honours the `search_prospects` filters it advertises (`jobId`, `qualification`)
- engine-attributed leads are saved as `verified` with `actorType: "deepseek"`
- email extraction refuses model-invented addresses
- evidence rules reject brokers, indicator/bot sellers, education-only and stocks-only sites
- budget exhaustion pauses safely with progress preserved
- cancels cleanly and reports an honest `stopReason`
- a not-configured key fails with an actionable message instead of spending

`tests/spend-reconciliation.test.ts` (5 tests) guards budget accuracy:

- job spend stays exactly equal to the sum of its usage rows across many charges
- a real engine run stays reconciled
- a **pre-existing drifted database is repaired** by migration 005's reconciliation
- the schema invariant itself: `spent_usd` is stored at the same scale as `cost_usd`
- migration 005 applies **idempotently** to a database that already holds data

`tests/research-activity.test.ts` (10 tests) covers the live transcript a founder watches while a target runs:

- a job that has done no work shows **no invented lines** — only the events it genuinely recorded
- discovery, official-page reads, the model verdict, the saved lead and its draft all appear
- an unreadable site surfaces the provider's **real** error, including the upstream `Failed to scrape page with Firecrawl` message, rather than a bare "Not found" or a silent failure
- each operation appears **once**, not once per source table: a search writes both an event and a usage row, and they are paired so the description and the real cost land on one line
- the per-line costs sum to the job's recorded spend, so the log cannot disagree with the budget gate
- a **job lease** refuses a second concurrent worker (the two-open-tabs double-spend case), lets the holder renew, and releases on completion
- a lease is never leaked when a step finds nothing to do, which would otherwise look like a hang for the whole TTL
- a paused job reports that it is paused rather than a **fabricated** "another worker is advancing this job" conflict
- the `ticks` counter advances on every real step, including one driven from the UI rather than the cron
- the transcript stays bounded and newest-first under volume

`tests/deepseek-provider.test.ts` (6 tests), `tests/deepseek-connection-errors.test.ts` (4 tests), `tests/deepseek-custom-endpoint.test.ts` (8 tests) and `tests/deepseek-endpoint-paths.test.ts` (17 tests) pin the provider's HTTP contract, its failure reporting and its support for DeepSeek-compatible gateways:

- Search, Fetch and the model list are called at the exact documented paths for **either** base-URL spelling
- a `/v1` base URL never produces a doubled `/v1/v1` path
- a connection failure names the failing step, the URL and the base URL in use, with a base-URL hint on 404/405
- a 401 reports the provider's authentication message and deliberately does **not** suggest changing the base URL
- an insufficient balance is reported as a billing condition, not a configuration mistake
- Search and Fetch paths are configurable per credential, and unsafe values (traversal, embedded whitespace/quotes, absolute URLs to another host) are refused rather than followed
- a custom endpoint without explicit paths is probed, and the paths that answered are reported so they can be persisted
- the official `api.deepseek.com` host is **not** probed speculatively; only the documented paths are attempted there
- a Fetch failure against one unreadable search hit (a news/RSS URL a scraper cannot read) does not mark Fetch broken when a plain page succeeds
- a capability that was never exercised is never reported as working: if Search returns no page to read, Fetch is reported as untested and no Fetch path is returned
- a path that could not be proven is not returned as if it had been, so a failed detection cannot persist a route that does not work

This last group matters because a compatible gateway was measured live. The **route map** was established with a deliberately invalid placeholder key on `vyceai.com`, so that 401 means "route exists, needs auth" and 404 means "no such route": `POST /v1/tools/search` → 404 while `POST /v1/search` → 401, and `POST /v1/tools/fetch` → 404 while `POST /v1/scrape` → 401. That host does implement Search and Fetch, just not under DeepSeek's proprietary names. Treating it as "chat only" was wrong, which is what the configurable paths fix.

`tests/workflow.test.ts` (15 tests) covers the original sales workflows plus generic-email deduplication in both directions.

### End-to-end harness

```bash
npm run build
node scripts/e2e-engine.mjs
```

Starts the built app and a local DeepSeek HTTP stub, then drives the real provider adapter over HTTP through the entire path. The stub serves 11 qualifying providers and one broker, so the acceptance bar is reached over real HTTP rather than only through an injected object. Verified output:

```text
Real HTTP calls through the provider adapter — searches: 7, fetches: 34,
                                              model calls: 22, model list: 1

Single-lead path:
  verified=1 target=1 status=completed spent=$0.00531
  cron auth: 401 without secret, 200 with secret
    "Research only. No email was sent."
  assistant scope: get_research_job, report_progress readable
  assistant scope: no job-control tool exists (404)

The brief's acceptance bar:
  verified=10 target=10 status=completed spent=$0.03285 rounds=2
  10 distinct inboxes, no merged identities
  10 personalized drafts await review
  the broker decoy was rejected, not counted
  job spend equals the sum of recorded usage rows
  spend $0.03285 stayed inside the $25 budget
  no conversation exists for any acceptance lead, so no email was sent
```

The spend figures are read from the run's own recorded usage, so they move when the number of Search/Fetch calls moves; the assertions compare them against the itemized rows rather than against a fixed constant.

The "nothing was sent" check is deliberately made at the prospect level rather than through `list_conversations`, because that tool only lists threads that already have a reply — a sent-but-unanswered email would be invisible there and the assertion would prove nothing.

### Two real defects this harness caught

The e2e run is not decoration; it failed twice on genuine bugs that unit tests had missed.

1. **`search_prospects` silently dropped its own filters.** The tool schema advertised `jobId` and `qualification`, but the handler never passed them to the query, so a caller asking for one target received every prospect in the database. Fixed in `src/lib/agent/service.ts` and covered by a regression test asserting that a non-matching `jobId` returns zero rows rather than everything.
2. **Job spend drifted away from the usage it claimed to total.** `research_usage.cost_usd` is `numeric(12,6)` — a single Search or Fetch request costs $0.00075, so six decimals are the real unit of account — but `research_jobs.spent_usd` was created as `numeric(12,4)`. Every incremental add rounded, and the error compounded: a job that had recorded $0.005661 of real operations stored $0.005900 of spend. Since the budget gate compares `spent_usd` against `budget_usd`, this made the engine pause earlier or later than the founder's actual limit, and made the displayed spend disagree with the itemized rows behind it. Migration `005_spend_precision.sql` widens the column to match and repairs already-recorded drift by re-deriving it from the real usage rows. Covered by four tests, including the upgrade path on an already-drifted database.

Production build:

```text
✓ Compiled successfully
✓ Generating static pages
```

New routes confirmed in the build output: `/api/cron/research`, `/api/research/[id]/engine`, `/api/research/status`, DeepSeek settings routes, and `/research`.

Migrations were applied to a fresh database end to end, confirming `research_jobs_status_check` accepts `budget_paused`/`cancelled`/`failed` and that the global email unique index was replaced by `prospect_emails_business_email_unique`.

## Not claimed

- No live unsolicited email was sent.
- No live request was made to the **official** `api.deepseek.com` service; there was no `DEEPSEEK_API_KEY` for it in this environment. The unverified variable is that service's exact response body, not the request shape or the engine logic. (For the one live custom-endpoint diagnostic that *was* run, see the last bullet.)
- No real IONOS mailbox was connected here.
- 100 leads were not produced. The engine provably reaches 10 verified leads in test and the target count scales to any number, but running it against the live web for 100 real businesses requires live search spend. That volume is left genuinely unproduced rather than invented.
- OpenAI/Anthropic calls were not exercised; the deterministic writer and the adapters are present.
- Supabase/Vercel deployment was not executed here; the schema is PostgreSQL-compatible and the runbook is included.
- Sites that require a logged-in browser session or heavy JavaScript rendering may not yield a published email through Fetch; the engine reports such candidates as failed rather than qualifying them.
- The tab-driven pump is a convenience, not the durable driver. It advances a job only while the panel is open, at a deliberately slower cadence than the cron, and the panel states whether this tab is driving and lets the founder stop it. The cron route remains the mechanism that makes a job progress unattended; a production deployment must still have `CRON_SECRET` and a scheduler for that to happen.
- The live transcript was verified against the running app by driving a real tick through the same endpoint the UI uses: 153 searches produced 153 lines, the 69 costed lines summed to exactly the job's recorded `$0.05175`, and the panel shell (including every honesty affordance) rendered in the served HTML. The per-line rendering itself was exercised only through the API and the component's own logic, not through a scripted browser session.
- **The one exception to the above:** a live custom-endpoint diagnostic was run against `vyceai.com`, outside the engine and without sending email, to explain a connection test that reported a bare "not found". Probing with an invalid placeholder key established the route map in the previous section; a separate call against the gateway's Fetch route showed it is backed by Firecrawl, which answered HTTP 200 with `{"error":"Failed to scrape page with Firecrawl"}` for `https://example.com/`. That is an upstream failure on that host rather than a defect in Growth: the adapter surfaces the provider's own message instead of swallowing it, and reports Fetch as unavailable rather than presenting empty content as a retrieved page. Per the founder's instruction, no further live spend was pursued against that endpoint.

