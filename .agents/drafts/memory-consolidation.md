# .agents/drafts/memory-consolidation.md — item 9

## Why this is a rewrite, not an append

Both memory files are effectively full: MEMORY.md is at **2,182 / 2,200 chars**, USER.md at
**1,361 / 1,375**. Nothing new fits without freeing space in the same operation, so this is
one atomic batch: patch the entries that changed, then add the new rules.

## The problem with the current memory

The live "Decision rights" entry says:

> Stop for approval only on: **pushing to GitHub**, **anything on AWS/the live server** …

That is now **wrong and would make me ask you about things the charter pre-approves**
(read-only live checks, non-force deploy pushes). Leaving it would silently contradict the
charter every session. It has to be replaced, not extended.

## Proposed MEMORY.md — exact operations

**1. REPLACE the "Decision rights" entry with:**

> Decision rights (Nomeriq Growth, per `.agents/charter.md`): I own engineering and
> verification, the founder owns decisions. Alone: code/tests/local work, read-only live
> checks (health, counts, ledger, timers, backups, journal), subagents, skills, scheduled
> read-only jobs, and non-force pushes to master on a deploy under docs/DEPLOYMENT.md once
> tests+build are green. Ask first: any live-data write, live migration, sending email,
> connecting a mailbox, deleting on the server, force-push, spending money, secrets, or
> editing AGENTS.md / the charter. Never turn approvals off.

**2. ADD:**

> Nomeriq Growth hard rules: the founder is not an engineer — bring decisions, not options
> dressed as questions; keep chats short and act on obvious defaults. Never touch the main
> Nomeriq platform project or its npm/node toolchain. No Telegram (blocked in Pakistan) —
> Discord is the report channel. Reports and logs carry counts, never row contents (lead
> names, emails, message bodies). The server's host key is already known: never pass
> StrictHostKeyChecking=no.

**3. COMPRESS the two long environment entries** (Bridge Command, Growth server) so the
batch fits — same facts, fewer words.

## Proposed USER.md — exact operation

**ADD:** *Founder prefers work shown before it is applied: draft files and config diffs for
review, flag which commands were only verified against a scratch copy, and stop rather than
test setup changes against the real Hermes home.*

## What will NOT go in memory

Procedures (deploy order, live-check steps, restore order) belong in the three **skills**,
not memory — memory is injected into every turn and must stay small. The server's IP, key
path and app user stay in memory as environment facts, but the *how* lives in the skills.
