# Mailbox recovery — Waiting for founder

## Approval boundary

The founder approved overnight engineering, tests, a committed read-only IMAP inspector and code-only deployment. This is **not** approval for a fuller live sync, a historical bounce/suppression pass, automatic or manual live address linking, changed settings, a mailbox connection, a migration or any send.

Deploying code must not initiate any of those operations. Research and sending timers are not approval to run recovery. Automatic follow-ups stay off. No new sync timer is installed.

## Current evidence

The read-only database report found 18 fetched messages: 14 inbound and 4 Sent. Only 2 of the original 19 excerpt-only bodies were filled; all 8 originally unmatched inbound messages are now attached to leads. One different inbound remains unmatched. Three stored permanent delivery reports already correspond to suppressed addresses. These are portal counts, not whole-mailbox totals.

### Read-only IMAP inspector — run 2026-11-06 23:53 UTC on `6a9d574`

Coverage is complete for every retained message in `INBOX` (161) and `Sent Items` (361): 522 messages, no parse failures, no oversized skips. `Drafts`, `Spam` and `Trash` exist and were listed only. Database counts were identical before and after (491 messages, 62 suppressions, 3 bounce events, 0 sends). No flags, imports, links, suppressions, settings, translations or sends.

Both OnwardBTC replies (17 Oct 19:25 EDT, 24 Oct 05:47 EDT) are in Sent Items, each matched to the OnwardBTC thread by headers, and neither is in the portal.

| Needs reply lead | Your replies in mailbox | Missing from portal | Missing and later than their last message | After full import |
| --- | --: | --: | --: | --- |
| OnwardBTC | 3 | 3 | 2 | Waiting |
| Forex Cipher | 2 | 1 | 1 | Waiting |
| NeverSleep Forex Signals | 2 | 1 | 1 | Waiting |
| Scope Signals | 3 | 2 | 1 | Waiting |
| Zak FX Hub Academy | 3 | 2 | 1 | Waiting |
| Forexearlywarning | 4 | 2 | 0 | Needs reply |
| CryptoSense AI | 1 | 0 | 0 | Needs reply |
| FXPULSE | 3 | 0 | 0 | Needs reply |
| Money Bells | 1 | 0 | 0 | Needs reply |
| Y7Signals | 1 | 0 | 0 | Needs reply |

Every missing reply sits inside the old 30-day window, in the main Sent folder, on a header-matched thread. That points to the newest-40 cap, but the cap's historical membership cannot be reconstructed, so the reason is recorded as probable, not proven. The exact "51 skipped" breakdown was never stored.

Excerpt bodies: of the original 19, the mailbox holds a full body for 14; 3 of those still differ from the portal; 5 are not found or ambiguous. All 8 originally unmatched inbound messages are matched.

Delivery reports: 77, all permanent, 0 temporary, 0 complaints, 0 unattributable. 60 addresses already suppressed; **17 would be newly suppressed** by the historical pass. 3 reports are already recorded. 7 automatic replies were excluded. The inspector's first run undercounted reports (2) because a real report marked "auto-replied" was treated as out-of-office; that was fixed and tested before this run.

Other addresses: 55 inbound messages come from addresses on no lead. 4 sit in a known lead's thread (OnwardBTC 2, Y7Signals 1, NeverSleep Forex Signals 1) — thread matched, address **not** linked. 3 have only a signature-name hint (2 name "Muhammad Moutsim Billah", 1 "P4 Provider") and need your review. 48 have no candidate.

## Founder acceptance case

Both messages must first be observed by the read-only inspector in **Sent Items**:

| Lead | Founder-supplied local time | UTC instant |
| --- | --- | --- |
| OnwardBTC | 17 Oct 2026, 19:25 EDT | 2026-10-17T23:25:00Z |
| OnwardBTC | 24 Oct 2026, 05:47 EDT | 2026-10-24T09:47:00Z |

The local full-sync regression must include these messages behind more than 40 newer Sent messages, with no 30-day history restriction, match both to the existing OnwardBTC conversation, preserve Message-ID/UID idempotency, and recompute actual message chronology. When the last real message is the founder's outbound, the requested folder is **Waiting**, not Needs reply. A genuine later inbound must still require a response; never force a folder against recorded chronology.

The same comparison must cover every current Needs reply lead, not only OnwardBTC. Mailbox presence is not a claim that a live import happened.

## Waiting actions — do not execute overnight

### 1. Fuller import-only sync

Before approval, present the inspector's complete/incomplete coverage, actual folders, missing outbound counts per lead and available full excerpt-body counts.

Proposed recovery:

- Read every retained message in the founder-approved Inbox and Sent folders, using bounded/resumable pages, not a newest-40 or last-30-days selection.
- Match unique thread headers first; use conservative address plus normalized-subject evidence for fallback, refusing ambiguity.
- Deduplicate by stored mailbox identity and Message-ID. Replace only demonstrably excerpt-only/blank placeholders with the complete fetched body; preserve existing complete bodies and founder work.
- Recompute inbound/outbound clocks from event dates so replay order cannot make an older inbound beat a newer founder reply.
- Do not append Sent copies, translate, generate drafts, send, apply new address links or apply historical suppressions as an accidental side effect of the recovery import.
- Read back the two exact OnwardBTC messages and the resulting folder, plus every other affected Needs reply lead. Report unresolved/ambiguous cases rather than guessing.

### 2. Address linking

Present candidate lead names, counts and evidence/confidence before any live linking. Delivery-report senders are not prospect aliases. Certain thread matches and probable domain/signature matches must remain distinguishable. Preserve first-contact and current-writing addresses; record founder link/unlink/rejection/preferred-recipient decisions in the audit log. No MCP tool gains these powers.

### 3. Historical bounce pass

Present whole-mailbox permanent/temporary/complaint/unattributed report counts, distinct addresses already suppressed, newly affected addresses and unmatched-lead counts before approval. Repeat reports must not create duplicate bounce records or count as new soft-bounce attempts. Out-of-office/vacation responses are not bounces. Preserve whole-lead opt-outs while treating a dead address separately from another viable linked address.

### 4. Sending

No send is part of this approval. The founder separately approves any test or real send. Sandbox and automatic-follow-up settings are not changed by this work.

## Scheduled-sync audit

Read-only checks found no `growth-cron-sync.timer`; it is not installed/active. Root, growth and ubuntu have no crontabs. `/etc/crontab` and `/etc/cron.d` contain no reference to `/api/cron/sync`. The repository's Vercel schedule includes research and follow-ups only; no sync reference was found in this growth profile's cron definitions.

An authenticated `/api/cron/sync` endpoint exists but its presence is not proof of a schedule. In the currently deployed implementation, a call processes the oldest-synced eligible profiles, default maximum three, and invokes the existing sync routine. That routine can import/fill messages, rematch, record/suppress delivery failures, pause a bouncing profile, append Sent copies and trigger translation. It does not invoke SMTP. No such call was made by the agent during the audit; arbitrary external callers cannot be ruled out by local timer checks alone.
