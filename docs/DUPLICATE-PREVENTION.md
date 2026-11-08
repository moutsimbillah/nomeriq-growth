# Duplicate prevention and cleanup

## One server decision, not an agent ritual

- `check_duplicate` is one inexpensive lookup after triage, before deep research.
- Every save independently repeats the same check under a database lock. Skipping the early lookup
  cannot bypass protection. Database triggers also guard direct prospect, email, alias and audience
  identity writes. Archived records remain known.
- The resolver compares normalized website hosts, recorded name/aliases, specific emails and social
  accounts. It additionally compares business-email domains with websites and other business-email
  domains, including `support@` versus `info@` at the same company domain.
- Website normalization removes `www.`, a trailing dot, URL path and case differences. It does not
  guess that `.com` and `.co.uk`, different subdomains or similar names have the same owner.
- Known free/shared mailbox domains do not identify a business. The explicit list is in migration034's
  SQL helper, shared by lookup, write guards, send guards and audit. No DNS, AI or paid service is used.

## Results

| Result | Meaning |
| --- | --- |
| `created` | A genuinely new record was saved. |
| `already_exists` | A single existing record matches a strong recorded identity. No overwrite. |
| `review_required` | A domain/name-only overlap or several conflicting owners. Creation is blocked; all matches and reasons are returned. No ownership inference or automatic merge. |

For compatibility, a blocked save still returns `created:false`, `duplicate:true` and an existing
`prospect`; when `resolution` is `review_required`, that single `prospect` is not a selected owner.
Clients must show `matches`, not draft against an arbitrary first record. The shared MCP instructions
and portal do this. Agents cannot mark, archive, restore or delete leads.

## Before any actual delivery

First-contact, follow-up and conversation replies share a cross-lead guard. Another lead's recorded
contact address/business domain or website overlap holds new contact. Another lead already in contact
on those keys also holds it, including in-flight and uncertain send reservations. Exact addresses are
checked even for free mail; different users of the same free-mail provider do not match by domain.

Reservation checks and the new `sending` row share a short database transaction; no lock spans SMTP.
A newly typed contact association is recorded inside that transaction, so a racing duplicate refusal
rolls it back. Draft edit/approval also checks and records a newly typed address inside its own locked
transaction; a refusal or later edit failure leaves no new association. These operations do not create
a send reservation or send mail. The final check before transport remains in place. Existing approval, suppression,
qualification, sandbox/live, sender, budget and volume controls are not replaced or relaxed.

Legitimate same-lead replies/follow-ups/retries remain possible. A founder-linked duplicate cannot
send; its canonical lead treats the linked record's history as its own for this guard without moving
messages. An unrelated contacted lead still holds the canonical lead. A crash-left `sending` or
`uncertain` record deliberately fails closed until reconciled.

Linking a duplicate does not reset contact history: its prior messages/sends block another first-contact
email from the canonical record. Existing opt-outs, manual suppressions and the copy's pre-mark
do-not-contact flag still hold the canonical business. Keep the record with the working conversation
as canonical when cleaning up; history is linked for safety, not moved into a different conversation.
Real or undated replies, not-interested/unsubscribe classifications, rejection recommendations and
terminal pipeline stages on an active linked duplicate stop the canonical lead's follow-ups too,
whether recorded before or after the mark. The send gate, candidate listing and guarded agent draft
save share the same SQL policy. DSNs and dated automatic replies do not become human replies.

## Founder-only cleanup

On a lead, **Duplicate of…** selects the lead to keep, shows the consequences and requires confirmation.
It archives the copy, marks it do-not-contact, cancels unsent drafts, blocks queued sends and skips
queued campaign items. It preserves qualification, pipeline status, messages and prior states.
No address-wide suppression is created. Existing contact restrictions still apply. The canonical
record can add distinct inboxes at the resolved family domain and edit its identities; unrelated
families remain blocked. A specific mailbox already held by the copy stays there: attaching that
exact mailbox to the canonical record is explicitly refused, not silently reported as saved. No
contact or alias is automatically moved. New saves matching any member return its canonical owner.

The archived copy has a small page linking to the canonical record and **Restore lead**. Restore is
refused if the captured lead/draft/send/campaign state has changed. It restores lead visibility and
its previous do-not-contact/next-action values, but never revives cancelled work or queues/sends mail.
Snapshots retain database timestamp precision and remain available for audit. Self-links, chains,
inactive targets and in-flight sends are refused. No hard delete or automatic cleanup is included.
Restore updates `updated_at` to the restoration time, not the old timestamp. An intervening change
to any captured field (including `updated_at`) prevents the button from restoring; the snapshot is
retained for a separately reviewed, exact, additive/reversible correction, never an automatic SQL
undo. If canonical identities were added after the mark, restore can expose the old domain overlap
again; the audit and send guards then hold the unresolved pair. Cancelled work stays cancelled.

## One-time read-only scan

After migration034 is applied through the approved runner, the on-demand command is:

`node --import tsx scripts/audit-duplicates.ts`

It requires an explicitly selected database, forces auto-migration off and scans inside a READ ONLY
transaction. Default output is pair and affected-lead counts; `--details` adds IDs and reasons, never
message bodies. It does not mark, merge, suppress or delete anything, and is not scheduled.

## Limits and rollout

These checks enforce known recorded identities, not unknowable corporate ownership. Two brands with
no shared recorded website, email/domain, name or social identity can still evade matching. A shared
corporate domain can also belong to separate businesses; that ambiguity blocks creation/contact for
review instead of silently merging them. Existing overlaps are not rewritten by the migration.
The founder must confirm any cleanup; deploying code is not permission to drop existing leads.

Migration034 is additive/replay-safe, with no rewrite of prior leads/history and no destructive DDL.
Local PGlite/browser evidence and the synthetic multi-connection PostgreSQL rehearsal are not live
or deployed-browser proof. Deployment separately requires independent review, a verified fresh
backup, approved migration/restart procedure and readback. Its packet must first measure live overlap
pairs, the contacted subset, affected queued sends and open conversations read-only: unresolved
legacy overlaps can hold replies/follow-ups as well as first contact, and blocked queued work is not
automatically revived. Rollback must retain enforcement for any duplicate links written while live.
