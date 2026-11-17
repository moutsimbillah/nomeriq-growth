# Security Policy — Nomeriq Growth

Nomeriq Growth is an open-source, self-hostable B2B prospect research and outreach application. It processes business contact information, research evidence, email conversations, and credentials for external services. Security reports are welcome and should be handled privately to protect users and operators.

This document explains how to report a vulnerability, which versions receive attention, the security boundaries in the current implementation, and precautions for deployments. It describes the project's design, not a guarantee that every installation is secure.

## Supported versions

| Version | Security maintenance |
| --- | --- |
| Current `master` branch | Primary target for reviewing and fixing confirmed vulnerabilities |
| Older commits, forks, and independently modified installations | No guaranteed backports or security support |
| Future tagged releases | Support status will be documented as releases are published |

The project is maintained independently. There is no contractual response-time or patch-time guarantee. Operators should monitor repository updates and apply relevant fixes to their own deployments.

## Report a vulnerability privately

**Do not open a public GitHub issue or pull request containing an undisclosed vulnerability, exploit details, real credentials, or personal data.**

1. Go to the repository's [Security tab](https://github.com/moutsimbillah/nomeriq-growth/security).
2. If **Report a vulnerability** is available, submit a **private vulnerability report** there. This is the preferred channel.
3. If private reporting is not enabled, contact the maintainer through a private contact method explicitly published on the [maintainer's GitHub profile](https://github.com/moutsimbillah). Ask for a secure reporting channel **without including exploit details in a public post**. Do not assume GitHub Issues or Discussions are private.

Include, where safe and relevant:

- The affected version or commit and the affected area, endpoint, or workflow.
- A concise description of the issue and its possible impact.
- Reproduction steps or a proof of concept using **only your own authorized local test instance and synthetic data**.
- Any safe mitigations you identified and whether you believe the issue is already public.
- A private contact method for follow-up, if you wish to receive updates.

Please **do not** access third-party accounts, extract customer data, test the maintainer's live deployment without explicit authorization, disrupt services, send real outreach messages, or publicly disclose sensitive details before coordinating with the maintainer.

### What to expect

Reports will be reviewed as maintainer capacity allows. The maintainer will assess reproducibility and impact, work toward a fix where warranted, and coordinate disclosure when feasible. The maintainer may request additional details or a private reproduction. **No acknowledgment, remediation, disclosure, or bounty timeline is guaranteed**, and there is no published bug-bounty program.

For non-security bugs and feature requests, use [GitHub Issues](https://github.com/moutsimbillah/nomeriq-growth/issues), keeping secrets and personal data out of reports.

## Current security boundaries

The following reflects the repository's documented implementation. It should be independently reviewed and tested for each deployment.

### Authentication and authorization

- Growth uses its own user and session records, separate from the main Nomeriq application; it does not share Nomeriq's login or production database.
- Passwords are hashed with `scrypt` and random salts. Sessions use opaque random tokens; session-token hashes are stored server-side.
- Production session cookies are designed to use `HttpOnly`, `SameSite=Lax`, and `Secure`.
- The current founder/admin workflow can perform mutations; member accounts are documented as read-only. **Do not assume this is a general-purpose multi-tenant organization/role model.**
- Cookie-authenticated mutations require same-origin checks; API and MCP integration requests use separately scoped bearer keys. Check privileges at the server, not merely in the UI.
- API/MCP scopes include `research:read`, `research:write`, `drafts:write`, `product_truth:read`, `conversations:read`, and `progress:read`. The documented agent surface does **not** expose email-send, deletion, settings, or permissions-changing tools.

### Credentials and external APIs

- Mailbox passwords are encrypted at rest with AES-256-GCM using `APP_ENCRYPTION_KEY` supplied from the environment. API keys and provider credentials must never be put in source control, logs, support tickets, or test fixtures.
- Protect `APP_ENCRYPTION_KEY`, `SESSION_SECRET`, `CRON_SECRET`, database credentials, mailbox credentials, and AI-provider keys as independent secrets. Do not reuse them across unrelated installations.
- Treat the configured OpenAI, Anthropic Claude, DeepSeek, or custom API endpoint as a third-party data processor. Review its privacy, retention, and billing terms before submitting real prospect or correspondence data.
- ChatGPT, Claude, and Hermes integrations use permission-scoped MCP tools/skills. Connecting an assistant must **not** imply permission to send email or change operational settings.
- Rotate or revoke an exposed API key promptly. If `APP_ENCRYPTION_KEY` is lost or replaced, encrypted mailbox credentials may need to be entered again.

### Research and prompt injection

- Retrieved websites and inbound email are **untrusted content**, not instructions. Review changes that involve prompt composition, extraction, tool calls, or agent authorization carefully.
- Research should not invent contact emails or claim verification without source-backed evidence. Evidence and qualification checks should be enforced server-side at save time.
- A model or research worker must not be allowed to send email, remove suppression, change permissions, or modify approved Product Truth through indirect instructions in external content.
- Model providers and compatible custom endpoints can have different tool capabilities. A chat-only endpoint should not be treated as proof that web search or fetching works.

### Email, suppression, and outreach

- Keep `EMAIL_DELIVERY_MODE=sandbox` during development, tests, and first-time setup. **Never use production SMTP/IMAP credentials or send real messages as part of an issue reproduction or pull-request test.**
- Live sends are intended to require a verified recipient, deliberate human authorization, a configured healthy mailbox, sending limits, suppression checks, and a durable idempotency record.
- Follow-up automation prepares drafts; it must not silently send. Replies, opt-outs, and suppression should stop further promotional follow-ups.
- The system records SMTP acceptance, **not** guaranteed inbox delivery.
- Operators are responsible for lawful data collection and outreach, accurate sender identification, unsubscribe handling, and compliance with applicable privacy, anti-spam, and email-provider rules.

### Database and deployment

- Use a dedicated PostgreSQL database for each deployment; do not reuse the main Nomeriq application's production database.
- Local PGlite is for development. Production uses PostgreSQL via `DATABASE_URL` and should have protected access, backups, and a tested recovery plan.
- Database unique constraints and server-side checks are important safeguards for duplicate identities and qualification. Preserve them when modifying migrations or lead services.
- The Supabase security migration documents RLS/revocation for exposed roles as defense in depth; Growth itself uses a server-side database connection rather than the Supabase Data API.
- The login rate limiter is documented as in-process. Multi-instance or public production deployments should add an external WAF/rate-limit policy, monitor abuse, and enforce HTTPS.
- Secure scheduled research and follow-up endpoints using `CRON_SECRET`. Do not expose privileged internal operations through public, unauthenticated routes.
- Do not deploy the maintainer's demo domain, sample account details, or seeded prospect examples as your production configuration.

## How to validate security-sensitive changes

Run the project's existing checks before proposing a change:

```bash
npm run typecheck
npm test
npm run build
```

For authentication, data access, research, or email changes, add regression tests covering authorized and unauthorized paths, duplicated or concurrent operations, and failures/retries. Use a disposable local database, fake provider responses, and sandbox email only. Do not include live customer records, real message threads, secrets, or production logs in commits or issue attachments.

If security behavior or supported integrations change, update this file and the relevant sections of `README.md` and `docs/DEPLOYMENT.md`. See [CONTRIBUTING.md](CONTRIBUTING.md) for the normal contribution workflow.

## Disclaimer

This policy is for coordinated vulnerability handling and operator guidance. It does not certify the software, establish an SLA, authorize testing against third-party systems, or provide legal advice.
