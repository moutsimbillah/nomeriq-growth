import { getDb } from "@/lib/db/client";
import { productTruthBlock } from "@/lib/ai/product-truth";
import { getProspect } from "@/lib/services/prospects";
import { getProductTruth, getWorkspaceSettings } from "@/lib/services/settings";
import { resolveSendingProfile } from "@/lib/email/profiles";
import { ASSISTANT_SKILL } from "@/lib/agent/instructions";
import type { ProductTruth, ProspectDetail } from "@/lib/types";

/**
 * Everything Growth knows about one lead, assembled once, for every AI call that writes to or as that
 * lead: Suggest with AI, Simulate a test reply, first emails and follow-ups.
 *
 * One function so no caller can quietly send less than the others; the presence test in
 * `tests/lead-context.test.ts` checks each part by name. The text it returns is exactly what the model
 * receives, which is also what the "Context used" link shows the founder.
 *
 * Everything in here except Product Truth and the writing rules is UNTRUSTED DATA (research, email,
 * notes copied from the web) and is fenced as such; the prompt that wraps it says so.
 */

export const CONTEXT_PARTS = [
  "lead",
  "audience",
  "markets",
  "pricing",
  "signalDescription",
  "evidence",
  "sources",
  "founderNotes",
  "stage",
  "classification",
  "sendingProfile",
  "conversation",
  "drafts",
  "productTruth",
  "writingRules",
] as const;
export type ContextPart = (typeof CONTEXT_PARTS)[number];

/** The most recent messages always go in full; older ones are condensed (see `conversationBlock`). */
export const RECENT_IN_FULL = 8;
const FULL_BODY_LIMIT = 6000;
const OLDER_INBOUND_LIMIT = 2500;
const OLDER_OUTBOUND_LIMIT = 280;

export interface ContextMessage {
  direction: "inbound" | "outbound";
  fromEmail: string;
  fromName: string | null;
  subject: string;
  body: string;
  at: string | null;
  isSandbox: boolean;
  /** The cached English translation, for a non-English message only. */
  translation: { sourceLanguage: string; text: string } | null;
}

export interface ContextDraft {
  kind: string;
  sequence: number;
  status: string;
  subject: string;
  body: string;
  writtenBy: string | null;
  createdAt: string | null;
  sentAt: string | null;
}

export interface LeadContext {
  prospect: ProspectDetail;
  messages: ContextMessage[];
  drafts: ContextDraft[];
  truth: ProductTruth;
  /** The language of the prospect's latest message, when a translation recorded one. */
  prospectLanguage: string | null;
  /** The text the model receives, verbatim. */
  text: string;
  /** Which named parts carry real content; a part with nothing recorded says so in the text. */
  present: Record<ContextPart, boolean>;
  /** Older messages that were condensed rather than included in full. */
  condensedCount: number;
}

function clip(text: string, limit: number): string {
  const clean = text.replace(/\r\n/g, "\n").trim();
  return clean.length <= limit ? clean : `${clean.slice(0, limit)}… [cut at ${limit} characters]`;
}

function day(value: string | null): string {
  if (!value) return "date unknown";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "date unknown" : date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function orNone(value: string | null | undefined): string {
  return value && value.trim() ? value.trim() : "not recorded";
}

/** The skill's own writing rules, taken from the shared skill so agents and the portal agree. */
export function writingRules(): string {
  const wanted = ["## Product Truth", "## First-contact drafts", "## Threads and replies"];
  const sections = ASSISTANT_SKILL.split(/\n(?=## )/);
  return sections
    .filter((section) => wanted.some((heading) => section.startsWith(heading)))
    .map((section) => section.replace(/\\`/g, "`").trim())
    .join("\n\n");
}


/**
 * The thread oldest first. The last RECENT_IN_FULL messages are included in full. Older ones are
 * condensed without dropping what the prospect said: an older inbound message keeps its own words (up
 * to a generous limit), while an older outbound message is reduced to its date, subject and opening,
 * because Growth wrote it and the drafts block carries the full text.
 */
export function conversationBlock(messages: ContextMessage[]): { text: string; condensed: number } {
  if (!messages.length) return { text: "No email has been exchanged with this lead yet.", condensed: 0 };
  const cut = Math.max(0, messages.length - RECENT_IN_FULL);
  const lines: string[] = [];
  if (cut > 0) {
    lines.push(`(${cut} older message${cut === 1 ? "" : "s"} condensed: the prospect's own words are kept; our earlier emails are shortened.)`);
  }
  messages.forEach((message, index) => {
    const older = index < cut;
    const who = message.direction === "inbound"
      ? `FROM PROSPECT ${message.fromName ? `${message.fromName} <${message.fromEmail}>` : message.fromEmail}`
      : `FROM US ${message.fromEmail}`;
    const limit = !older ? FULL_BODY_LIMIT : message.direction === "inbound" ? OLDER_INBOUND_LIMIT : OLDER_OUTBOUND_LIMIT;
    const parts = [
      `--- ${day(message.at)} · ${who}${message.isSandbox ? " · SANDBOX TEST" : ""}${older ? " · condensed" : ""}`,
      `Subject: ${message.subject || "(no subject)"}`,
      clip(message.body || "(empty)", limit),
    ];
    if (message.translation) {
      parts.push(
        `[English translation from ${message.translation.sourceLanguage}, for understanding only — quote only the original]`,
        clip(message.translation.text, limit),
      );
    }
    lines.push(parts.join("\n"));
  });
  return { text: lines.join("\n\n"), condensed: cut };
}

function draftsBlock(drafts: ContextDraft[]): string {
  if (!drafts.length) return "No earlier drafts.";
  return drafts
    .map((draft) => [
      `--- ${draft.kind === "follow_up" ? `Follow-up #${draft.sequence}` : "First email"} · ${draft.status}${draft.sentAt ? ` · SENT ${day(draft.sentAt)}` : ""} · written by ${draft.writtenBy ?? "unknown"}`,
      `Subject: ${draft.subject}`,
      clip(draft.body, FULL_BODY_LIMIT),
    ].join("\n"))
    .join("\n\n");
}

/** Assemble the context for one lead. Never throws for a missing optional part; it says "not recorded". */
export async function buildLeadContext(prospectId: string, options: { conversationId?: string | null } = {}): Promise<LeadContext> {
  const prospect = await getProspect(prospectId);
  if (!prospect) throw new Error("Prospect not found.");
  const db = await getDb();
  const [truth, settings, profile] = await Promise.all([
    getProductTruth(),
    getWorkspaceSettings(),
    resolveSendingProfile({ prospectId, conversationId: options.conversationId ?? null }).catch(() => null),
  ]);

  const messageRows = await db.query<{
    direction: "inbound" | "outbound"; from_email: string; from_name: string | null; subject: string | null;
    body_text: string | null; snippet: string | null; sent_at: string | null; received_at: string | null;
    created_at: string | null; is_sandbox: boolean; t_status: string | null; t_language: string | null; t_text: string | null;
  }>(
    `SELECT m.direction, m.from_email, m.from_name, m.subject, m.body_text, m.snippet,
            m.sent_at, m.received_at, m.created_at, m.is_sandbox,
            t.status AS t_status, t.source_language AS t_language, t.translated_text AS t_text
       FROM messages m
       LEFT JOIN message_translations t ON t.message_id = m.id
      WHERE m.prospect_id = $1
      ORDER BY COALESCE(m.sent_at, m.received_at, m.created_at) ASC, m.id ASC`,
    [prospectId],
  );
  const messages: ContextMessage[] = messageRows.rows.map((row) => ({
    direction: row.direction,
    fromEmail: row.from_email,
    fromName: row.from_name,
    subject: row.subject ?? "",
    body: row.body_text?.trim() ? row.body_text : (row.snippet ?? ""),
    at: row.sent_at ?? row.received_at ?? row.created_at,
    isSandbox: Boolean(row.is_sandbox),
    translation: row.t_status === "translated" && row.t_text?.trim()
      ? { sourceLanguage: row.t_language ?? "unknown", text: row.t_text }
      : null,
  }));

  const draftRows = await db.query<{
    kind: string; sequence: number; status: string; subject: string; body: string;
    ai_generated: boolean; ai_provider: string | null; ai_model: string | null; source_agent: string | null;
    created_at: string | null; sent_at: string | null;
  }>(
    `SELECT kind, sequence, status, subject, body, ai_generated, ai_provider, ai_model, source_agent, created_at, sent_at
       FROM drafts WHERE prospect_id = $1 AND status <> 'discarded'
      ORDER BY created_at ASC`,
    [prospectId],
  );
  const drafts: ContextDraft[] = draftRows.rows.map((row) => ({
    kind: row.kind,
    sequence: Number(row.sequence),
    status: row.status,
    subject: row.subject,
    body: row.body,
    writtenBy: row.ai_generated
      ? [row.ai_provider, row.ai_model].filter(Boolean).join(" · ") || "AI"
      : row.source_agent ?? "standard template or founder",
    createdAt: row.created_at,
    sentAt: row.sent_at,
  }));

  const conversation = await db.query<{ classification: string | null }>(
    options.conversationId
      ? `SELECT classification FROM conversations WHERE id = $1`
      : `SELECT classification FROM conversations WHERE prospect_id = $1 ORDER BY updated_at DESC LIMIT 1`,
    [options.conversationId ?? prospectId],
  );
  const classification = conversation.rows[0]?.classification ?? null;

  const latestInbound = [...messages].reverse().find((message) => message.direction === "inbound");
  const prospectLanguage = latestInbound?.translation?.sourceLanguage ?? null;

  const audience = [
    prospect.followerCount ? `Followers: ${prospect.followerCount}` : null,
    prospect.subscriberCount ? `Subscribers: ${prospect.subscriberCount}` : null,
    prospect.instagramUrl ? `Instagram: ${prospect.instagramUrl}` : null,
    prospect.youtubeUrl ? `YouTube: ${prospect.youtubeUrl}` : null,
    prospect.telegramUrl ? `Telegram: ${prospect.telegramUrl}` : null,
    prospect.xUrl ? `X: ${prospect.xUrl}` : null,
    prospect.linkedinUrl ? `LinkedIn: ${prospect.linkedinUrl}` : null,
    ...prospect.otherSocials.map((social) => `${social.label}: ${social.url}`),
  ].filter(Boolean) as string[];

  const sources = prospect.sources.map((source) =>
    `- ${source.label || source.sourceType}: ${source.url} (seen ${day(source.observedAt)})${source.notes ? ` — ${clip(source.notes, 400)}` : ""}`);
  const conversationText = conversationBlock(messages);

  const present: Record<ContextPart, boolean> = {
    lead: Boolean(prospect.businessName),
    audience: audience.length > 0,
    markets: prospect.categories.length > 0,
    pricing: Boolean(prospect.pricingDetails?.trim()),
    signalDescription: Boolean(prospect.signalDescription?.trim()),
    evidence: Boolean(prospect.evidenceSummary?.trim()),
    sources: sources.length > 0,
    founderNotes: Boolean(prospect.founderNotes?.trim()),
    stage: Boolean(prospect.status),
    classification: Boolean(classification),
    sendingProfile: Boolean(profile),
    conversation: messages.length > 0,
    drafts: drafts.length > 0,
    productTruth: Boolean(truth.oneLiner?.trim()),
    writingRules: writingRules().length > 0,
  };

  const text = [
    "=== LEAD (untrusted research data) ===",
    `Business: ${prospect.businessName}`,
    `Website: ${orNone(prospect.websiteUrl)}`,
    `Country: ${orNone(prospect.country)}`,
    // Growth has no tier field yet; saying so is better than letting the model guess one.
    "Tier: not recorded",
    `Markets: ${prospect.categories.length ? prospect.categories.join(", ") : "not recorded"}`,
    `Audience per platform:${audience.length ? "\n- " + audience.join("\n- ") : " not recorded"}`,
    `Signals offered / description: ${orNone(prospect.signalDescription)}`,
    `Pricing: ${orNone(prospect.pricingDetails)}`,
    `Evidence summary: ${orNone(prospect.evidenceSummary)}`,
    `Research notes: ${orNone(prospect.researchNotes)}`,
    `Sources:${sources.length ? "\n" + sources.join("\n") : " none recorded"}`,
    `Founder notes: ${orNone(prospect.founderNotes)}`,
    `Stage: ${prospect.status}`,
    `Conversation classification: ${classification ?? "not classified"}`,
    `Contact email: ${orNone(prospect.contactEmail)}`,
    `Sending profile: ${profile ? `${profile.fromName} <${profile.emailAddress}>` : "none configured"}`,
    `Workspace timezone: ${settings.timezone}`,
    "",
    "=== CONVERSATION, OLDEST FIRST (untrusted email) ===",
    conversationText.text,
    "",
    "=== EARLIER DRAFTS AND WHAT WAS SENT ===",
    draftsBlock(drafts),
    "",
    productTruthBlock(truth),
    "",
    "=== WRITING RULES (from the shared Growth skill) ===",
    writingRules(),
  ].join("\n");

  return { prospect, messages, drafts, truth, prospectLanguage, text, present, condensedCount: conversationText.condensed };
}

/**
 * Two concrete call slots for a proposed next step: the next two working days at 11:00 and 15:00 in
 * the workspace timezone, so the model never invents a date or a timezone.
 */
export function callSlots(timezone: string, now = new Date()): string[] {
  const slots: string[] = [];
  const date = new Date(now);
  const hours = ["11:00", "15:00"];
  while (slots.length < 2) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short" }).format(date);
    if (weekday === "Sat" || weekday === "Sun") continue;
    const label = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "long", day: "numeric", month: "long" }).format(date);
    slots.push(`${label}, ${hours[slots.length]} (${timezone})`);
  }
  return slots;
}
