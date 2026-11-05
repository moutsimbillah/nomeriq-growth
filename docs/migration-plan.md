# Growth Data Migration: Old to New

Nov 4, 2026 · Comparison and proposed plan, leads, emails and conversations only

## Verdict

The old portal holds far more than the new one: 584 leads, 432 sent emails across 431 leads, 57 permanent bounces, 89 threads with 13 replying leads, and a detailed, versioned history of evidence, approvals and delivery. The new portal is simpler: one row per lead, one status, a short list of sources. So this is not a copy. It is an import of the essentials into the new format, plus a full read-only archive of everything else.

The single most important rule: **the new portal must know who was already emailed before anything can send.** Its send gate decides "already contacted" only from outbound rows in `messages`. If the 431 contacted leads are imported without those rows, the new portal would let an agent draft, and you approve, a second first-contact email to every one of them.

Until the import is verified: no new research, no mailbox connected, no sending.

## What each side has

| Area | Old portal | New portal | Result |
| --- | --- | --- | --- |
| Business record | `display_name`, no country, no notes column | `business_name`, `country`, notes, pricing, signal description | Match on name; country becomes Unknown |
| Website and socials | 9 platforms, each identity with a status (proposed, verified, conflicted, retired) | 4 platforms with unique keys, plus a free list of other socials | Old richer |
| Contact routes | Email, contact form, Instagram DM, Telegram DM, WhatsApp, Discord; official or not; verification and freshness checks | Email only, with its source URL | Old richer |
| Markets | Versioned, includes stocks and options | 5 markets, no stocks or options | Conflict |
| Audience | 159 dated snapshots per platform, displayed text, parsed count | One follower and one subscriber field, as text | Old richer |
| Evidence | 2,092 findings with kind, verdict, source and dates | Sources with URL, label, notes, date | Old richer |
| Qualification | Assessments with scores, gates, brand risk; eligibility reviews | candidate, verified or rejected | Old richer |
| Lead status | Separate dimensions: pipeline, disposition, outreach permission, policy, candidate | One `status` field with 10 values | Conflict |
| Stage history | 442 recorded transitions | None | Old only |
| Drafts | 1,400 proposal versions, 471 draft versions, sequences with angle and wave | One first-contact draft per lead, follow-ups, revision history | Old richer |
| Approvals | Exact approved version, snapshot, fingerprint, revocations | Approved flag and time | Old richer |
| Sending | Dispatches with states, Message-ID, transport evidence, Sent-copy state | Outbound sends with states and Message-ID | Close match |
| Bounces | 57 permanent notices; 380 hold records (mostly uncertain) | Bounce stored as a suppression | Mapping needed |
| Mailbox index | 487 messages (126 Inbox, 361 Sent) with folder, UID, Message-ID, links | Messages with folder, UID, Message-ID | Close match |
| Threads | 89 threads, 108 thread messages, 100 conversation links | One conversation per lead | Mapping needed |
| Reply handling | 7 founder-classified replies, 16 excerpts, AI suggestions | Classification on the conversation | Mapping needed |
| Email bodies | Mostly not stored; headers and excerpts only | Full bodies when synced | Bodies must come from IONOS |
| Opt-outs | 0 applied | Suppressions plus do-not-contact | Nothing to move, see one flag below |
| Origin | Research client CLAUDE, CHATGPT or UNKNOWN | Agent and channel tags | Match, needs a legacy channel value |
| Inbound enquiries | 3 separate records (people who contacted you) with country and subscriber estimate | No equivalent | Old only |
| Research engine, ledger, OAuth, outcome audit | None | Yes | New only, not affected |

## Safety-critical findings

1. **431 leads were contacted.** Each must arrive with an outbound message row, or the first-contact block does not work. Dispatches marked UNKNOWN (4) or ATTEMPTED (1) must count as contacted too, because they may have been delivered.
2. **57 permanent bounces.** Each bounced address becomes a suppression with reason bounce, so it lands in the Failed folder and can never be emailed again. The 306 "uncertain" holds are not bounces and must not become suppressions; they only count as contacted.
3. **One unapplied opt-out suggestion.** An assistant suggested OPT\_OUT on one reply, and no one decided it. Review that reply before the import. If it is a real opt-out, it must be imported as one.
4. **4 "not interested" replies.** The current skill stops all further contact after a not-interested reply. They import as status lost with do-not-contact on, with the reason in the notes.
5. **The 4 leads already in the new portal may have been emailed by the old one.** P4 Provider in particular appears in the old data. If a match was contacted, its new unsent draft must be discarded, not approved.
6. **Duplicates inside the old data.** 5 name groups (10 records), 1 identity group (2 records) and 4 email addresses shared by 8 records. The new portal enforces unique identities, so these will either fail or wrongly merge. They need a decision per group before the import.
7. **The old portal must be frozen first.** If its sync, agents or schedulers keep writing during the export, the copy is out of date the moment it is made.

## How the fields map

**Leads**

| Old | New | Rule |
| --- | --- | --- |
| `display_name` | `business_name` | Direct |
| identity `domain`, verified | `website_url`, `domain_key` | Only VERIFIED identities become unique keys |
| identity `instagram`, `youtube`, `x`, `telegram`, verified | the matching key and URL columns | Same rule |
| identity `tiktok`, `facebook`, `discord`, `whatsapp`, and any non-verified identity | `other_socials` | No uniqueness; kept for reference |
| contact route EMAIL, official | `prospect_emails` with its source URL | Primary = the address that was actually emailed, if any |
| non-email routes (DM, form, WhatsApp) | `other_socials` or research notes | Cannot be sent by the new email system |
| categories | `categories` | STOCKS and OPTIONS dropped and noted; a lead left with no supported market imports as a candidate |
| latest DISPLAYED audience snapshot per kind | `follower_count`, `subscriber_count` with date in notes | All snapshots kept in the archive |
| evidence findings with a URL | `prospect_sources` (URL, label, notes with kind and verdict, observed date) | Others summarised into `evidence_summary` |
| research client | `source_agent` (claude, chatgpt, unknown) | Channel becomes a new value, legacy import |
| none | `country` | Unknown |

**Status.** The new `status` comes from the old pipeline and disposition together, and the folders then compute themselves.

| Old | New status | Notes |
| --- | --- | --- |
| RESEARCH, eligible, official verified email | verified (qualification verified) | New leads folder |
| RESEARCH, otherwise (including 239 unclassified) | new (qualification candidate) | Not counted as leads until verified |
| OUTREACH with a sent or uncertain dispatch | contacted | Waiting folder |
| ENGAGED | replied or interested, from the reply classification | Needs reply or In conversation, from message times |
| CLOSED, disposition LOST, or NOT\_INTERESTED | lost, do-not-contact on | Closed (lost) |
| disposition WON | won | None exist today |

**Emails and conversations**

| Old | New | Rule |
| --- | --- | --- |
| dispatch SENT | `messages` outbound, delivery accepted; `outbound_sends` accepted | With Message-ID, date, recipient, mailbox |
| dispatch UNKNOWN or ATTEMPTED | `messages` outbound, delivery uncertain | Counts as contacted |
| dispatch FAILED | `messages` outbound, delivery failed | Does not count as contacted; check the address before any resend |
| permanent delivery notice | `suppressions` reason bounce, and `messages` delivery bounced | Per address |
| the approved version of each sent draft | `drafts` status sent, with sent date | The exact approved text, from the approval snapshot |
| unsent draft head for a never-contacted lead | `drafts` status draft, flagged for review | Written under old Product Truth |
| all other proposal and draft versions | archive | Not imported into the app |
| thread and its messages | one `conversations` row per lead, plus inbound `messages` | Last inbound and outbound times set from history |
| founder reply classification | `conversations.classification` | ASKS\_TECHNICAL\_QUESTION to technical, NOT\_INTERESTED to not\_interested, OTHER to other |
| reply excerpts and imported text | message body where available | Full bodies filled later from IONOS |

## What has no home in the new portal

Qualification assessments and scores, eligibility reviews, stage transitions, sequences with their angle, wave and experiment, approval snapshots and fingerprints, revocations, intents, outreach events, transport evidence, hold history, conversation links and attention, reply suggestions, sales bindings and every superseded version.

Recommendation: **import them unchanged into a separate read-only `legacy` schema in the new database**, minus the execution tokens Codex listed. The app ignores it, nothing is lost, and it stays queryable. It is also exactly the data the learning phase will want: which angles got replies, which stages stalled, why leads were lost.

The 3 inbound enquiries are warm leads (they contacted you). They should not be merged automatically. Review them and add them by hand, or add an inbound-enquiry source type first.

## Sending stays simple: imported data is history, not rules

Leads and drafts reach the founder through a systematic process (research, verification, duplicate checks, Product Truth), so sending must not add friction on top. The old portal's approval machinery (intents, snapshots, fingerprints, revocations, holds, pre-flight blocks) is imported only as archived history. None of it becomes a rule in the new portal.

- **No confirmation dialogs.** Reviewing a draft and pressing Send is one action. "Send all approved" sends the queue with one click, spread out within the daily limit.
- **Your own replies send as written.** Product Truth checks apply to AI-written drafts only, and show as notes, never as blocks.
- **Warnings, not walls.** Word count, a missing personal detail or a Product Truth note appear beside the draft and never stop a send.
- **Only five automatic stops, with no click needed:** an opted-out or suppressed address, a permanently bounced address, a second first-contact email to a lead already emailed (a follow-up is still allowed), the daily sending limit during warm-up, and an automatic follow-up to a lead who has already replied (answer in the conversation instead). Each one shows a short reason on the draft instead of asking for confirmation.
- **No new hardcoded rule without your approval.** Any future check is added as a visible setting you can switch off, not as a fixed rule in the code.
- **Imported fields are information, not gates.** Old scores, risk ratings, assessments and stage history are shown on the lead where useful, but never block a draft or a send.

## Review findings and decisions (4 Nov)

**Old portal (from Codex)**

- Growth shares the platform's Supabase project ("Nomeriq V-3.3", Free plan, Nano compute with 0.5 GB RAM, Tokyo, no read replica). The project itself must never be paused or restarted for this.
- All 53 Growth tables together are 19.3 MiB on disk. A single careful read is light.
- Live writers: the `growth-mailbox-five-minutes` database job, the campaign email worker (`nomeriq-email`, still polling, 9 campaigns paused, none active), two old-Growth agent principals, founder actions in the old portal, and a legacy cron endpoint. Platform enquiry and order hooks can also write `enterprise_contact_requests`; those stay untouched, and the read-only snapshot keeps the export consistent anyway.
- **Freeze for the export window:** deactivate only the Growth mailbox job and the mailbox's background flag, drain and stop only the `nomeriq-email` worker, disable the two old-Growth agent principals, and keep old-portal sessions closed. Nothing on the platform is paused.
- **Export role decision:** use the existing `supabase_read_only_user` (read-only by default) with explicit, reviewed column lists that leave out every token column. Creating a narrower role would mean new roles and row-security policies on the shared production database, which is a bigger change than the risk it removes for one supervised read.
- **After cutover, the old portal's sending is switched off for good** (worker stopped, campaigns cancelled, mailbox job removed), so two systems can never email the same people.

**New portal (from Hermes)**

- **The "already contacted" check reads `messages.prospect_id`.** Every imported outbound message must carry `prospect_id`, or all 431 leads stay sendable.
- **The follow-up check compares `messages.created_at`.** Imported messages must set `created_at` to the real sent or received time, never the import time.
- **Mailbox sync skips a message whose Message-ID already exists** and never fills in its body. Decision: create the old IONOS mailbox as an email account first (not connected, no password), attach every imported message to it, and change sync so that when a message already exists with an empty body, it fills the body and headers in.
- **Conversations have no mailbox column.** Add one, so a thread started from the old IONOS mailbox always replies from it.
- **Only one first-contact draft per lead is allowed, whatever its status.** For the 4 leads already in the new portal, an old sent email is folded into the existing draft row (status sent), never inserted beside it.
- **History goes into `messages` only, not `outbound_sends`,** so old sends never count against the daily limit.
- **Status and qualification are separate columns.** Both are set on import; folders read only `status`.
- **Aliases matter:** they feed the duplicate check and are globally unique, so they are imported, and each duplicate name group needs an alias decision too.
- **Two businesses can never share a live identity.** "Keep separate" means archiving one of them.
- **The new channel value appears in six places** (two database checks, `created_by_type`, and four lists in the app). All must change together.

**Sending friction (current code versus Sending stays simple)**

| Today | Decision |
| --- | --- |
| A "Send this email to a real prospect?" dialog on every send | Remove. The preview stays on the page; Send sends |
| An uncertain delivery blocks the draft until resolved by hand in IONOS | Count it as sent (so no repeat first contact), show a note, no manual step |
| A recipient you correct by hand is refused | Allowed when you type it; saved as a founder-entered address. AI drafts still cannot change the recipient |
| A follow-up is blocked once they have replied | Keep, as the fifth automatic stop; the follow-up is cancelled and you answer in the conversation |
| A follow-up with no conversation is refused | Keep as an internal check; the interface never offers that case |
| Too soon after the last send returns an error | Queue it and send automatically when the gap has passed, like campaigns already do |

## Founder decisions (confirmed 5 Nov)

**Opt-out.** Freezed Apps (Coresignals, `apps@freezedapps.com`) replied "UNSUBSCRIBE" on 29 Oct. Nothing is changed in the old portal: the lead is already Closed / Lost, all old campaigns are paused, and old sending is switched off at cutover. The import adds the address directly to the new portal's suppressions with reason opt\_out and sets do-not-contact, as an explicit import rule.

**Duplicates.** Each pair below is merged into one business. The domain that holds the contact email and history is kept; the other domain becomes an alias and a note; both records' history is kept on the merged lead.

| Business | Kept domain | Folded in |
| --- | --- | --- |
| AitechID | aitech.id (info@aitech.id) | sys.aitech.id |
| CoinCodeCap Signals | coincodecap.com | signals.coincodecap.com |
| Green Signals | greensignalss.com (info@greensignalss.com) | greensignalss.net |
| SignalXpress | signalxpress.com | market.signalxpress.com |
| The Gold Index Club | thegoldindexclub.co.za | thegoldindexclub.vercel.app (a development site) |
| US30 Trading Lab | us30tradinglab.com | us30fxtradealerts.com, with "US30 FX Trade Alerts" as an alias |

Pride Trading Academy and Research Aim are not duplicates; their unverified YouTube handles import as other socials, not as identity keys. There are no valid identity collisions.

**Inbound enquiries.** All 3 are test submissions. They are not imported.

**The 4 leads already in the new portal.**

| Lead | Old portal history | Decision |
| --- | --- | --- |
| P4 Provider | Emailed `collab@p4provider.com` on 15 Oct | The new unsent draft is replaced by the old sent email (status sent); the lead becomes contacted. `collab@` is added as a second address. |
| Tawsiyat | Emailed `support@tawsiyat.com` on 14 Oct | Same: becomes contacted with the old sent email. Still a weak lead (no published price). |
| Learn2Trade | No recorded send | Keep the new lead and draft; merge old evidence into it. |
| Infinity Signals FX | No recorded send | Same as Learn2Trade. |

**Sending profiles.** The new portal supports several sending profiles, each with its own mailbox, display name, signature, reply-to address, daily limit and warm-up state:

- `moutsim@nomeriq.com` for every lead the old portal contacted. All 432 old emails went from it, so their follow-ups and replies continue from it and stay in the same threads.
- A nomeriq.info mailbox for new outreach.

Each lead is pinned to the profile that first contacted it; that profile is used automatically for every later email to that lead and shown beside Send. New leads use the default profile. The founder can change a lead's profile with one choice on the lead, never through a confirmation step. Daily limits and warm-up count per profile.

Caution: follow-ups to the roughly 430 old leads go out from the main nomeriq.com domain, which the platform also depends on. Keep that profile's daily limit low and stop it if bounces or spam complaints rise.

**Not imported:** the 3 test enquiries with their notes and stage history, email diagnostics, mailbox connection records and sync checkpoints (rebuilt by the new portal's own sync), and every token column.

## Sending profiles (confirmed 5 Nov)

The new portal supports several sending profiles, one per mailbox, and every lead is tied to one of them.

- **A profile** is a connected mailbox with its own display name, signature, reply-to, daily limit and warm-up state. To start: `moutsim@nomeriq.com` (the old portal's sender) and the new nomeriq.info mailbox.
- **Every lead has an assigned sending profile.** Imported leads that were already emailed get `moutsim@nomeriq.com`, the mailbox that sent their first email, so every follow-up and reply comes from the same address and lands in the same thread. New leads get the default profile (nomeriq.info).
- **Pinned after the first send.** Before a lead's first email you can change its profile with one click. After it, the profile stays fixed for that lead, its conversation and its follow-ups, so a prospect never hears from two addresses.
- **Visible and filterable.** A sender pill on each lead (beside the agent pill), on the lead page header, on every draft and on each conversation, plus an "All senders" filter with counts on the Leads list, Email > Drafts and the inbox folders, combinable with the agent, channel and date filters.
- **Limits are per profile.** Daily limits and warm-up apply to each mailbox separately.
- **Reputation note.** `moutsim@nomeriq.com` is on the main nomeriq.com domain that also carries the platform's own mail. It is used for the leads it already emailed; new cold outreach goes from nomeriq.info, so a bad week of cold email can never hurt the platform's deliverability.

## Changes the new portal needs before the import

1. A channel value for imported rows (legacy import) and a matching `created_by_type`, so imported leads are tagged honestly instead of as Claude or ChatGPT research.
2. The `legacy` archive schema.
3. Confirm the real uniqueness rule on `prospect_emails`. Hermes describes both a global unique and a partial one; the old data has 4 emails shared by 8 records, so the import fails or succeeds depending on which is live.
4. Confirm what mailbox sync does when a message row already exists with the same Message-ID: it must fill in the body, not skip or duplicate.
5. Conversations started from the old IONOS mailbox must stay on that mailbox. The per-conversation mailbox rule from the plan is not built yet; it is needed before any reply goes out.
6. Optional: the outcome field from the plan (rejected versus lost). Without it, not-interested replies import as lost.

## Open questions

**For Codex (old portal), read-only:**

- Is the old portal still running, and what writes to it (sync, schedulers, agents)? Can it be frozen?
- Of the 460 outreach intents, how many used each route (email, DM, form)? Were any sent outside email?
- Which mailbox address sent the 432 emails?
- Which of the 584 leads match the new portal's 4 (P4 Provider, Learn2Trade, Tawsiyat, Infinity Signals FX), and were any of them contacted?
- Can the export be produced as one JSON file per table plus a dump of the archive tables, without the token columns, with row counts and checksums?

**For Hermes (new portal), read-only:**

- The exact live uniqueness indexes on `prospect_emails`.
- Mailbox sync behaviour on an existing Message-ID.

**For you:**

- The one reply with an unapplied OPT\_OUT suggestion: opt-out or not?
- Each duplicate group: merge into one business, or keep separate?
- The 3 inbound enquiries: add them, and how?

## Protecting the live platform during the export

The old Growth tables appear to live in the same free-plan Supabase project that runs the Nomeriq platform and the demos already sent to prospects. The export must never slow it down or take it offline. The data is small (roughly 12,000 rows across the Growth tables, likely a few megabytes), so a single careful read is light.

- **Read once, then work from files.** The export runs one time. Every dry run, comparison and retry reads the exported files, never Supabase again.
- **One connection, one table at a time.** No parallel jobs. Each table is read with its own query, with a short pause between tables.
- **Read-only, and never blocking.** One `REPEATABLE READ, READ ONLY` transaction for a consistent snapshot, with `statement_timeout` around 30 seconds and `lock_timeout` around 1 second. Plain reads take only the weakest lock, which never blocks the platform's normal reads and writes.
- **Only the Growth tables.** Nothing from the platform: no tenants, users, auth, demo data or settings.
- **Columns chosen at the source.** Each table is exported with an explicit column list, so the execution tokens Codex listed are never read at all.
- **A quiet hour.** Run it when the demos are least likely to be in use, and check first that the platform is healthy.
- **Freeze Growth only.** Stopping the old Growth portal's own sync, schedulers and agents must not stop anything on the platform. If they share code or a process, Codex confirms how to pause only Growth.
- **Stop on any sign of strain.** If a query is slow or the platform's health check falters, the export stops and nothing retries automatically.
- **The files hold personal data.** They are moved straight to the new server over SSH, kept in a protected folder, and deleted from the PC afterwards.

## Import plan

1. **Freeze** the old portal's writers and take final counts.
2. **Decide** the open founder questions above.
3. **Export from the old portal once, following the rules in Protecting the live platform, without token columns, with counts and checksums**
4. **Prepare** the new portal: the migration for the legacy channel and archive schema, and the two confirmations.
5. **Dry run** on a throwaway copy of the new database, then a reconciliation report: every count in this document matched, every bounced address suppressed, every contacted lead blocked from a first-contact send (checked with a dry-run gate call, never a send), and no duplicates created.
6. **Live import**, after your approval and a fresh database dump, in this order: suppressions and do-not-contact, then leads with identities, emails and sources (merging with the existing 4), then conversations and messages, then drafts, then the archive.
7. **Verify** on live with the same reconciliation report.
8. **Later, in the email phase:** connect the IONOS mailbox and sync it to fill in full email bodies.

The new research and sending pause until step 7 passes.

## Identity keys (approved 5 Nov 2026)

A `VERIFIED` or `PROPOSED` identity becomes a unique key on the lead — one key per platform, in the
`domain_key`, `instagram_key`, `youtube_key`, `x_key` and `telegram_key` columns. Only an identity that is
`CONFLICTED` or `RETIRED` is written to `other_socials` instead, so it is kept without claiming a key it may
not own.

Codex measured zero valid collisions. Any collision the import finds is **reported, and the second one goes
to `other_socials` — never merged**, because merging two businesses' accounts is worse than a lead missing a
key. Two malformed YouTube handles (Pride Trading Academy, Research Aim) are stored in `other_socials` for
the same reason: they are not usable as keys.

Non-email contact routes are not identity keys: the 11 contact forms, 7 Telegram DMs and 3 WhatsApp routes
go to `other_socials`, or into research notes where they carry context a key cannot hold.

## The live import window (approved 5 Nov 2026)

One window, in this order, with no step skipped:

1. `pg_dump` the live database into `/var/backups/growth` and report the file and its size.
2. **Deploy `master` to the server** — before the import, in the same window, after the backup. The portal
   code and the schema it expects must be live before rows are written into it, so the import runs against
   the same build that will read the data afterwards.
3. Migrations 017, 018 and 019, applied explicitly and verified in the copy's order.
4. Pass A, then pass B, then `archive-read-only.sql` — the lock goes last and is proven by attempting each
   write as the application's role, because a fresh restore has no lock until that step runs.
5. Pass C as the acceptance report, read-only apart from one transaction that is rolled back.

`moutsim@nomeriq.com` stays unconnected for the whole window, so nothing can send while history is written.
Connecting it afterwards is what fills the 19 excerpt-only bodies and matches the 8 unmatched inbound rows.
