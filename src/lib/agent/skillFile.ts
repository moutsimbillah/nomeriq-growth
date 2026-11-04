import { ASSISTANT_SKILL } from "./instructions";

/**
 * The downloadable Claude skill file.
 *
 * A skill file must begin with YAML frontmatter: `name` in lowercase letters, numbers and hyphens,
 * and a `description` under 1024 characters. Some loaders reject a description that contains angle
 * brackets, so there are none here.
 *
 * There are two downloads. The **loader** holds no research rules — it tells the assistant to read
 * the rules from the server on every session — so it cannot go stale and is uploaded once. The
 * **full copy** is the same frontmatter plus today's skill text, stamped with a version and a date,
 * for reference or for a client that cannot call tools at all.
 *
 * `get_instructions` and the MCP resource keep serving the bare text: no frontmatter there.
 */

export const SKILL_NAME = "nomeriq-growth-portal";

/** Bump when the shared skill text changes materially, so a stale full copy is obvious. */
export const SKILL_VERSION = "2.0";

/** Under 1024 characters, and deliberately free of angle brackets. */
export const SKILL_DESCRIPTION =
  "Nomeriq Growth is the shared sales database for Nomeriq, the white-label SaaS platform for trading-signal businesses. Use it through the leads-nomeriq MCP connector to read the current instructions, search and save verified trading-signal providers, check for duplicates and prepare first-contact drafts for founder review. It can read Product Truth and save evidence, but it can never send email, delete records or change settings. Read get_instructions first and follow it.";

export const LOADER_SKILL_BODY = `# Nomeriq Growth — how to work with it

This file is a loader, on purpose. It contains no research rules, so it cannot fall out of date:
every rule lives on the server and is read at the start of each session.

## Which connector

Use the \`leads-nomeriq\` connector and nothing else. Do not reach Growth through another connector,
a remembered URL, or a copy of an older skill.

## Before anything else

1. Call \`get_instructions\` and follow it. That is the current, authoritative version of every rule:
   what qualifies, how to deduplicate, how to research, how to draft, and what you may never do.
2. Read Product Truth with \`read_product_truth\` before writing anything about Nomeriq — its offer,
   its pricing, its claims, its integrations. Never state a price or a claim it does not contain.

## If the connector is missing

Stop, and tell the founder that the \`leads-nomeriq\` connector is not available and that you cannot
reach Growth. Ask them to connect it. Do not guess at tool names, do not invent data, and do not fall
back to an older skill or to another portal.
`;

export function buildSkillFile(body: string): string {
  return `---\nname: ${SKILL_NAME}\ndescription: ${SKILL_DESCRIPTION}\n---\n\n${body}`;
}

/** The recommended download: frontmatter plus the short loader. */
export function loaderSkillFile(): string {
  return buildSkillFile(LOADER_SKILL_BODY);
}

/** Frontmatter plus the complete current skill text, stamped so staleness is visible. */
export function fullSkillFile(now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  return buildSkillFile(
    `<!-- Nomeriq Growth skill ${SKILL_VERSION}, generated ${date}. If this date is old, download a fresh copy from Settings, AI integrations. -->\n\n${ASSISTANT_SKILL}`,
  );
}