# AGENTS.md — standing rules for this repository

These rules apply to every agent and every task in this repository. They are not suggestions.

## 1. Verify before you report

Run `npm run typecheck` and the full `npm test` suite before reporting any task complete, and put the real numbers in the report. If the change touches routes, middleware or the build, run `npm run build` as well. Never report success from memory or from a partial run.

## 2. No credentials, ever

Never write a password, API key, token, session secret or mailbox credential into README, docs, tests, fixtures, comments or any other committed file. `.env.example` holds empty placeholders only; real values live in `.env.local`, which is gitignored.

## 3. Migrations are append-only

New migrations take the next number in `src/db/migrations/` (currently `007`). Never edit, renumber or delete an existing migration; corrections ship as a new file. Every migration must be additive and safe to re-run.

## 4. DeepSeek rate limits stay at 5 or below

DeepSeek documents 5 requests per second per account for Search and for Fetch. The Settings UI, the settings validation and the database CHECK constraint must all refuse anything above 5. Do not raise these ceilings.

## 5. The MCP/agent boundary is fixed

No MCP tool may send email, delete records, change settings, or start, stop or cancel research jobs. Agents research, propose and save drafts; the founder approves and sends. Any new tool gets a narrow scope and the minimal default.

## 6. Scope comes from the plan

Follow `docs/Nomeriq-Growth-Plan.md` — the approved plan. It defines the phases, the folder and outcome model, and the known limits. Do not pull later-phase work — multi-provider DeepSeek support, bounce handling, the learning store — into an earlier phase without being asked.

The plan is replaced as a whole when a new approved version arrives, in a commit of its own, so its history stays readable. Never edit it in place as part of a feature change.
