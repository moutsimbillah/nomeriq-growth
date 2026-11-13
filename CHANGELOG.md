# Changelog

Notable changes to Nomeriq Growth are documented here.

This project uses version numbers in the form `MAJOR.MINOR.PATCH`. The first
public release is an early release, and interfaces or deployment requirements
may change as the project matures.

## [0.1.0] - 2026-11-13

### Initial public release

- Published the application source under the GNU Affero General Public License
  v3.0 (AGPL-3.0).
- Provided a self-hostable Next.js and PostgreSQL application for managing B2B
  prospect research, contact evidence, outreach drafts, conversations, and
  opportunities.
- Included a resumable, budget-controlled research workflow with source-backed
  qualification, duplicate prevention, and persisted progress.
- Included human-reviewed outreach drafting, sandbox email mode, SMTP/IMAP
  integrations, follow-up preparation, suppression handling, and send safeguards.
- Documented model API options including OpenAI, Anthropic Claude, DeepSeek,
  and compatible custom providers; actual capabilities depend on the provider
  and configured workflow.
- Documented scoped MCP/REST interfaces and shared skill instructions for
  agent integrations including ChatGPT, Claude, and Hermes.
- Added local development instructions, automated test commands, a security
  policy, and contributor guidance.

### Scope and limitations

- The implemented prospecting and eligibility workflow is currently specialized
  for commercial trading-signal providers. Other industries require adaptation
  and testing.
- This release is not a general-purpose multi-tenant enterprise CRM and does
  not include built-in calendar meeting-booking automation.
- Provider-specific research features may require separate Search/Fetch
  capabilities, API keys, and paid usage. A generic chat API alone is not
  sufficient for every research workflow.
- Live SMTP/IMAP and third-party research capabilities should be verified by
  each operator before production use. Test or seeded lead counts are not
  adoption statistics or proof of live service delivery.

### Before production use

- Review [SECURITY.md](SECURITY.md) and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- Configure unique secrets, a dedicated production database, your own domain
  and email account, and applicable privacy/outreach compliance settings.
- Begin with `EMAIL_DELIVERY_MODE=sandbox`.
- Run `npm run typecheck`, `npm test`, and `npm run build`.
