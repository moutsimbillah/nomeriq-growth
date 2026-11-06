/**
 * API key scopes.
 *
 * These constants are pure and framework-free on purpose: a client component
 * (the integrations settings UI) needs the default scopes, and importing them
 * from `apiKeys.ts` would pull the database client — and therefore `pg`, `fs`
 * and `net` — into the browser bundle.
 */

export const ALLOWED_SCOPES = [
  "research:read",
  "research:write",
  "drafts:write",
  "product_truth:read",
  "conversations:read",
  "folders:read",
  "followups:read",
  "followups:write",
  "progress:read",
] as const;

export type ApiScope = (typeof ALLOWED_SCOPES)[number];

/**
 * The minimum a research agent needs to do its job. New keys get exactly these
 * unless the founder deliberately opts into more. Email scopes (conversations,
 * folders and follow-ups) are intentionally NOT included: email access stays
 * opt-in rather than being granted by default.
 */
export const DEFAULT_SCOPES = [
  "research:read",
  "research:write",
  "drafts:write",
  "progress:read",
  "product_truth:read",
] as const;
