# Lead model, product fit and research — approval proposal

**Status: approved by the founder on 7 Nov 2026, with four changes (below). Local implementation only; every live change still goes through the review gate, a verified backup and the founder's own stop points.**

Founder-approved changes: (1) established presence is 1,000 on one official Instagram or YouTube account; (2) priority rubric — product fit High 70, Medium 45, Unknown 30 (shown as provisional), Low 10, other parts as proposed, overrides always win; (3) old “Tier 2” is a hint for Category B only, confirmed by evidence (no published email → Category B; an email found → re-assess normally); (4) research searches through the official DeepSeek provider's own built-in search (Growth-Chat-Search) for now, with Brave left optional for later and no card or billing needed. Screenshots are at 1280 only. The five additive tables are approved under the charter (reviewer pass and verified backup before live), and the not-interested change is approved.

The founder's original rules are preserved verbatim in [`lead-rules.md`](lead-rules.md), followed by the later founder-approved amendments. This document records implementation choices, not new business rules. The approved `Nomeriq-Growth-Plan.md` is unchanged.

**Local screenshot checkpoint:** migration `030_lead_model.sql` now contains the exact approved SQL (normalized comparison passed), and the append-only model, duplicate protection, outreach guards, rejection recommendations, list/profile pills and shared SQL filters are implemented locally. The latest typecheck and build passed; the full suite passed 1,353 tests with 7 skipped (148 files passed, 1 skipped). Desktop screenshots at 1280 use labeled synthetic data in a separate PGlite fixture; all 272 copied source files matched the gated checkout. The fixture server has been stopped and its port/process closure verified. No feature commit/deployment or live migration/backfill/recovery/research/sending has run. Screenshot layouts were approved by the founder ("approved these layouts"); the research pipeline, cross-platform AI context, evidence-backed legacy-backfill preview and 76-address recovery work remain outstanding.

## 1. Read-only findings

### Current portal

The current schema has qualification (`candidate`, `verified`, `rejected`), rejection reason, website/social identities, sources with observation dates, sourced business email addresses, signal description, pricing, evidence/research/founder notes, and founder-edit metadata. There is no first-class tier, overall lead priority, product fit, platform maturity or mobile-app status.

Audience is two lead-level text fields (`follower_count`, `subscriber_count`), not an account/platform/date model. The legacy import chose a latest count **by kind**, so YouTube and Telegram subscribers cannot safely be distinguished from that text alone. Non-email routes were retained in `other_socials`, but not as the requested dated contact-route model. Existing `rejection_reason` can be reused; it must not be confused with rejection of an outreach offer.

Read-only live aggregates:

| Item | Observed |
| --- | ---: |
| Current leads | 578 |
| Leads with a legacy ID link | 578 |
| Leads with follower text | 10 |
| Leads with subscriber text | 20 |
| Leads with a stored qualification rejection reason | 0 |
| Failed leads with no usable linked address, using the application's shared suppression projection | 76 |
| Messages / active suppressions / outbound sends | 633 / 79 / 0 |

The existing AI context explicitly says `Tier: not recorded`. Pipeline tier/product-fit filters are placeholders, not evidence of a stored assessment. No mature-platform inference will be made from missing fields.

Code-audit findings verified in the relevant source:

- **Rejection handling is currently wrong for the requested rule:** inbound sync treats both `unsubscribe` and `not_interested` as suppressions, and automatically sets Lost. Part 1 will separate ordinary offer rejection from a true opt-out, retain an immediate no-automatic-follow-up hold and require founder confirmation for Lost. Existing suppressions will NOT be removed or reinterpreted in bulk (`src/lib/email/sync.ts:257`).
- **Category B cannot yet be saved through the agent schema**, which requires website and email. Final draft/reply recipient safety has no tier check. Both must be extended without opening any new send authority (`src/lib/agent/service.ts:60`, `src/lib/services/email-sending.ts:211`, `src/lib/services/conversations.ts:424`).
- **Duplicate checking misses archived records** and only takes one identity per platform. Discovery also puts social result URLs in the website field, risking a shared-domain collision between unrelated Instagram/YouTube/Telegram businesses. Canonical account identity must be separate from a business-owned website domain (`src/lib/services/prospects.ts:56`, `src/lib/services/research-engine.ts:519`).
- **Current targets count any verified lead with an email**, so the query and engine stop condition need the same new counted-lead predicate (`src/lib/services/research.ts:8`).
- **A recovered address can reactivate eligibility for follow-ups.** The recovery apply must set an explicit recovery hold using the existing exclusion mechanism, preserving its prior value/reason in the audit trail, before making a new address usable. Nothing automatically clears that hold (`src/lib/services/agent-followups.ts:79`).

Sources: `src/db/migrations/001_schema.sql:92`, `src/lib/types.ts`, `src/lib/ai/lead-context.ts:267`, `src/lib/services/folders.ts:137`, `scripts/legacy-import/pass-a.sql:47` and `:211`.

### Legacy archive

All reads used the existing reviewed database helper in a `BEGIN READ ONLY` transaction, followed by rollback. Only aggregate counts, schema keys and categorical/numeric assessment metadata were returned; no addresses, message bodies or lead rows were printed. An initial metadata query referenced a nonexistent `search_source` column and failed read-only; after reading migration 025, the corrected query used `search_provider_id` and succeeded. It made no changes.

| Archive material | Observed | Safe interpretation |
| --- | ---: | --- |
| Original prospect records | 584 | Current 578 include earlier approved merges/folds; no new merges proposed |
| Qualification assessments | 53 for 17 prospects | Historical decisions, not a modern lead tier |
| Assessment completeness | All 53 `PARTIAL` | Never present as complete modern qualification |
| Assessment qualification | 50 `VERIFY_FIRST`, 3 `NO` | Does not map directly to Tier 1 / Other |
| Stored `score_total` / `historical_total` | 0 populated | Cannot recover displayed 100/100 or 80+ from these totals |
| Component objects | 51 empty; 2 with `actual_signal_provider=12`, one also `reachability=10` | Insufficient to reconstruct weights or the old display calculation |
| Referenced rule versions | 1 distinct reference | The exported 47-table manifest contains no rule-definition table |
| Audience observations | 159 for 108 prospects | All carry source URLs and observed dates |
| Displayed, numeric observations | 34 | Others remain Unknown; never substitute zero |
| Product-fit evidence | 15 findings for 14 prospects: 4 PASS, 11 UNKNOWN | Not equivalent to modern High / Medium / Low |
| Contacts | 572 | 551 official emails; 11 official forms; 6 official Telegram DMs; 1 unknown-status Telegram DM; 3 official WhatsApp routes |
| Eligibility reviews | 5 | Preserve as historical decisions, including founder provenance |

Supported-platform audience observations: Instagram 81 (9 displayed, 72 unavailable), YouTube 69 (17 displayed, 8 not shown, 44 unavailable), Telegram 7 (6 displayed, 1 unavailable). Two other-platform observations stay in historical data and do not enter the requested audience priority.

There are isolated Tier 1/Tier 2 mentions in two evidence findings each, and Category B mentions in 11 findings. Mentions are not a formal definition. There are no tier/score display strings in the archived assessments, eligibility reviews or workspace payloads searched. The old Growth display/calculation source is not in this standalone repo. The main Nomeriq platform remains off-limits.

### Old Tier 2 → Category B hint (founder-approved)

The founder's original rules use “Category B / Tier 2” for alternative-contact prospects. So old Tier 2 is treated **only as a hint for Category B, confirmed by evidence**:

- Old Tier 2 **and** no published email (only Telegram, a form or another non-email route) → Category B, saved and never emailed.
- Old Tier 2 **and** a published business email found → re-assess normally under `lead-rules.md` (Tier 1, Other, or Email no website). The old label does not decide the modern tier.
- Anything else (no Tier 2 hint, or incomplete evidence) → re-assess from evidence only; unassessed stays unassessed with product fit Unknown.

Preserve the original label, score fragments, rule references, source assessment IDs, dates and founder decisions as legacy history. Original evidence is still required for every change: the old label never substitutes for a published email, paid-signal evidence, an eligible market or current activity, and audience unavailability is never proof of a small audience. No bulk mapping runs without the founder's approval of the previewed counts.

## 2. Approved decisions

### Established audience: at least 1,000 on one official Instagram or YouTube account (approved)

Use a verified single-account count, never totals. This is a modest reach/contactability threshold for a niche paid-signal business, not a measure of quality, paid subscribers or engagement. Telegram cannot promote a website/email lead to Tier 1. Unknown counts do not qualify as established. A verified founder override is preserved and displayed separately. Store date/freshness and reserve an engagement field, but do not invent engagement scoring now.

The founder approved this number on 7 Nov 2026. It applies only to new assessments; no existing lead changes merely because a field is absent, and nothing is backfilled from it without the approved preview.

### Priority rubric, out of 100 (approved)

No recoverable legacy formula was found, so this versioned replacement is used instead of pretending to reproduce it.

| Factor | Points |
| --- | --- |
| Product fit | High 70; Medium 45; Unknown 30 (provisional); Low 10 |
| Tier | Tier 1 10; Other 7; Email no website 3; Category B 0 |
| Largest single audience | Unknown 0; verified under 1,000: 1; 1,000–9,999: 2; 10,000–49,999: 4; 50,000–99,999: 6; 100,000+: 8 |
| Evidence completeness | One point per sourced/dated area: signal service, eligible markets, official contact route, official identity, delivery/infrastructure, app investigation, supported gap assessment; maximum 7 |
| Activity | Verified activity within 30 days: 5; within 90 days: 3; current official paid-service/join availability without a recent dated activity item: 1; insufficient evidence: 0 |

Fit is measured against need for Nomeriq's platform, so an **unchecked** lead (Unknown, 30) never ranks below one with a mature platform (Low, 10). That was the founder's reason for the ordering. Unknown is displayed as provisional, and the lead is shown as “fit needs research”, never as “Low fit” or as a claim that it lacks a platform.

Website/email tiers use Instagram/YouTube for audience points; Email no website and Category B use Instagram/YouTube/Telegram. Use the largest single verified account, never a sum. No score for Excluded. Entirely unassessed existing leads have no new score rather than a fabricated zero, and they keep their place in the list rather than sinking to the bottom.

Calculated examples: a High-fit Other provider with a small verified audience, complete evidence and current activity scores **90**; a Medium-fit Tier 1 with the largest audience, complete evidence and current activity scores **75**; an Unknown-fit lead with the same evidence scores **60**; the same prospect once assessed Low-fit scores **40**. A score is research/outreach ordering, never permission to send.

Effective founder overrides win. Automatic sorting uses effective score descending, fit as tie-breaker, evidence recency, then stable lead ID. Each assessment stores rubric version, breakdown, evidence and date so a later rule change cannot rewrite history. No quota counts derive from this score.

## 3. Proposed schema — review before implementation

Exact draft SQL: [`lead-model-migration-proposal.sql`](lead-model-migration-proposal.sql). It is deliberately outside `src/db/migrations/`; next unused number currently 030. **Not executed or yet rehearsed.** Recheck numbering before adding it.

Add five narrowly scoped tables:

1. `prospect_assessments`: versioned eligibility/tier/fit/maturity/app/gaps/confidence/priority snapshots with dated sourced findings, unknowns and original legacy references.
2. `prospect_audience_observations`: account/platform/count-or-Unknown/date/source observations; repeat observations preserve history.
3. `prospect_contact_route_observations`: every route found with platform/type/handle-or-URL/source/date/official status.
4. `prospect_assessment_overrides`: append-only founder set/clear decisions, separate from model observations. Services enforce founder identity and typed values; an override cannot manufacture evidence, turn Category B into a sendable lead without an official email, or bypass suppression/contact rules.
5. `prospect_rejection_recommendations`: original message reference, exact objection and reason for a Lost recommendation. Existence stops automatic follow-ups; no automatic outcome confirmation or unsubscribe.

Reuse `prospects`, `prospect_emails` (already has source URL, verified date), `prospect_sources`, aliases, audit log, founder notes, status and follow-up exclusion controls. No destructive rename, no alteration to an old migration, no legacy archive update, no backfill/default assessments in SQL. No new separate outcome framework, dashboard, enrichment service or learning store.

The service layer, not JSON sent by an agent, validates all findings, official-source links, dates and qualification checks. Current effective assessment is the latest accepted assessment plus founder overrides; an older imported assessment cannot displace a newer decision. Preserve imported founder decisions conservatively: do not infer an override from an agent's narrative. Existing leads get Unknown fit at read time when no modern assessment exists; this is not a bulk write or demotion.

Before approval to run live, prove SQL twice in isolated PGlite, exercise constraints and verify no existing rows/fields changed. A feature that reads these new tables must not deploy until its schema exists. Undo is the recorded, reviewed restoration of previous effective pointers/decisions while retaining history; no live restore/drop or destructive down-migration.

## 4. Ordered delivery and stop points

### Part 1 — lead model, visible sales prioritisation, guarded backfill

One final part-1 commit with tests after its review gates; local design work remains uncommitted until screenshot approval.

1. Approve this plan, threshold, rubric and migration SQL (done 7 Nov: approved, with old Tier 2 treated as a Category B hint confirmed by evidence).
2. Implement typed shared assessment/qualification/priority helpers. Check duplicates across **all** records including archived and excluded identities, aliases, names and non-generic emails, both before fetching and transactionally before saving. A match reuses/returns the existing business; it never silently revives an excluded or archived record. Resolve identity conflicts conservatively.
3. Wire model saving/reading and targets. Only new Tier 1/Other with all six requirements and official website/email count. Email no website uses the existing verified/outreach path when its business email and the other qualification evidence are verified, but has its own tier and is excluded from targets. Category B is saved but not counted; Excluded has a reason and is hidden from the normal lead list, without deleting records or hiding existing email history. Incomplete research is retained as unassessed/pending, never invented eligibility.
4. Enforce Category B refusal at the final send gate, including campaign/queued sends and old approved drafts, even if an email is later attached accidentally. Reassess it explicitly before changing tier. Implement explicit rejection detection/proposal, immediate automatic-follow-up hold and founder-only Lost confirmation; true opt-out continues through existing policy. Preserve old historical Lost decisions rather than reopening them.
5. Build shared coloured tier/fit/account-audience pills on leads list and profile, with tooltips, date, handle, count/Unknown, and overall priority. Add the short evidence-linked product-fit panel, missing-information list, filters and stable priority sort; no dashboards. Wire existing reserved pipeline tier/fit dimensions to the same model without changing historical conversation population.
6. **STOP: show local dev screenshots at 1280** (the founder's agreed size) from a proven-isolated throwaway user/database. Include High, Medium, Low, Unknown, multiple accounts, Category B, Email no website, long names and priority sorting. No live UI probes.
7. Prepare an idempotent legacy mapping preview using the archive only. Report rows/prospects proposed, evidence support, unassessed/ambiguous/skipped, affected founder overrides and before/after counts. Keep archive read-only. No inference that old PRODUCT_FIT PASS equals High, no bulk demotion, no reclassification from a missing field.
8. **STOP: founder reviews proposed legacy mapping and live-backfill counts.** Independent Claude review, isolated rehearsal, fresh verified backup and explicit approval precede the exact live backfill. Keep previous values/IDs for scoped undo; verify exact targets and unchanged suppressions/messages/queues after applying. A reviewed code deploy does not authorise its data writer.
9. Run typecheck, full tests and build; one part-1 commit. Review exact change, normal push and deploy through the unchanged reviewed deploy script with verified backup/readback, coordinating approved schema-before-code ordering. No sends/settings/provider tests/research starts by deployment.

### Part 2 — evidence-first research pipeline

One part-2 commit with tests and separately gated deploy.

- Discover candidates using the official DeepSeek provider's own built-in search (the assigned `Growth-Chat-Search` row) for now, as approved; Brave stays optional for later and no card or billing is needed. Check the query ledger first. Candidate identity duplicate check occurs **before any candidate page fetch**. Search results necessarily precede discovery of an unknown business; discovery is not permission to fetch or research an existing lead. Whichever search is used, our own queries and outcomes are recorded in the ledger, not the provider's raw result bodies.
- No model call for planning queries, extracting the initial candidate, reading pages, email extraction or evidence collection. Use bounded deterministic query templates, URL canonicalisation and parsers first. Re-check newly discovered identities before continuing and again before save.
- Fetch official homepage and linked relevant pricing/plans/VIP/signals/contact/about/terms/app pages; officially linked social/link pages and corroborated app-store listings. Check robots.txt, enforce small page/byte/time/redirect budgets, public-network/SSRF protections, per-origin polite pacing and backoff. No login/CAPTCHA bypass, checkout/join POST, subscription or contact action. Record blocked/unavailable, never treat them as absence.
- Stage the actual published emails, paid-signal/market/activity evidence, each audience account, every contact route, delivery/subscription/dashboard/publishing/performance/payment/app evidence, official-source linking and investigation gaps with URL/date. Mere words “VIP” or “premium,” copy trading alone, a working marketing site or a generic app name are insufficient proof.
- Only then call the selected model to confirm/describe/price/tier/assess fit, using a strict result schema validated against the collected sources. Model output cannot invent a source, claim that an uninspected feature is absent, relax qualification or override the founder. Unknown stays Unknown on insufficient technology evidence. A branded app alone is not Low fit.
- Save each decision under the correct tier/Excluded or pending investigation; duplicates return the existing business without incrementing targets. Enforce target/count logic in shared database-backed services, never the agent's claimed count.
- Preserve resumability, leases, spend caps, accurate per-operation/model provenance, actual cost accounting and visible unsupported-provider states. No automatic paid fallback beyond existing explicit authorisation. Dedicated search does not grant a chat provider a page-fetch capability it lacks.
- Run the same known-provider comparison after adapters are ready, with approved real-call budget, reporting found/verified/duplicate/cost and evidence quality. No real provider probe or account change in this planning pass.
- **SearXNG and Crawl4AI: possible later Oracle VPS sources only.** No install, host change or new service now.

### Part 3 — consistent agent skills and AI context

One part-3 commit with tests and reviewed deploy.

- Serve/package the same canonical `docs/lead-rules.md` content to Claude, ChatGPT, Gemini, Hermes and portal AI context, with a build/test parity check and version. A link alone is not enough for downloaded clients; include the canonical content in their generated downloads/instructions.
- Include the effective assessment, founder overrides, current software/delivery setup, evidence, gaps, checked sources/dates and confidence in the shared lead context. Extend Context used honestly.
- Before first-email generation, require an evidence-supported need/benefit choice. High fit: business outcome, not feature inventory. Mature platforms: no replacement pitch without an evidenced gap. Unknown setup: no assertion that something is missing. All claims remain limited to Product Truth.
- Update every actual drafting path, including legacy/deterministic fallback and research first-email preparation, not just the main model prompt. Do not generate a draft for Category B/Excluded or automatically send anything.
- Show any changes to repository `.agents/skills/` to the founder for explicit approval before commit (AGENTS rule 8). Download builders are application code; local installed third-party platform skills will not be silently modified.

### Separate recovery pass — 76 Failed leads

After the plan is approved and the official-source/no-AI collection path is ready:

1. Freeze the requested cohort as 76 distinct lead IDs; re-read current state before action and account for any intervening change. This is explicit re-research of existing businesses, not a “new leads” job; it must not be rejected as duplicate discovery or counted towards acquisition targets.
2. Research each official website and officially linked profile for a newly published business email. Confirm business ownership/source/date; reject guessed, junk, old bounced, suppressed or identity-conflicting addresses. No scraping behind login/CAPTCHA; unavailable is reported.
3. Produce a preview of recovered/unchanged/blocked/ambiguous/not-completed counts that sums to the original cohort. Preserve all original addresses, bounces, opt-outs, founder unlinks and business history.
4. Review/rehearse the exact additive apply with independent Claude review and fresh verified backup; save qualifying new addresses through an audited service with source URL and date, no unsuppression or replacement. Do not set a primary address without the established recipient policy, queue a message, restart a campaign or prepare follow-ups as a side effect.
5. Read back every added address and the actual computed folder. Unrecovered remain Failed. Other holds/opt-outs/outcomes still win; do not force a recovered lead into Waiting merely to improve a count. Report distinct leads with a newly verified usable address separately from leads actually leaving Failed. No recovery count is claimed yet.

## 5. Acceptance tests and safety gates

- Paid Telegram seller + basic website + evidenced platform gap => High.
- Website membership without a full platform => Medium or High according to evidence, not a site keyword.
- Fully integrated proprietary platform => Low unless a credible gap is evidenced.
- No technology evidence => Unknown; no claim that an app/platform is absent.
- Own app + weak remaining infrastructure => not automatically Low.
- Explicit partnership/integration/new-platform rejection, including CryptoAI Signal wording => exact original retained, Lost recommendation only, no automatic follow-up, no formal unsubscribe unless applicable.
- Founder override and old assessment history survive research/backfill/retries.
- Existing leads without new evidence remain untouched/unassessed, fit Unknown.
- Multi-account maxima, Unknown versus zero, dated approximate display, supported platforms only; no sums and no stale observation replacing a newer one.
- Category B refused at all final sending paths, including previously approved/queued drafts; Email no website never counted.
- All six counted-lead checks enforced consistently through engine, MCP, REST, UI and target completion; archived/excluded duplicates found before fetch and save, concurrent save race covered.
- Migration twice/no existing-row changes, correct target, strict founder permissions, no expanded agent scopes.
- Rejection parsing ignores quoted text, DSNs, vacation replies and ambiguous negation; true opt-out remains authoritative.
- Recovery: all 76 accounted for; add only sourced new addresses; no unlink/unsuppress/send/queue/automatic follow-up; actual final folders checked.
- Browser proof at 1280 (the founder's agreed size); list filters/counts/pagination/sort agree over the whole population.
- Each part: `npm run typecheck`, full `npm test`, `npm run build`, real counts reported; exact diff review, reviewed deploy, fresh verified backup, per-step checks and task note with undo. No deploy or live write after any failed check.

## 6. Search source (approved): the official DeepSeek provider now, Brave later and optional

The founder approved researching through the official DeepSeek provider's own built-in search — the assigned `Growth-Chat-Search` row — for now. Brave needs no card and no billing from the founder, and stays an optional, search-only source for later. The current engine accepts only the official DeepSeek adapter with known usage and pricing, so this needs no new provider work before Part 2.

Kept for when Brave is enabled, from its official docs checked during planning:

- [Pricing](https://api-dashboard.search.brave.com/documentation/pricing): Search is $5 per 1,000 requests with $5 recurring monthly credits.
- [FAQ](https://api-dashboard.search.brave.com/documentation/resources/help-feedback): no standalone free plan; a card is required, and prepaid/legacy postpaid and auto-reload have different overage behaviour. It also prohibits retaining API results without permission.

If Brave is ever enabled: the founder supplies and configures the key and account limits himself; no account or billing change is made by an agent; spend is hard-stopped before exhaustion; the query ledger records our own queries and outcomes; and only independently fetched official-source findings are persisted. Brave's snippets are not stored as evidence.

Current live metadata shows no Brave row: four provider rows (one DeepSeek both, three Custom); lead_research is assigned to DeepSeek with its own search. Native/OpenAI-compatible chat capability must not be mistaken for a working page reader. Account/key setup and any paid execution remain separate founder steps.

## Approved on 7 Nov 2026 — what remains a stop

The founder approved the plan, the proposed SQL, the 1,000 threshold, the rubric (with Unknown at 30, provisional), the Tier 2 → Category B hint, the DeepSeek-built-in-search choice, the not-interested change, and screenshots at 1280 only. This authorises local implementation (Parts 1–3), with two stops inside it: the screenshots, and the old-lead backfill numbers before anything touches live.

Every live step still goes through the charter's gate: independent reviewer approval of the exact change, a fresh verified backup, a check after every step, the task note with its undo — plus the founder's own separate yes for anything reaching a prospect, spending, secrets or an irreversible deletion.
