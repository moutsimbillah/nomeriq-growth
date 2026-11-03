# Nomeriq Growth security model

Growth is an internal system holding business contact data, mailbox credentials and private sales conversations. It is deliberately small, but it is not a toy.

## Identity and access

- Independent user table and session store. No Supabase Auth, no main Nomeriq login and no shared session.
- Passwords hashed with `scrypt` (N=16384, r=8, p=1) and a random salt.
- Opaque 256-bit session tokens. Only a SHA-256 hash is stored in `sessions`.
- Session cookie: `HttpOnly`, `SameSite=Lax`, `Secure` in production, 30-day expiry.
- Founder/admin can mutate; member accounts are read-only.
- Every mutating cookie-authenticated route requires a same-origin `Origin` header. Login and setup also require it.
- API/MCP access uses scoped bearer keys. Only a hash is stored and the full key is shown once.
- Key scopes: `research:read`, `research:write`, `drafts:write`, `product_truth:read`, `conversations:read`, `progress:read`. There is no send, delete, settings or permission scope.

## Credentials

- SMTP/IMAP passwords are encrypted with AES-256-GCM using `APP_ENCRYPTION_KEY`.
- The key is supplied by environment and never stored in the database.
- Encrypted passwords are never returned by an API.
- Changing the key requires re-entering mailbox credentials.

## Sending safeguards

A send is blocked unless all applicable conditions hold:

1. Verified recipient (public-source email for cold email).
2. Approved draft, or an explicit founder reply action.
3. Healthy connected mailbox.
4. Recipient not suppressed and prospect not marked do-not-contact.
5. App-configured 24-hour cap and minimum interval not exceeded.
6. Prospect not already contacted for a first-contact draft.
7. No reply since the last outbound message for a follow-up.
8. Unique durable send ledger record; retry after SMTP acceptance returns the existing accepted result rather than sending again.
9. Truthful sender identity and a postal address for live commercial email.
10. A per-recipient unsubscribe URL and `List-Unsubscribe` headers are appended server-side.

SMTP acceptance is recorded as *accepted by the sending server*. Growth never claims inbox delivery.

## Suppression

- Exact normalized email addresses.
- Checked on every promotional send and reply.
- Opt-out classification immediately creates a suppression, marks the prospect do-not-contact/lost and cancels active follow-up drafts.
- Unsubscribe links use random 256-bit capability tokens stored only as hashes.
- No assistant tool can remove a suppression.

## Prompt injection and untrusted content

- Websites and inbound email are untrusted evidence, never instructions.
- Research and reply prompts delimit untrusted data and explicitly tell the model not to follow instructions inside it.
- No model has a send/delete/settings/permission/Product Truth mutation tool.
- HTML email is not rendered in the UI; messages are displayed as plain text.
- External content cannot trigger a send, change Product Truth or alter system permissions.

## Database

- Deduplication is enforced by unique indexes for domain, email, primary alias and stable social identity.
- Server-side services run ownership and evidence checks before writes.
- Supabase migration `002_supabase_security.sql` enables RLS and revokes `anon`/`authenticated` access when those roles exist.
- Growth uses a server-side PostgreSQL connection, not the Supabase Data API.
- Production requires `DATABASE_URL`. Local PGlite is development-only.

## Operational guidance

- Use a dedicated mailbox with a strong unique password or app password.
- Set a conservative app sending cap and interval.
- Set a real registered postal address before switching to live.
- Enable Supabase backups.
- Rotate API keys per assistant; revoke immediately if exposed.
- Keep `APP_ENCRYPTION_KEY` and `SESSION_SECRET` in a secret manager.
- The login rate limiter is in-process. Add a platform WAF/rate limit for multi-instance production.
- Review provider terms and applicable commercial-email law. This software implements safeguards, not legal advice.
