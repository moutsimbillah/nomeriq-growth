# Email Phase — Next (Scope Record)

Status: **founder-confirmed scope, 2026-11-05.** This file records agreed scope only.
It is **not** implementation, and it does **not** amend the approved plan. The source of
truth for the folder/outcome model and known limits remains `docs/Nomeriq-Growth-Plan.md`,
which must **not** be modified by this work (nor `AGENTS.md`).

## First item of the next email phase: replace the capped replies Inbox

Replace the current capped replies Inbox with an **eleven-folder Inbox**.

### Folders

`opted_out`, `failed`, `rejected`, `won`, `closed_lost`, `meeting`, `needs_reply`,
`to_approve`, `in_conversation`, `waiting`, `new_leads`.

- `new_leads` renders under the user-facing label **"Not contacted"**.

### Placement contract

- All conversations are considered **in the DB before pagination** — counts and folder
  membership are computed over the full set, never over a page.
- Each conversation lands in **exactly one folder per provider**, chosen by the **approved
  precedence** in the plan; the eleven folders must partition the non-archived set.
- **Archived** conversations are held **separate** from the eleven folders.
- Candidate folder rules are the ones already in the approved plan; this record does not
  invent new rules.

### Views

- Filters carry **all-row counts**, and **cross-axis counts are correct** (a filter's count
  reflects the active other-axis selection, not a stale whole-table total).
- **URL state** and **pagination**: folder, filters and page live in the URL and survive
  reload/share.
- Axes include **sender / agent / channel / added** (with timezone).

## Explicit model decisions — review required before build

The **outcome/rejected model** decisions are **not** settled here and must be **reviewed and
approved before any build**. The current model is pure and **cannot emit `rejected`**; the
`rejected` folder therefore cannot be correctly populated without an explicit, reviewed
decision. Treat this as an open gate, not an implementation detail.

## Design first (blocking gate)

Before implementing the folder Inbox:

1. **Inventory** the current behaviour and **agree the SQL / count contract** and the
   **information architecture**.
2. Produce **local-dev mockups/screenshots** using a **throwaway test user**, at **desktop
   and mobile**.
3. **Founder reviews and approves the screenshots** — approval happens **before** any folder
   Inbox implementation starts.

No implementation begins until screenshot approval is recorded.

## Acceptance criteria

- **Independent SQL tests** covering every folder and **every filter single and pair**,
  including datasets **> 150 rows**, plus **partition invariants** (exactly one folder per
  conversation per provider; folders + archived cover the full set with no loss/duplication).
- **No email send capability for agents** (MCP/agent boundary unchanged: research, propose,
  save drafts only).
- **No live-data screenshots** — mockups use the throwaway test user only.
- Deploy only under the **DEPLOYMENT** procedure: backup, target, ledger, and **migration SQL
  approval**.

## Current batch scope

This batch verifies the **existing Inbox service** and the **pure folder rules only**. The
missing **folder UI, API, count, facet and pagination** are **NOT built here**.

## Explicit non-goals

- No edit to `docs/Nomeriq-Growth-Plan.md`.
- No edit to `AGENTS.md`.
