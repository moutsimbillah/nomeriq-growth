# Growth Data Migration: Old to New

Nov 4, 2026 · Comparison and proposed plan, leads, emails and conversations only

## Verdict

The old portal holds far more than the new one: 584 leads, 432 sent emails across 431 leads, 57
permanent bounces, 89 threads with 13 replying leads, and a detailed, versioned history of evidence,
approvals and delivery. The new portal is simpler: one row per lead, one status, a short list of
sources. So this is not a copy. It is an import of the essentials into the new format, plus a full
read-only archive of everything else.

The single most important rule: the new portal must know who was already emailed before anything can
send. Its send gate decides "already contacted" only from outbound rows in messages. If the 431
contacted leads are imported without those rows, the new portal would let an agent draft, and you
approve, a second first-contact email to every one of them.

Until the import is verified: no new research, no mailbox connected, no sending.

## What each side has

| Area | Old portal | New portal | Result |
| --- | --- | --- | --- |
| Business record | display_name, no country, no notes column | business_name, country, notes, pricing, signal description | Match on name; country becomes Unknown |
| Website and socials | 9 platforms, each identity with a status (proposed, verified, conflicted, retired) | 4 platforms with unique keys, plus a free list of other socials | Old richer |
| Contact routes | Email, contact form, Instagram DM, Telegram DM, WhatsApp, Discord; official or not; verification and freshness checks | Email only, with its source URL | Old richer |
| Markets | Versioned, includes stocks and options | 5 markets, no stocks or options | Conflict |
| Audience | 159 dated snapshots per platform, displayed text, parsed count | One follower and one subscriber field, as text | Old richer |
| Evidence | 2,092 findings with kind, verdict, source and dates | Sources with URL, label, notes, date | Old richer |
| Qualification | Assessments with scores, gates, brand risk; eligibility reviews | candidate, verified or rejected | Old richer |
| Lead status | Separate dimensions: pipeline, disposition, outreach permission, policy, candidate | One status field with 10 values | Conflict |
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

1. 431 leads were contacted. Each must arrive with an outbound message row, or the first-contact
   block does not work. Dispatches marked UNKNOWN (4) or ATTEMPTED (1) must count as contacted too,
   because they may have been delivered.
2. 57 permanent bounces. Each bounced address becomes a suppression with reason bounce, so it lands
   in the Failed folder and can never be emailed again. The 306 "uncertain" holds are not bounces and
   must not become suppressions; they only count as contacted.
3. One unapplied opt-out suggestion. An assistant suggested OPT_OUT on one reply, and no one decided
   it. Review that reply before the import. If it is a real opt-out, it must be imported as one.
4. 4 "not interested" replies. The current skill stops all further contact after a not-interested
   reply. They import as status lost with do-not-contact on, with the reason in the notes.
5. The 4 leads already in the new portal may have been emailed by the old one. P4 Provider in
   particular appears in the old data. If a match was contacted, its new unsent draft must be
   discarded, not approved.
6. Duplicates inside the old data. 5 name groups (10 records), 1 identity group (2 records) and 4
   email addresses shared by 8 records. The new portal enforces unique identities, so these will
   either fail or wrongly merge. They need a decision per group before the import.
7. The old portal must be frozen first. If its sync, agents or schedulers keep writing during the
   export, the copy is out of date the moment it is made.

## How the fields map

### Leads

| Old | New | Rule |
| --- | --- | --- |
| display_name | business_name | Direct |
| identity domain, verified | website_url, domain_key | Only VERIFIED identities become unique keys |
| identity instagram, youtube, x, telegram, verified | the matching key and URL columns | Same rule |
| identity tiktok, facebook, discord, whatsapp, and any non-verified identity | other_socials | No uniqueness; kept for reference |
| contact route EMAIL, official | prospect_emails with its source URL | Primary = the address that was actually emailed, if any |
| non-email routes (DM, form, WhatsApp) | other_socials or research notes | Cannot be sent by the new email system |
| categories | categories | STOCKS and OPTIONS dropped and noted; a lead left with no supported market imports as a candidate |
| latest DISPLAYED audience snapshot per kind | follower_count, subscriber_count with date in notes | All snapshots kept in the archive |
| evidence findings with a URL | prospect_sources (URL, label, notes with kind and verdict, observed date) | Others summarised into evidence_summary |
| research client | source_agent (claude, chatgpt, unknown) | Channel becomes a new value, legacy import |
| none | country | Unknown |

### Status

The new status comes from the old pipeline and disposition together, and the folders then compute
themselves.

| Old | New status | Notes |
| --- | --- | --- |
| RESEARCH, eligible, official verified email | verified (qualification verified) | New leads folder |
| RESEARCH, otherwise (including 239 unclassified) | new (qualification candidate) | Not counted as leads until verified |
| OUTREACH with a sent or uncertain dispatch | contacted | Waiting folder |
| ENGAGED | replied or interested, from the reply classification | Needs reply or In conversation, from message times |
| CLOSED, disposition LOST, or NOT_INTERESTED | lost, do-not-contact on | Closed (lost) |
| disposition WON | won | None exist today |

### Emails and conversations

| Old | New | Rule |
| --- | --- | --- |
| dispatch SENT | messages outbound, delivery accepted; outbound_sends accepted | With Message-ID, date, recipient, mailbox |
| dispatch UNKNOWN or ATTEMPTED | messages outbound, delivery uncertain | Counts as contacted |
| dispatch FAILED | messages outbound, delivery failed | Does not count as contacted; check the address before any resend |
| permanent delivery notice | suppressions reason bounce, and messages delivery bounced | Per address |
| the approved version of each sent draft | drafts status sent, with sent date | The exact approved text, from the approval snapshot |
| unsent draft head for a never-contacted lead | drafts status draft, flagged for review | Written under old Product Truth |
| all other proposal and draft versions | archive | Not imported into the app |
| thread and its messages | one conversations row per lead, plus inbound messages | Last inbound and outbound times set from history |
| founder reply classification | conversations.classification | ASKS_TECHNICAL_QUESTION to technical, NOT_INTERESTED to not_interested, OTHER to other |
| reply excerpts and imported text | message body where available | Full bodies filled later from IONOS |

## What has no home in the new portal

Qualification assessments and scores, eligibility reviews, stage transitions, sequences with their
angle, wave and experiment, approval snapshots and fingerprints, revocations, intents, outreach
events, transport evidence, hold history, conversation links and attention, reply suggestions, sales
bindings and every superseded version.

Recommendation: import them unchanged into a separate read-only legacy schema in the new database,
minus the execution tokens Codex listed. The app ignores it, nothing is lost, and it stays queryable.
It is also exactly the data the learning phase will want: which angles got replies, which stages
stalled, why leads were lost.

The 3 inbound enquiries are warm leads (they contacted you). They should not be merged automatically.
Review them and add them by hand, or add an inbound-enquiry source type first.

## Sending stays simple: imported data is history, not rules

Leads and drafts reach the founder through a systematic process (research, verification, duplicate
checks, Product Truth), so sending must not add friction on top. The old portal's approval machinery
(intents, snapshots, fingerprints, revocations, holds, pre-flight blocks) is imported only as archived
history. None of it becomes a rule in the new portal.

- No confirmation dialogs. Reviewing a draft and pressing Send is one action. "Send all approved"
  sends the queue with one click, spread out within the daily limit.
- Your own replies send as written. Product Truth checks apply to AI-written drafts only, and show as
  notes, never as blocks.
- Warnings, not walls. Word count, a missing personal detail or a Product Truth note appear beside the
  draft and never stop a send.
- Only four automatic stops, with no click needed: an opted-out or suppressed address, a permanently
  bounced address, a second first-contact email to a lead already emailed (a follow-up is still
  allowed), and the daily sending limit during warm-up. Each one shows a short reason on the draft
  instead of asking for confirmation.
- No new hardcoded rule without your approval. Any future check is added as a visible setting you can
  switch off, not as a fixed rule in the code.
- Imported fields are information, not gates. Old scores, risk ratings, assessments and stage history
  are shown on the lead where useful, but never block a draft or a send.

## Changes the new portal needs before the import

1. A channel value for imported rows (legacy import) and a matching created_by_type, so imported
   leads are tagged honestly instead of as Claude or ChatGPT research.
2. The legacy archive schema.
3. Confirm the real uniqueness rule on prospect_emails. Hermes describes both a global unique and a
   partial one; the old data has 4 emails shared by 8 records, so the import fails or succeeds
   depending on which is live.
4. Confirm what mailbox sync does when a message row already exists with the same Message-ID: it must
   fill in the body, not skip or duplicate.
5. Conversations started from the old IONOS mailbox must stay on that mailbox. The per-conversation
   mailbox rule from the plan is not built yet; it is needed before any reply goes out.
6. Optional: the outcome field from the plan (rejected versus lost). Without it, not-interested
   replies import as lost.

## Open questions

### For Codex (old portal), read-only

- Is the old portal still running, and what writes to it (sync, schedulers, agents)? Can it be
  frozen?
- Of the 460 outreach intents, how many used each route (email, DM, form)? Were any sent outside
  email?
- Which mailbox address sent the 432 emails?
- Which of the 584 leads match the new portal's 4 (P4 Provider, Learn2Trade, Tawsiyat, Infinity
  Signals FX), and were any of them contacted?
- Can the export be produced as one JSON file per table plus a dump of the archive tables, without
  the token columns, with row counts and checksums?

### For Hermes (new portal), read-only

- The exact live uniqueness indexes on prospect_emails.
- Mailbox sync behaviour on an existing Message-ID.

### For you

- The one reply with an unapplied OPT_OUT suggestion: opt-out or not?
- Each duplicate group: merge into one business, or keep separate?
- The 3 inbound enquiries: add them, and how?

## Protecting the live platform during the export

The old Growth tables appear to live in the same free-plan Supabase project that runs the Nomeriq
platform and the demos already sent to prospects. The export must never slow it down or take it
offline. The data is small (roughly 12,000 rows across the Growth tables, likely a few megabytes), so
a single careful read is light.

- Read once, then work from files. The export runs one time. Every dry run, comparison and retry
  reads the exported files, never Supabase again.
- One connection, one table at a time. No parallel jobs. Each table is read with its own query, with
  a short pause between tables.
- Read-only, and never blocking. One REPEATABLE READ, READ ONLY transaction for a consistent
  snapshot, with statement_timeout around 30 seconds and lock_timeout around 1 second. Plain reads
  take only the weakest lock, which never blocks the platform's normal reads and writes.
- Only the Growth tables. Nothing from the platform: no tenants, users, auth, demo data or settings.
- Columns chosen at the source. Each table is exported with an explicit column list, so the execution
  tokens Codex listed are never read at all.
- A quiet hour. Run it when the demos are least likely to be in use, and check first that the
  platform is healthy.
- Freeze Growth only. Stopping the old Growth portal's own sync, schedulers and agents must not stop
  anything on the platform. If they share code or a process, Codex confirms how to pause only Growth.
- Stop on any sign of strain. If a query is slow or the platform's health check falters, the export
  stops and nothing retries automatically.
- The files hold personal data. They are moved straight to the new server over SSH, kept in a
  protected folder, and deleted from the PC afterwards.

## Import plan

1. Freeze the old portal's writers and take final counts.
2. Decide the open founder questions above.
3. Export from the old portal once, following the rules in Protecting the live platform, without
   token columns, with counts and checksums.
4. Prepare the new portal: the migration for the legacy channel and archive schema, and the two
   confirmations.
5. Dry run on a throwaway copy of the new database, then a reconciliation report: every count in this
   document matched, every bounced address suppressed, every contacted lead blocked from a
   first-contact send (checked with a dry-run gate call, never a send), and no duplicates created.
6. Live import, after your approval and a fresh database dump, in this order: suppressions and
   do-not-contact, then leads with identities, emails and sources (merging with the existing 4), then
   conversations and messages, then drafts, then the archive.
7. Verify on live with the same reconciliation report.
8. Later, in the email phase: connect the IONOS mailbox and sync it to fill in full email bodies.

The new research and sending pause until step 7 passes.
