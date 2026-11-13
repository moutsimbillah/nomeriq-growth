# Contributing to Nomeriq Growth

Thank you for your interest in improving **Nomeriq Growth**. The project is open-source, self-hostable B2B prospect research and outreach software licensed under the [GNU Affero General Public License v3.0 (AGPLv3)](LICENSE).

Contributions of well-scoped bug fixes, security improvements, tests, documentation, accessibility improvements, and reusable integrations are welcome. The project is independently maintained, so review and merge times depend on available capacity.

## Understand the project's scope

Nomeriq Growth's documented workflow currently focuses on finding and evaluating **commercial trading-signal providers**, producing evidence-backed lead records and drafts, and managing reviewed email outreach. It is a starting point for other industries, not an already-validated general-purpose multi-tenant CRM or automatic meeting-booking solution.

The app supports model/API integrations (OpenAI, Anthropic Claude, DeepSeek, and compatible custom endpoints) separately from agent clients (ChatGPT, Claude, and Hermes using scoped MCP tools and shared skills). Individual APIs can differ in search, fetch, tool use, pricing, and behavior. Do not assume the same implementation or tests cover every provider.

### Especially useful contributions

- Reliability improvements to research jobs, persistence, concurrency, retries, and budget accounting.
- Evidence-backed lead verification, duplicate prevention, and safe identity matching.
- Security fixes for sessions, permissions, secrets, MCP/REST tools, and third-party integrations.
- Better local installation, deployment documentation, tests, and operator troubleshooting.
- Accessibility, usability, localization, and industry-neutral extension points.
- Provider integrations with explicit capabilities, failure handling, and safe test doubles.

Please open an issue to discuss major features, breaking API or database changes, changes to license or architecture, or any proposal that would widen agent permissions or enable autonomous sending.

## Before opening an issue or pull request

1. Read the [README](README.md), [deployment guide](docs/DEPLOYMENT.md), and [security policy](SECURITY.md).
2. Search existing [issues](https://github.com/moutsimbillah/nomeriq-growth/issues) and [pull requests](https://github.com/moutsimbillah/nomeriq-growth/pulls) to avoid duplicates.
3. For bugs, provide reproduction steps, expected and actual behavior, your environment, and sanitized logs or screenshots.
4. For feature proposals, explain the user problem, scope, safety implications, and how the change will be tested.
5. **Do not publish vulnerabilities in public issues.** Follow the private reporting instructions in [SECURITY.md](SECURITY.md).

Please keep issue discussions respectful, technically constructive, and focused on reproducible facts. Do not include real prospect data, private conversation contents, credentials, or third-party personal information.

## Local development

### Prerequisites

- Node.js **22 or newer** and npm.
- A Git client.
- No Docker or external database is required for the documented local workflow: development uses embedded PGlite.

### Set up a working copy

Fork the repository on GitHub and clone your fork:

```bash
git clone https://github.com/YOUR_USERNAME/nomeriq-growth.git
cd nomeriq-growth
npm install
cp .env.example .env.local
```

Set **your own** `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `SESSION_SECRET`, and `APP_ENCRYPTION_KEY` in `.env.local`. You can generate the two secret values with:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Keep `DATABASE_URL` empty for local PGlite and `EMAIL_DELIVERY_MODE=sandbox` to prevent real email delivery. Do not use the maintainer's production domain or credentials. Model API keys are optional for deterministic drafting and offline tests; if you configure any, use credentials you own and understand their usage costs.

Then initialize the local database and run the app:

```bash
npm run db:seed
npm run dev
```

The default local URL is <http://localhost:3100>. The seed can include public examples and synthetic sandbox email. **Do not interpret seeded records as live usage statistics or authorization to contact those businesses.**

### Test before submitting

```bash
npm run typecheck
npm test
npm run build
```

Run relevant focused tests while developing, but provide the results of the full commands above in your PR. For changes to the research engine, you can also use the documented local HTTP-stub harness:

```bash
node scripts/e2e-engine.mjs
```

The project documents offline workflow and engine tests. Do not call paid production AI endpoints or send live emails just to validate a pull request. If your change genuinely requires an optional external-service test, explain what could not be tested locally instead of claiming it passed.

## Making changes

1. Create a descriptive feature or fix branch from the latest `master`.
2. Make the smallest change that solves the identified problem. Avoid unrelated refactors and formatting-only churn.
3. Add or update tests for behavior changes, failure modes, and security boundaries.
4. Update documentation and `.env.example` if configuration or setup changes. Do not add actual secret values.
5. Check database migrations for safe forward deployment, existing-data compatibility, and repeatability where applicable; never run destructive migrations against live data without explicit review.
6. Re-run typecheck, tests, and build. Review the diff for secrets, personal data, generated artifacts, and unintended changes before pushing.
7. Open a PR against `master` with a clear summary and reproduction/test evidence.

### Areas requiring extra care

**Lead identity and evidence:** Do not replace source-backed verification with unverifiable AI judgments, inflate qualified counts, or merge unrelated businesses because they share a generic mailbox (such as `info@`). Keep deduplication enforced in the server/database path.

**AI, MCP, and skills:** Treat fetched pages and inbound email as untrusted input. Preserve least-privilege API scopes, server-side authorization, and separation between drafting/research and sending/settings changes. Document differences between model API providers and connected assistants.

**Mail and campaigns:** Preserve human review, sandbox defaults, suppression/unsubscribe checks, idempotency, sending limits, and no automatic sends from research or follow-up preparation. Never use real recipients in automated tests.

**Privacy and security:** Use synthetic fixtures. Avoid collecting or exposing unnecessary personal information, secrets, tokens, mailbox threads, or private research data. If you encounter a vulnerability, follow [SECURITY.md](SECURITY.md) instead of opening a public PR with exploit details.

## Pull request checklist

Use this checklist in your PR description (mark items that apply):

- [ ] The purpose and scope of the change are explained.
- [ ] Related issue or relevant background is linked, if any.
- [ ] New or changed behavior has appropriate tests.
- [ ] `npm run typecheck`, `npm test`, and `npm run build` pass, or limitations are documented.
- [ ] Documentation/configuration examples are updated where needed.
- [ ] No secrets, real mailbox messages, private data, or unsafe test recipients are committed.
- [ ] No unintended changes to agent privileges, email-sending controls, or tenant/data boundaries are introduced.
- [ ] If an external AI provider is involved, capabilities actually tested and untested limitations are described.

A maintainer may request changes, hold a PR for further testing, or decline it if it doesn't match the project's scope or security requirements. Opening a PR does not guarantee that it will be merged.

## Licensing and attribution

The repository is licensed under **AGPL-3.0**. Only submit code and assets you have the right to contribute. By submitting a contribution for inclusion, you agree it may be distributed under the repository's AGPLv3 license. Identify third-party code/assets and their licenses; do not copy proprietary or incompatible material into the project.

AI-assisted changes are welcome when the contributor has reviewed, understood, and tested them. Contributors remain responsible for correctness, security, attribution, and license compliance.

## Need help?

For ordinary questions, usage problems, and non-sensitive proposals, open a [GitHub issue](https://github.com/moutsimbillah/nomeriq-growth/issues). For vulnerability reports, use the private process in [SECURITY.md](SECURITY.md).
