#!/usr/bin/env node
/**
 * Regenerates src/lib/leads/rules.ts from docs/lead-rules.md.
 *
 * The founder's rules are the single source of truth. The document is the file a
 * human reads and edits; the module is what the running app, the agent
 * instructions and the AI context all quote. Generating one from the other —
 * rather than retyping the rules — is what stops the two from drifting apart,
 * and tests/lead-rules-parity.test.ts fails the build if they ever do.
 *
 * Usage: npm run sync:lead-rules
 */
import fs from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const docPath = path.join(root, "docs", "lead-rules.md");
const outPath = path.join(root, "src", "lib", "leads", "rules.ts");

const raw = await fs.readFile(docPath, "utf8");
// The rules are text, not bytes: git checks files out with CRLF on Windows and
// LF elsewhere (core.autocrlf=true here). Normalising keeps the generated
// module identical on every machine, so the rules cannot appear to change
// because someone cloned the repository on a different platform.
const canonical = raw.replace(/\r\n/g, "\n").replace(/\n+$/, "");

const header = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Regenerate with \`npm run sync:lead-rules\`. It is produced byte-for-byte from
 * \`docs/lead-rules.md\`, which is the founder's own rules document and the only
 * place the rules are edited. \`tests/lead-rules-parity.test.ts\` fails if the
 * two differ, so a stale copy can never be served silently.
 */
`;

const body = `${header}
/** The date the founder approved the rules currently in \`docs/lead-rules.md\`. */
export const LEAD_RULES_VERSION = "lead-rules-2026-11-07";

/** Where these rules come from, for anyone reading a stored assessment. */
export const LEAD_RULES_PATH = "docs/lead-rules.md";

/** The canonical rules, exactly as the founder wrote them. */
export const LEAD_RULES_TEXT = ${JSON.stringify(canonical)};
`;

await fs.writeFile(outPath, body, "utf8");
console.log(`Wrote ${path.relative(root, outPath)} (${canonical.length} chars)`);
