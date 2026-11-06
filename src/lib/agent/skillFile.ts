import { ASSISTANT_SKILL } from "./instructions";

/** Tool/resource surfaces keep serving ASSISTANT_SKILL without download wrappers. */
export const SKILL_NAME = "nomeriq-growth-portal";
/** Bump when the shared skill changes materially. All platforms share this version. */
export const SKILL_VERSION = "3.0";

export const SKILL_PLATFORMS = ["claude", "chatgpt", "gemini", "hermes"] as const;
export type SkillPlatform = (typeof SKILL_PLATFORMS)[number];
export const SKILL_FORMATS = ["loader", "full"] as const;
export type SkillFormat = (typeof SKILL_FORMATS)[number];

export function isSkillPlatform(value: string): value is SkillPlatform {
  return SKILL_PLATFORMS.some((platform) => platform === value);
}

export function isSkillFormat(value: string): value is SkillFormat {
  return SKILL_FORMATS.some((format) => format === value);
}

/** Legacy Claude description; safe as a plain YAML scalar and under 1024 characters. */
export const SKILL_DESCRIPTION =
  "Nomeriq Growth is the shared sales database for Nomeriq, the white-label SaaS platform for trading-signal businesses. Use it through the leads-nomeriq MCP connector to read the current instructions, search and save verified trading-signal providers, check for duplicates and prepare drafts for founder review. It can read Product Truth and save evidence, but it can never approve, queue or send email, delete records or change settings. Read get_instructions first and follow it.";

const NEUTRAL_DESCRIPTION =
  "Use the configured Nomeriq Growth MCP connection to read current instructions, research trading-signal businesses and save drafts for founder review. Read get_instructions every session. Never approve, queue or send email, delete records or change settings.";

/** Only connection guidance differs; business rules always come from ASSISTANT_SKILL. */
const CONNECTION_GUIDANCE: Record<SkillPlatform, string> = {
  claude: `## Which connector

Use the \`leads-nomeriq\` connector and nothing else. Do not reach Growth through another connector,
a remembered URL, or a copy of an older skill.

If the \`leads-nomeriq\` connector is not available, stop and ask the founder to connect it.`,
  chatgpt: `## ChatGPT connection

Use the founder-configured Nomeriq Growth app/MCP connection if your ChatGPT client supports it.
For a client using custom actions instead, the founder can configure the Growth OpenAPI schema at
\`/api/agent/openapi\` on their verified Growth portal, with its own scoped key entered privately in
the client's authentication settings. These are instructions text, not a Claude skill upload.
If neither configured connection exposes \`get_instructions\`, stop and ask the founder to connect it.`,
  gemini: `## Gemini connection

This is neutral Markdown for a Gemini-based MCP-capable client, not a promise that every Gemini
app or account supports MCP or skill uploads. The founder must configure that client's Nomeriq
Growth MCP connection to \`/api/mcp\` on their verified Growth portal with a dedicated scoped key
entered privately in the client's authentication settings. If the client cannot call
\`get_instructions\`, stop and ask the founder to use an MCP-capable client.`,
  hermes: `## Hermes connection

Install this as \`SKILL.md\` in the intended Hermes skill directory. Use the founder-configured
Nomeriq Growth MCP server at \`/api/mcp\` on their verified Growth portal, with a dedicated scoped
key entered privately in the client's authentication settings. Tool names may have a client prefix;
use the configured server's \`get_instructions\`, not a guessed connector name.
If that MCP connection is not available, stop and ask the founder to configure it.`,
};

function loaderBody(platform: SkillPlatform): string {
  return `# Nomeriq Growth — how to work with it

This file is a loader, on purpose. It contains no research rules.
Every rule lives on the server and is read at the start of each session.

${CONNECTION_GUIDANCE[platform]}

## Before anything else — every session

1. Call \`get_instructions\` at the start of each session and follow the returned current rules.
   Do not substitute chat memory, a cached response or a downloaded full snapshot.
2. Read Product Truth with \`read_product_truth\` before writing anything about Nomeriq.

If the connection or required tool is missing or fails, stop and tell the founder what is missing.
Do not invent data or tool names, fall back to old rules, or use another portal.
Never paste credentials into chat or include them in a skill file.
`;
}

/** Legacy exports remain Claude by default. */
export const LOADER_SKILL_BODY = loaderBody("claude");

/** Claude and Hermes use YAML frontmatter; descriptions are fixed safe YAML scalars. */
export function buildSkillFile(body: string): string {
  return frontmatter(SKILL_DESCRIPTION, body);
}

function frontmatter(description: string, body: string): string {
  return `---\nname: ${SKILL_NAME}\ndescription: ${description}\n---\n\n${body}`;
}

/** Build any platform/format without altering the shared instruction core. */
export function buildPlatformSkillFile(
  platform: SkillPlatform,
  format: SkillFormat,
  now: Date = new Date(),
): string {
  let body = loaderBody(platform);
  if (format === "full") {
    const date = now.toISOString().slice(0, 10);
    body = `<!-- Nomeriq Growth skill ${SKILL_VERSION}, generated ${date}. Reference snapshot only; call get_instructions every session for current rules. -->\n\n${body}\n${ASSISTANT_SKILL}`;
  }
  if (platform === "claude" || platform === "hermes") {
    return frontmatter(platform === "claude" ? SKILL_DESCRIPTION : NEUTRAL_DESCRIPTION, body);
  }
  return body;
}

/** The recommended legacy Claude download: frontmatter plus a short fresh-rule loader. */
export function loaderSkillFile(): string {
  return buildPlatformSkillFile("claude", "loader");
}

/** Legacy signature preserved, including the optional generation date. */
export function fullSkillFile(now: Date = new Date()): string {
  return buildPlatformSkillFile("claude", "full", now);
}

/** Fixed filenames only: no request input is interpolated into an attachment header. */
const DOWNLOAD_FILES: Record<SkillPlatform, { filename: string; contentType: string }> = {
  claude: { filename: "SKILL.md", contentType: "text/markdown; charset=utf-8" },
  chatgpt: { filename: "nomeriq-growth-chatgpt-instructions.txt", contentType: "text/plain; charset=utf-8" },
  gemini: { filename: "nomeriq-growth-gemini.md", contentType: "text/markdown; charset=utf-8" },
  hermes: { filename: "SKILL.md", contentType: "text/markdown; charset=utf-8" },
};

export function buildSkillDownload(
  platform: SkillPlatform,
  format: SkillFormat,
  now: Date = new Date(),
): { filename: string; contentType: string; body: string } {
  return { ...DOWNLOAD_FILES[platform], body: buildPlatformSkillFile(platform, format, now) };
}