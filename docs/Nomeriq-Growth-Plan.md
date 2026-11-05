# Nomeriq Growth — Independent System Plan

Nov 3, 2026 · Final version, signed off after code review

## Summary

Nomeriq Growth becomes a standalone sales system on nomeriq.info that finds signal providers, drafts outreach, manages replies and tracks deals, with no technical link to the Nomeriq platform. The goal it serves is the first 5 white-label tenants.

It runs on one small AWS server paid by the existing credit for the next 11 months. One automated agent does research; Claude and ChatGPT join interactively through the same Growth MCP. A deterministic backend, not the AI, controls sending.

| Layer | Choice |
| --- | --- |
| Domain | nomeriq.info (portal at growth.nomeriq.info, sending mailbox on the same domain) |
| Server | One AWS Lightsail 4 GB instance (or EC2 t4g.medium in Mumbai) |
| Database | PostgreSQL on the same server, daily backups to S3 |
| Agent access | The existing Growth MCP, moved onto the new server |
| Automated agent | The portal's built-in DeepSeek research engine (Hermes optional later) |
| Research | DeepSeek Search and Fetch APIs |
| Interactive agents | Claude and ChatGPT through the Growth MCP |
| Email | A mailbox on nomeriq.info, IMAP/SMTP, warmed up before outreach |
| Meetings | A booking link (Cal.com or Calendly) |

## Starting point: the local build

The plan builds on the local Growth portal (Next.js, its own repository, zero platform imports, 86 passing tests) rather than starting over. It already covers the hardest parts; the work is deployment, the email experience, and the learning layer.

| Keep as built | Change | Add (not built yet) |
| --- | --- | --- |
| Separate repo, own login, no platform code | Host on Lightsail with real PostgreSQL instead of Vercel and local PGlite | Bounce handling: Failed folder and auto-suppression of hard bounces |
| Database-enforced duplicate prevention, normalization, 15-minute claims | Support several DeepSeek-compatible providers in Settings, with the official api.deepseek.com kept as one of them | Scheduled mailbox sync (it is manual today) |
| DeepSeek research engine: durable, budget-capped, resumable | Email page: status folders and a three-pane layout instead of tabs | Outcome reasons for won, lost and rejected |
| MCP and REST with scoped keys; no key can send or delete | Thread view: chat-style bubbles; hide the repeated footer in history | Lessons and voice-rule store, weekly digest |
| Approve-then-send chain, idempotency, suppression, daily cap | API keys: expiry, rate limits, minimal default scopes, no wildcard CORS | Research ledger across jobs (wire the unused research_queries table), source yield, coverage map |
| Email threading headers, unmatched-mail view | Remove the published local password; add a route guard | Model fallback switches (OpenRouter) |
| Product Truth with version history | Fix fonts, scrolling and popup centering; add list pagination | Second mailbox for existing IONOS threads |

**Hermes is not needed for v1.** The built-in DeepSeek engine already does the scheduled, durable research Hermes was meant for, and learning lives in PostgreSQL. Hermes stays optional later as another MCP client.

**Fix one setting before going live.** The Settings page and the database both allow DeepSeek limits up to 100 and 25 QPS; DeepSeek's documented limit is 5 per second per account for Search and for Fetch. Correct the label and the database limit; the configured 2 and 1 are safe.

### Order of work

**Day one, before any code:** set up the nomeriq.info mailbox, SPF, DKIM and DMARC, and start warm-up. Warm-up takes 3–4 weeks and gates the first real sends, so its clock must start first.

1. **Safety first (hours):** QPS label and database limit, key expiry, minimal default scopes, per-key rate limits, no wildcard CORS, a route guard, remove the published password and the outdated test count from the README, and a server scheduler (host cron or systemd timer using CRON_SECRET, with logs and a failure alert) starting with research and follow-ups, with mailbox sync and the weekly digest added as they are built, because Vercel's scheduler won't exist on Lightsail.
2. **Research:** wire the research ledger first (small), then multi-provider DeepSeek support (larger: a new provider table, ordered failover, usage per provider).
3. **Email:** one folder per provider computed from the existing status fields, then the three-pane layout. Add the sticky sender per thread, the Sent-folder copy, bounce handling and scheduled sync. Remove won and lost from the lead-page stage dropdown and its API, so the status buttons are the only writer. Re-capture the screenshots at the end of this step.
4. **Learning last:** outcome reasons, lessons and voice rules, shaped by real results once emails are going out.

### Implementation notes from the code review

- When outcome becomes the authority, change the dashboard's won count (`dashboard.ts:40`) to read the outcome field in the same change, or Tenants won reads zero.
- Every automatic path that writes `status = 'lost'` today must write the outcome field instead: mailbox sync (`sync.ts:272`), do-not-contact (`conversations.ts:245`), unsubscribe token and manual suppression (`suppressions.ts:42`, `:104`).
- The archive path (`prospects.ts:823`) must stop writing lost.
- On the new server, do the pg_dump and restore drill first, not last.

## What 100% separate means

Growth shares nothing with the Nomeriq platform: no shared code, database, login, data feed or API. If Growth breaks, gets hacked or burns its email reputation, the platform and its tenants are untouched.

| Area | Growth | Nomeriq platform |
| --- | --- | --- |
| Code | Its own repository | Unchanged |
| Database | Its own PostgreSQL on AWS | Supabase, unchanged |
| Login | Its own founder login | Platform auth, unchanged |
| Domain | nomeriq.info | nomeriq.com |
| Email | Sending mailbox on nomeriq.info | Transactional mail on nomeriq.com |
| Hosting | AWS, paid by the credit | Current hosting, unchanged |
| API keys | Separate DeepSeek, OpenAI, Anthropic keys | Not shared |

**Product Truth is entered by hand.** You type what Nomeriq can truthfully claim into Growth and update it when the platform changes; nothing is read from the platform. Any integration, such as Nominate demand, is out of scope until Growth works fully on its own.

## Architecture

Agents never touch the database or the mailbox directly; they only call the Growth MCP, which enforces identity checks and saves.

```
 Outside agents
        ┌──────────────┐        ┌──────────────────────┐
        │ Claude       │        │ ChatGPT              │
        │ interactive  │        │ interactive, optional│
        └──────┬───────┘        └──────────┬───────────┘
 AWS server (Lightsail 4 GB)               │
 ┌─────────────┼───────────────────────────┼──────────────────────────┐
 │             ▼                           ▼                          │
 │  Growth MCP / API: identity lookup · atomic saves · claims · drafts │
 │                     │                                               │
 │  DeepSeek engine ─► PostgreSQL ◄─► Backend ◄─► Growth Portal        │
 │  scheduled research source of      sending,    approve and reply    │
 │  budget-capped      truth, backup  suppression growth.nomeriq.info  │
 │                     to S3          follow-ups                       │
 └─────────┬────────────────▲──────────────┬──────────────▲───────────┘
           ▼                │              ▼              │
   DeepSeek APIs      Product Truth     Mailboxes        You (founder)
   Search, Fetch,     entered by you,   nomeriq.info +   approve, send,
   models, several    no platform link  IONOS, IMAP in,  reply, close deals
   providers                            SMTP out
```

The research engine runs inside the portal on the server; only Claude and ChatGPT come from outside, and they reach Growth only through the MCP. Only the backend talks to the mailboxes, and only after your approval or inside a campaign you approved.

## Portal experience

The portal replaces the IONOS webmail entirely: you read, reply, approve and send from one screen, and every email lives in a conversation. Start from the local build's interface, which works well, fix its font, scrolling and popup-position issues, then add what's below.

**Sending takes one click**

- AI drafts land in a To approve queue. Each shows the provider, the reason it qualified and the draft.
- Edit inline if needed, then Send. Or tick several and Send approved, within the daily warm-up limit.
- Replies are written in the conversation itself, not in a separate tool. A suggested reply is pre-filled; you edit or replace it.
- New outreach sends from nomeriq.info. Each conversation is pinned to the mailbox of its first sent email (migrated threads take the mailbox of their earliest sent message), and the reply box shows that mailbox above Send. After each send, the next mailbox sync looks for that email's Message-ID in Sent; only if it isn't there does Growth add the copy, so webmail stays in sync without duplicates. Each email is marked once its Sent copy is confirmed, so it is never checked again.

**Every email is a conversation**

- One thread per provider, oldest at the top, newest at the bottom, like a chat. Their messages on the left, yours on the right.
- A side panel shows the provider card: website, socials, evidence and where it was found.
- Status buttons on the thread: Meeting or proposal, Won, Closed (lost), Rejected, Opted out.
- Search by name, domain or email from anywhere.

**Outcomes are kept apart from active work**

Every provider is in exactly one folder at a time, so nothing gets lost or counted twice. Each provider gets one explicit outcome field (won, lost, rejected, opted out), written by the status buttons and by mailbox sync; outcome folders read that field instead of guessing from suppression reasons. Sync writes only unambiguous results: an unsubscribe sets opted out, and a bounce lands in Failed. A not-interested reply stops all further contact, and the AI proposes the outcome for you to confirm: rejected if it is their first reply and you haven't replied yet, otherwise lost. Outcome is the authority for outcome folders and counts; status is only the stage. Won and lost can be set only through the outcome path, and archiving sets neither. When several rules apply, the first match in this order wins.

| Order | Folder | Rule | Group |
| --- | --- | --- | --- |
| 1 | Opted out | Outcome is opted out | Outcome |
| 2 | Failed | Bounced delivery or bounce suppression (shown once bounce handling ships) | Problem |
| 3 | Rejected | Outcome is rejected | Outcome |
| 4 | Won | Outcome is won | Outcome |
| 5 | Closed (lost) | Outcome is lost | Outcome |
| 6 | Meeting or proposal | Status demo or proposal | Active |
| 7 | Needs reply | Their message is the latest one | Active |
| 8 | To approve | A draft is waiting for your Send, including follow-ups | Active |
| 9 | In conversation | Status interested, or they have replied at least once and your message was sent last | Active |
| 10 | Waiting | Sent, no reply yet, no draft waiting | Active |
| 11 | New leads | Verified, no draft yet | Active |

Archived providers appear only in an Archived view. Unverified candidates stay on the Research page and never enter the email folders. Stages like Meeting or proposal move only when you press the status button; the AI can suggest the stage from the reply, and you confirm it with one click.

**Inbox layout (sketch, not final design):** three panes. Left: folders grouped as Active, Outcomes and Problems. Middle: search box and the conversation list for the selected folder. Right: provider name and card links, status buttons, the chat-style thread, and a reply box with a pre-filled suggestion and a Send button.

## Moving existing data

All existing Growth data moves to the new AWS database and appears in the new portal from day one. Only Growth's own tables move; platform data and platform logins stay where they are.

| Data | Moves | Shows in the portal as |
| --- | --- | --- |
| Leads, identities, evidence, contacts | Yes | Provider cards and folders |
| Drafts and your edit history | Yes | To approve queue, voice-rule history |
| Contact history and outcomes | Yes | The right folder per provider (Waiting, Rejected, Closed and so on) |
| Suppression and opt-out list | Yes, first | Never contacted again |
| Lessons, voice rules, Product Truth | Yes | Learning and settings pages |
| Old emails in your IONOS mailbox | Imported over IMAP | Full conversation threads, matched to each provider |
| Platform data and platform logins | No | Not in Growth |

**Existing conversations keep their address.** Providers you already emailed from your IONOS address keep hearing from that address, so their threads don't break. The portal connects both mailboxes: the old one for existing threads, nomeriq.info for new outreach.

**How the move is done and verified**

1. Pause the old Growth portal briefly so nothing changes mid-copy.
2. Copy the old database with a full database dump (pg_dump), not the app's backup download, which deliberately skips secrets and the research-engine tables.
3. Verify: row counts and checksums per table match, every provider has the same status, and the suppression list is complete.
4. Import the IONOS mailbox history and match each email to its provider.
5. Run the old portal read-only for about a week as a safety net, then switch it off.

Nothing is deleted from the old system until the new one has been checked.

## Agents and duplicate prevention

Start with one automated agent; the database, not the agents, guarantees no duplicates. More agents can be added later without changing anything below.

| Agent | Role in v1 | Cost |
| --- | --- | --- |
| Built-in DeepSeek engine | Scheduled research, qualification, first drafts | DeepSeek usage only |
| Claude | Interactive: hard cases, reviews, reply prep | Your existing subscription |
| ChatGPT | Interactive, optional | Your existing subscription |
| OpenAI / Anthropic API workers | Not in v1 | None |

**How every save stays unique**

1. Keep the built identity model: one column per platform (domain, Instagram, YouTube, X, Telegram), each with its own unique index, plus unique aliases. New platforms can be added later without rewriting it.
2. Before researching a candidate, the agent calls identity lookup. A match means stop and reuse the existing record.
3. Saves are "insert, or return the existing ID." If two agents find the same provider at once, only one record exists and the second agent gets its ID.
4. Generic role inboxes (info@, support@, contact@ and similar) never identify a provider on their own, as already built. The list lives in one code constant, and a test checks that the database index contains exactly that list.
5. An agent working on a provider holds a short claim that expires, so a crashed session never blocks it.
6. Lead counts come from saved database rows, never from what an agent reports.

A candidate counts as a new lead only when it sells signals in Forex, Metals, Crypto, Indices or Commodities, has a publicly published business email, has saved source URLs, and passes the uniqueness check.

## MCP tools and skills

Every agent works through one Growth MCP (also offered as REST for ChatGPT) and reads one shared skill document, so Claude, ChatGPT and any later agent follow the same rules. No MCP tool can send email, delete records, change settings or start and stop research jobs; those stay with you in the portal.

**Tools that exist today (15)**

| Group | Tools |
| --- | --- |
| Instructions | get_instructions (returns the shared skill) |
| Product Truth | read_product_truth (read-only) |
| Research | list_research_jobs, get_research_job, report_progress |
| Leads | search_prospects, get_prospect, check_duplicate, save_prospect |
| Drafts | save_draft (keeps your edits) |
| Conversations | list_conversations, get_conversation, get_conversation_context |
| Suggestions | suggest_reply, suggest_follow_up (suggest only, never send) |

**Tools to add as each phase lands**

| Phase | Tool | Purpose |
| --- | --- | --- |
| 2. Research | check_search_query, record_search_query | Read and write the research ledger, so no agent repeats a search within 30 days |
| 3. Email | get_folder_counts, list_folder | Read the 11 folders, so agents see who is waiting, rejected or opted out |
| 4. Learning | read_lessons | Approved lessons and voice rules, read before drafting |
| 4. Learning | propose_lesson, propose_outcome | Proposals only; you approve them in the portal |

Each new tool gets its own narrow scope, and keys keep the minimal default.

**The shared skill document**

One document, served by get_instructions and as an MCP resource (nomeriq://assistant-skill), tells every agent the rules: the qualification test, check before research, generic inboxes never identify a provider, Product Truth only, never invent emails, outcomes are proposals. It is updated in the same change as each phase, so agents never follow old rules.

**Connecting Claude and ChatGPT to the new server**

- After deployment the endpoint becomes https://growth.nomeriq.info/api/mcp. Each agent gets its own key with an expiry and minimal scopes.
- The current Claude connector and Nomeriq Growth skill point to the original portal's MCP, whose tool names differ (for example lead_identity_lookup there, check_duplicate in the local build). At cutover, update the connector address and rewrite the Claude skill to the new tool names.
- ChatGPT connects through the OpenAPI schema at /api/agent/openapi with its own key.
- The reel-scripts and organic-growth skills are content tools, not part of Growth, and are unaffected.

## Email on nomeriq.info

Deliverability is the biggest risk in this plan, so warm-up starts first and volume stays low. Spam filters are sometimes stricter with .info domains, which makes each step below matter more.

- **Domain home:** nomeriq.info hosts a Nomeriq white-label demo tenant with the same branding. It makes the domain look real and doubles as a live demo link in outreach. Only DNS is shared; the Growth server stays separate.
- **Authentication:** SPF, DKIM and DMARC set up before the first email.
- **Mailbox:** one founder mailbox (for example moutsim@nomeriq.info). Confirm the provider's terms allow one-to-one B2B outreach; IONOS restricts unsolicited commercial mail.
- **Warm-up:** 3–4 weeks, starting at 5–10 emails a day and rising to 20–30.
- **Message style:** plain text, one-to-one, personalized, one question, an opt-out line.
- **Suppression:** anyone who replies, opts out or bounces is never contacted again by any agent.
- **Threading:** follow-ups and replies keep proper email threads.
- **Best opener:** a specific detail from the provider's own public offer, followed by one question.

Check the cold-email rules for the countries you'll contact; this plan is not legal advice.

## Safety and permissions

AI researches and drafts; you approve and send. Agents read untrusted websites and emails, so nothing they read can trigger a send, a delete or a settings change.

| Action | Who can do it |
| --- | --- |
| Research, qualify, save leads | Any agent |
| Draft first emails and replies | Any agent |
| Approve and send an email | You (backend sends after approval) |
| Scheduled follow-ups | Backend, only inside a campaign you approved |
| Delete records, change settings | You only |
| Commercial commitments (price, terms) | You only |

- Every agent key gets only the scopes it needs, plus an expiry; no key can send, delete or change settings.
- The MCP endpoint accepts calls only from your agents (no wildcard CORS), with per-key rate limits.
- The database is never exposed to the internet; HTTPS only for the portal.
- API keys live in server secrets, with a monthly spending limit on each AI provider.
- Product Truth governs every AI draft. Your own replies send as you wrote them.

## Memory and learning

Growth learns from every outcome and from its own search history, and keeps that learning in PostgreSQL so every agent shares it. Procedures, such as how to research a provider, live in the research engine and the shared skill document.

| Layer | What it holds | Where it lives | Who changes it |
| --- | --- | --- | --- |
| Records | Leads, evidence, conversations, outcomes, search history | PostgreSQL | The system, automatically |
| Lessons | What gets replies, voice rules from your edits, good and bad sources | PostgreSQL | AI proposes, you approve |
| Procedures | How to research, how to find a published email | Engine code and shared skill, in git | You and your coder |

**Learning from what already happened**

Every outcome carries a reason, stored in an outcome reason field beside the outcome. The AI suggests the reason from the thread; you confirm it with one click when you press the status button.

| Outcome or event | What it records | What it learns |
| --- | --- | --- |
| Won | The full path: opener, replies, meeting | The pattern to repeat with similar providers |
| Replied | Opener, category, country | Which approaches start conversations |
| Went quiet mid-conversation | Your last message, the stage, days since | Which messages stall talks; when to follow up |
| Closed (lost) | Stage reached, the stated reason | Objections to answer earlier, or segments to skip |
| Rejected at first contact | Reason: not a fit, already has a platform, price, none given | Tighter qualification and targeting |
| No reply to first email | Approach, subject, timing | What to stop doing |
| Failed (bounced) | Where the email address came from | Which email sources are unreliable |
| Opted out | Nothing beyond the suppression entry | Never contacted again |

A weekly digest reads the outcome field together with the message and draft history (replied, went quiet and no reply are events, not outcomes) and turns them into proposed lessons with their evidence. Approved lessons are read by every agent before drafting or choosing who to target.

**Finding new leads, not the same ones**

- **Search log:** every query, source and date is saved. Agents check it first and don't repeat a query within 30 days (default).
- **Seen list:** every candidate ever looked at stays recorded, including ones that didn't qualify and why, so they are never re-researched. Unqualified ones are rechecked only after 90 days (default).
- **Source yield:** each query and source is scored on new qualified leads found, versus already-known ones. Queries that only return known leads are retired.
- **Coverage map:** tracks which signal categories, countries, languages and platforms (websites, Telegram, YouTube, Instagram, directories) have been searched, so new runs go to the gaps.
- **Lookalikes:** each won or replying provider seeds new searches in the same niche, country and language.
- **Switch, don't dig:** when new leads per 100 searches falls below a set level, research moves to a fresh segment.

**Guardrails**

- No reply-rate lesson until an approach has about 30–40 sends.
- Nothing an agent reads on a website or in an email becomes a rule on its own; only approved lessons and Product Truth guide drafts.
- Lessons can be retired when newer results contradict them.

## Model fallback (optional)

Fallback is off by default and controlled by switches on a Settings page in the portal. When a switch is off and DeepSeek fails, jobs wait in the database and retry; nothing is lost.

| Switch | Default | When on |
| --- | --- | --- |
| Low-balance alert | On | You're alerted when DeepSeek credit drops below a set amount |
| Paid fallback for research | Off | Research and qualification move to a cheap paid model through OpenRouter |
| Free fallback for research | Off | After the paid fallback, research can use OpenRouter free models, within their daily limits |
| Fallback for drafts and replies | Off | Drafting uses the paid fallback model; free models are never used for drafts |
| Require no-data-retention providers | On | Requests containing email content only go to providers that don't keep data |

Each switch also has a monthly spending cap. The portal shows which model is active right now and when a fallback was last used.

**DeepSeek providers**

For now research runs on several DeepSeek-compatible providers (third-party gateways), with the official DeepSeek API kept in Settings so you can switch to it later without code changes.

- Settings lists each provider with its own key, base URL, model, Search and Fetch paths, and a Test button. The official api.deepseek.com entry stays there, configured but optional.
- You set the order. If the first provider fails or its credit ends, the engine moves to the next one.
- Each provider has its own budget and its own Search and Fetch rate limits, capped at 5 per second each in the database.
- Each lead and draft records which provider and model produced it, so quality can be compared. Drafts already store the model; leads need new provider and model columns, left empty for the 2 existing leads.
- A third-party gateway sees your key and everything sent through it. Use a separate key per provider, and turn on the no-data-retention switch for anything containing email content.
- A provider is used only after its Test passes for model, Search and Fetch.

**Rules that apply whatever the switches say**

- Every output passes the same checks: evidence URLs, published email, Product Truth.
- Each lead and draft records the model that made it, so learning can compare quality by model.
- Only normal API keys are connected. No coding-tool subscriptions, OAuth free tiers or client-disguising features (OmniRoute's stealth options stay off if OmniRoute is ever used).

## Costs

AWS costs about $25 a month, roughly $275 over the 11 months left on the $500 credit, so the server costs no cash until the credit expires. Cash spending is AI usage and email, about $10–50 a month.

| Item | Monthly (USD) | Paid by |
| --- | --- | --- |
| Lightsail 4 GB server (IPv4, 80 GB disk, transfer included) | $24 | AWS credit |
| S3 backups | under $1 | AWS credit |
| DeepSeek models | $5–40, depends on research volume | Cash |
| DeepSeek Search and Fetch | $0.75 per 1,000 calls each | Cash |
| Sending mailbox on nomeriq.info | depends on provider | Cash |
| nomeriq.info domain renewal | about $1 (yearly fee spread out) | Cash |
| Claude and ChatGPT | existing subscriptions | Already paid |

- Equal-cost alternative: EC2 t4g.medium in Mumbai, about $16 for compute plus about $8 for IP, disk and backups.
- About $225 of credit would go unused. Upgrade to the 8 GB plan ($44) only if memory runs short.
- Avoid for now: managed database (RDS, about $23+), NAT gateway (about $30+), load balancer (about $16+).
- Set an AWS Budget alert at $30 a month, and check whether the credit covers Lightsail before choosing it.

Sources: [Lightsail pricing](https://aws.amazon.com/lightsail/pricing), [t4g.medium regional prices](https://aws-pricing.com/t4g.medium.html), [DeepSeek Search and Fetch pricing](https://www.eesel.ai/blog/deepseek-search-api)

## Build phases

Four phases over about six weeks, each closed by a gate that must pass before the next starts. Warm-up begins in week 1 because it is the slowest step.

| Phase | When | Work |
| --- | --- | --- |
| 1. Foundation | Week 1 | DNS + warm-up start, Lightsail server, PostgreSQL + backups and restore drill, deploy local build, safety fixes (QPS label and limit, key expiry, minimal scopes, rate limits, CORS allowlist, route guard, README), server scheduler |
| 2. Research engine | Weeks 2–3 | Multiple DeepSeek APIs, research ledger, key expiry and rate limits, lessons and outcome reasons groundwork, test on 25 leads |
| 3. Email | Weeks 3–5 | The email phase in detail below: quick fixes, mailbox foundations, the eleven-folder inbox, AI providers, AI drafting with full conversation context, small analytics, and agent connectors. Closed by gate 3 |
| 4. Scale and measure | Week 6 onward | Scheduled follow-ups, weekly outcome digest, 5-number scoreboard, $30 budget alert, review reply rate |

Weeks are planning estimates. The email phase overlaps research so the first sends can go out as soon as warm-up ends.

**Gate conditions**

1. **No platform dependency (end of phase 1):** Growth runs on its own server, database and login with the safety fixes done. Only an allowlist of routes is reachable without a session (login, setup, unsubscribe, health, cron with its secret, MCP with a key), each with its own check. PostgreSQL listens on localhost only; the firewall allows only ports 22, 80 and 443, and the portal is served over TLS behind a reverse proxy. The server scheduler runs every job that exists at this point (research and follow-ups), with logs and a failure alert; mailbox sync joins at gate 3 and the weekly digest at gate 4. The latest backup has been restored into a scratch database and its row counts match. Backups contain credential material, so they go to an S3 bucket with default encryption and public access blocked, and are deleted from the server after upload.
2. **25 leads, 0 duplicates (end of phase 2):** a real research run saves 25 qualified leads with published emails and source URLs, and no duplicate records. Claude and ChatGPT connect to the new MCP with their own keys, read the shared skill, and a duplicate check through each returns the existing record.
3. **Warm-up done, sends OK (end of phase 3):** 3–4 weeks of warm-up complete; test threads reply from their pinned mailbox; the Sent folder shows exactly one copy per email; a test bounce lands in Failed; scheduled mailbox sync runs with logs and a failure alert.
4. **Learning works (end of phase 4):** the weekly digest, run by the scheduler on real sends, produces at least one proposed lesson with its evidence, and you approve it; the next drafts visibly follow it.

## Phase 3 in detail — the email phase (agreed 2026-11-06)

Phase 3 is delivered as seven numbered items, in this order. Each item ships as one commit with its
own tests; every deploy goes through `docs/DEPLOYMENT.md`, and a migration's SQL is shown to the
founder before it is applied on live. Nothing here weakens the standing rule: agents research,
propose and save drafts; the founder approves and sends.

**0. Quick fixes, deployed on their own.**
Translation display moves out of a side panel into the message header — a small **Translate** button
beside the date, shown only for messages that are not in English, which flips the body in place to
the translation with a "Translated from <language> · Show original" label and flips back; the original
text is never altered and the translation is cached, so flipping is instant and calls the AI once.
The cause of the AI provider being unavailable on live (translation and Suggest with AI) is
established read-only and reported; keys are the founder's to change. Display caps are removed:
the Sent tab and the Follow-ups lists show the true total with **Load more**, like the Leads page.
The existing "Prepare due follow-ups" button is confirmed to respect its cap, and is disabled until
item 4 replaces it if it does not.

**1. Mailbox foundations.** Scheduled IMAP sync per connected profile, filling the empty bodies of
imported messages by Message-ID and matching the unmatched inbound by sender address and domain;
bounce handling (a permanent bounce becomes a suppression, soft bounces are retried and then
suppressed); a copy of every sent email saved into the mailbox's Sent folder; and an automatic pause
of a sending profile whose bounce rate over its last 50 sends exceeds 3%.

**2. The folder inbox.** The eleven folders become the main email screen — conversation list plus
thread view, filters and counts across all conversations, sender and agent pills, newest first.
Screenshots of the design (local dev, throwaway user) are reviewed and approved before the surface
is wired fully.

**3. AI providers.** OpenAI, Anthropic (Claude), Google Gemini and any OpenAI-compatible custom
endpoint join DeepSeek for the built-in engine and every AI action, alongside the MCP connectors
(which are unchanged). Each provider's current documented web search and page fetching is confirmed
from its own docs first. Model and search are separated: Settings chooses a model per task, and for
research a search/fetch source — the model's own built-in web search where that is reliable, or a
dedicated search API usable with any model. Tasks covered: lead research, first-email drafting,
follow-up drafting, Suggest with AI (reply), Simulate a test reply, translation and classification.
The founder enters every key himself in Settings; keys are encrypted, never shown again and never
logged. Fallback order is configured per task. Engine jobs keep their spend caps and rate limits and
show cost per job. Every lead and draft records the provider and model that produced it (the agent
pill reads e.g. "Engine · Claude"); widening `source_agent` needs a migration, whose SQL goes to the
founder first. Before any switch, the same research test (5 known providers) runs on each configured
provider, compared side by side on found, verified, duplicates caught and cost.

**4. AI drafting with full context.** Suggest with AI, Simulate a test reply, first emails and
follow-ups all use the whole conversation in time order (including translations), everything known
about the lead (evidence, sources, pricing, audience, notes, stage, earlier drafts) and Product
Truth, and follow the shared skill's rules: Product Truth claims only, no prices or results, one real
observation, ends with "Best,", and the prospect's language is noted. Follow-ups in bulk: in
"Eligible but not yet prepared", a checkbox per row with **Select all** and **Prepare selected**,
plus **Prepare next N** with a batch size the founder sets (default 10, newest contacts first).
Prepared drafts land in a review queue (the Unanswered section and Drafts) where the founder edits
and approves selected or all. Approved drafts are queued and sent within each profile's daily limit.
Nothing is ever sent without the founder's approval.

**5. Analytics, small and meaningful.** One page: the funnel (contacted, replied, interested, demo,
won), reply rate by sender, market and agent, replies after a follow-up, and bounce rate per sender,
per week.

**6. Connectors.** Email tools for agents through MCP — list folders, follow-ups due, save follow-up
drafts in bulk; drafts only, no send tool, the agent boundary stays — and a downloadable skill file
per platform (Claude, ChatGPT instructions, Gemini, Hermes).

**Item 5 of the phase-3 gate still applies**, and gate 3 now additionally requires the items above to
be live before part 2 begins: connecting `moutsim@nomeriq.com` with the founder step by step (he
enters the password in Settings; sync only first; the 19 bodies filled and the 8 matched are checked;
one test email to his own address; then replies; then follow-ups at a daily rate agreed with him,
starting at 20).

**Stops that always come back to the founder:** connecting any mailbox, the first real send,
switching automatic follow-ups on, any key, and any live migration.

## Success metrics and scope

Success is 5 paying tenants; everything else is a leading signal toward it. Every number comes from recorded events, never estimates.

| Metric | What it tells you |
| --- | --- |
| Qualified leads | Research is finding real providers |
| Emails sent | Outreach is actually going out |
| Reply rate | Message and targeting quality |
| Interested replies | Real demand for the white-label offer |
| Tenants won | The goal (target: 5) |

Also track cost per qualified lead, and compare results by signal category and country.

**Out of scope for v1**

- Three agents running research at the same time
- OpenAI or Anthropic API workers
- Automated meeting booking (a booking link is enough)
- AI sending replies on its own
- n8n, Docker, Kubernetes, RDS, separate queue servers
- A large analytics dashboard
- Any integration with the main Nomeriq platform
