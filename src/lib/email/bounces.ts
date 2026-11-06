/**
 * Bounce and complaint detection for inbound mail.
 *
 * A bounce is not a reply and must never be treated as one: it must not mark a thread answered, and
 * it must not leave a dead address in the sending pool. The plan's rule is that an unambiguous result
 * is written automatically, so this module decides three things and nothing else:
 *
 *  - **permanent** (a 5.x.x status, or a hard action failure) — the address is undeliverable, so it
 *    becomes a suppression straight away.
 *  - **transient** (a 4.x.x status, a mailbox full, a greylist) — the address may still work, so it is
 *    retried; only after {@link MAX_SOFT_BOUNCES} does it become a suppression.
 *  - **complaint** (an ARF feedback report, or an abuse report) — treated like an opt-out.
 *
 * Everything is parsed from the message itself, as untrusted data. Nothing here interprets prose as an
 * instruction, and nothing here sends anything.
 */

export type BounceKind = "permanent" | "transient" | "complaint" | "none";

export interface BounceReport {
  kind: BounceKind;
  /** The address the report is about, normalized, when the report names one. */
  recipient: string | null;
  /** The DSN status code, e.g. "5.1.1", when one was present. */
  status: string | null;
  /** The human diagnostic, trimmed and bounded. Never rendered as a link or acted on. */
  diagnostic: string | null;
  /** Recognized report without reconstructable failure classification. */
  incomplete?: boolean;
}

/** How many transient failures one address may collect before it is suppressed. */
export const MAX_SOFT_BOUNCES = 3;

/**
 * A bounce report must come from a machine, not a person.
 *
 * Real report senders carry a suffix: VERP uses `bounce-4f2c@`, `bounces+abc@`, and providers write
 * `mailer-daemon@`, `postmaster@` or `no-reply@`. So the local part is matched on its *head* — the
 * token, then any `+`, `.`, `-` or `_` and tag — rather than on an exact local part.
 */
const REPORT_SENDER = /^(mailer-?daemon|postmaster|no-?reply|bounces?|mail-daemon)([+._-][^@]*)?@/i;

/** Subjects that only a delivery report carries. */
const BOUNCE_SUBJECT =
  /(undeliverable|undelivered|delivery (status|failure|has failed|notification)|returned mail|mail delivery (failed|subsystem)|failure notice|delivery report|non[- ]?delivery)/i;

export interface BounceInput {
  fromEmail: string;
  subject: string;
  bodyText: string;
  contentType?: string | null;
  headers?: Record<string, string | null | undefined>;
}

/** Extract machine-readable parts before mailparser discards their MIME structure. */
export function getParsedBounceInput(parsed: import("mailparser").ParsedMail): BounceInput {
  const headers: Record<string, string> = {};
  for (const name of [...HEADERS, "auto-submitted", "content-type", "x-autoreply", "x-autorespond"]) {
    const value = parsed.headers.get(name);
    if (typeof value === "string") headers[name] = value;
    else if (value && typeof value === "object" && "value" in value) {
      const entry = value as { value: string; params?: Record<string, string> };
      headers[name] = entry.value + Object.entries(entry.params ?? {}).map(([k, v]) => `; ${k}=${v}`).join("");
    }
  }
  const parts = (parsed.attachments ?? []).filter((a) => /message\/(delivery-status|feedback-report)/i.test(a.contentType));
  const contentType = parts.some((a) => /feedback-report/i.test(a.contentType))
    ? "multipart/report; report-type=feedback-report"
    : parts.length ? "multipart/report; report-type=delivery-status" : headers["content-type"];
  return {
    fromEmail: parsed.from?.value[0]?.address ?? "",
    subject: parsed.subject ?? "",
    bodyText: [parsed.text ?? "", ...parts.map((a) => a.content.toString("utf8"))].join("\n\n"),
    contentType,
    headers,
  };
}

export function isAutoReply(value: BounceInput | import("mailparser").ParsedMail): boolean {
  const input = "bodyText" in value ? value : getParsedBounceInput(value);
  const headers = Object.fromEntries(Object.entries(input.headers ?? {}).filter(([, v]) => typeof v === "string").map(([k, v]) => [k.toLowerCase(), v]));
  const auto = headers["auto-submitted"]?.trim().toLowerCase();
  return Boolean((auto && auto !== "no") || headers["x-autoreply"] ||
    headers["x-autorespond"] || /out[ -]of[ -]office|automatic reply|auto[ -]?reply|vacation/i.test(input.subject));
}

/** One independent decision per recipient block; never borrow another recipient's status. */
export function parseBounceReports(input: BounceInput): BounceReport[] {
  const headers = Object.fromEntries(Object.entries(input.headers ?? {}).filter(([, v]) => typeof v === "string").map(([k, v]) => [k.toLowerCase(), v]));
  input = { ...input, headers, contentType: input.contentType ?? headers["content-type"] };
  const mimeDsn = /message\/delivery-status|report-type\s*=\s*["']?delivery-status/i.test(input.contentType ?? "");
  const structuredFields = /^Final-Recipient\s*:/im.test(input.bodyText) && /^(Status\s*:\s*[245]\.|Action\s*:\s*(failed|delayed))/im.test(input.bodyText);
  const vacationSubject = /out[ -]of[ -]office|vacation|automatic reply|auto[ -]?reply/i.test(input.subject);
  if (isAutoReply(input) && !mimeDsn && !(structuredFields && REPORT_SENDER.test(input.fromEmail) && !vacationSubject)) return [];
  if (structuredFields && REPORT_SENDER.test(input.fromEmail) && !vacationSubject) input = { ...input, contentType: input.contentType ?? "message/delivery-status" };
  const body = input.bodyText.replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ");
  const blocks = body.split(/(?=^Final-Recipient\s*:)/im);
  const recipientBlocks = blocks.filter((b) => /^Final-Recipient\s*:/im.test(b));
  const reports = (recipientBlocks.length ? recipientBlocks : [body]).map((bodyText) => parseSingleBounce({ ...input, bodyText }));
  return reports.filter((r) => r.kind !== "none").filter((r, i, all) => all.findIndex((other) => other.recipient === r.recipient) === i);
}

/** Compatibility wrapper for existing single-recipient callers. */
export function parseBounce(input: BounceInput): BounceReport {
  return parseBounceReports(input)[0] ?? { kind: "none", recipient: null, status: null, diagnostic: null };
}

const HEADERS = [
  "x-failed-recipients",
  "x-failed-recipient",
  "final-recipient",
  "original-recipient",
  "diagnostic-code",
  "status",
  "action",
];

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Pull a DSN field out of the body, accepting both `Field: value` and the wrapped forms. */
function fieldFromBody(text: string, name: string): string | null {
  const expression = new RegExp(`^${name}\\s*:\\s*(.+)$`, "im");
  const match = text.match(expression);
  return match ? clean(match[1]) : null;
}

/** `Final-Recipient: rfc822; someone@example.com` → `someone@example.com`. */
function addressFrom(value: string | null): string | null {
  if (!value) return null;
  const withoutType = value.replace(/^[a-z0-9-]+\s*;\s*/i, "");
  const angle = withoutType.match(/<([^>]+)>/);
  const candidate = (angle ? angle[1] : withoutType.split(/[\s,;]+/)[0] ?? "").trim();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidate) ? candidate.toLowerCase() : null;
}

/** A 4.x.x status is transient by definition; 5.x.x is permanent. */
function kindFromStatus(status: string | null): BounceKind | null {
  if (!status) return null;
  if (/^5\./.test(status)) return "permanent";
  if (/^4\./.test(status)) return "transient";
  return null;
}

/** DSN actions that mean the message will never be delivered. */
function kindFromAction(action: string | null): BounceKind | null {
  if (!action) return null;
  const value = action.toLowerCase();
  if (value === "failed") return "permanent";
  if (value === "delayed") return "transient";
  return null;
}

/**
 * Read one inbound message and decide whether it is a bounce, a complaint, or ordinary mail.
 *
 * The inputs are the pieces the sync already has: the parsed body text, the subject, the sender, and
 * the content type. Nothing is fetched and nothing is assumed about the shape of a provider's report;
 * a message that looks human is `none`, which is the safe answer.
 */
function parseSingleBounce(input: BounceInput): BounceReport {
  const subject = input.subject ?? "";
  const body = input.bodyText ?? "";
  const from = (input.fromEmail ?? "").toLowerCase();
  const dsnType = /multipart\/report|message\/delivery-status/i.test(input.contentType ?? "");

  // A complaint (ARF) is read the same way and outranks the DSN reading when both appear.
  const complaint =
    /report-type\s*=\s*["']?feedback-report|message\/feedback-report/i.test(input.contentType ?? "") ||
    /^Feedback-Type\s*:\s*(abuse|fraud)/im.test(body);
  const looksLikeBounce = dsnType || BOUNCE_SUBJECT.test(subject);
  const fromReportMachine = REPORT_SENDER.test(from);

  if (!complaint && !looksLikeBounce) {
    return { kind: "none", recipient: null, status: null, diagnostic: null };
  }
  // A human writing "undeliverable" in a subject is not a delivery report.
  if (!complaint && !fromReportMachine && !dsnType) {
    return { kind: "none", recipient: null, status: null, diagnostic: null };
  }

  const bodyField = (name: string) => fieldFromBody(body, name);
  const header = (name: string) => clean(input.headers?.[name] ?? "") || null;

  const status = bodyField("Status") ?? header("status");
  const action = bodyField("Action") ?? header("action");
  // A DSN names the failed address in Final-Recipient; an ARF complaint names it in
  // Original-Recipient or Removal-Recipient, and older reports use Original-Rcpt-To.
  const finalRecipient =
    bodyField("Final-Recipient") ??
    header("final-recipient") ??
    bodyField("Original-Recipient") ??
    header("original-recipient") ??
    bodyField("Original-Rcpt-To") ??
    bodyField("Removal-Recipient");
  const diagnostic =
    bodyField("Diagnostic-Code") ??
    header("diagnostic-code") ??
    // Last resort: the report's own prose, bounded. Only ever shown as text.
    (body ? body.slice(0, 300) : null);

  const recipient =
    addressFrom(finalRecipient) ??
    addressFrom(header("x-failed-recipients") ?? header("x-failed-recipient")) ??
    addressFrom(bodyField("X-Failed-Recipients"));

  if (complaint) {
    return {
      kind: "complaint",
      recipient,
      status,
      diagnostic: diagnostic ? clean(diagnostic).slice(0, 300) : null,
    };
  }

  const kind =
    kindFromStatus(status) ??
    kindFromAction(action) ??
    // No usable field: a report we cannot classify is treated as transient, never as permanent. A
    // wrong suppression blocks a real prospect for ever; a wrong retry costs one more attempt.
    "transient";

  return {
    kind,
    recipient: recipient ?? addressFrom(bodyField("X-Failed-Recipients")),
    status,
    diagnostic: diagnostic ? clean(diagnostic).slice(0, 300) : null,
    ...(!kindFromStatus(status) && !kindFromAction(action) ? { incomplete: true } : {}),
  };
}

export type BounceDecision = "suppress" | "retry";

/**
 * What to do about one bounce report.
 *
 * Permanent and complaint reports suppress immediately. A transient report retries until the address
 * has collected {@link MAX_SOFT_BOUNCES} of them, then suppresses — a mailbox that has been full for
 * three attempts is not worth a fourth.
 */
export function bounceDecision(input: {
  kind: BounceKind;
  /** How many transient reports this address already has on record, before this one. */
  priorSoftBounces: number;
}): BounceDecision {
  if (input.kind === "permanent" || input.kind === "complaint") return "suppress";
  if (input.kind === "transient") {
    return input.priorSoftBounces + 1 >= MAX_SOFT_BOUNCES ? "suppress" : "retry";
  }
  return "retry";
}

/** The suppression reason a bounce decision writes. `complaint` is its own reason by design. */
export function suppressionReasonFor(kind: BounceKind): "bounce" | "complaint" {
  return kind === "complaint" ? "complaint" : "bounce";
}

/** The bounce rate that pauses a profile, and the window it is measured over (the plan's numbers). */
export const BOUNCE_WINDOW = 50;
export const BOUNCE_LIMIT = 0.03;

/**
 * Whether a sending profile's recent bounce rate is above the limit.
 *
 * Measured over the last {@link BOUNCE_WINDOW} sends. A profile that has sent fewer than that cannot
 * be judged: one bounce out of two sends is 50%, and pausing a warm-up mailbox on that would stop
 * sending for a reason that is not a trend. So the check answers "no" until the window is full, and
 * the caller reports the sample size it used rather than implying more confidence than it has.
 */
export function bounceRateExceeded(input: { sends: number; bounces: number }): {
  exceeded: boolean;
  rate: number;
  sampled: boolean;
} {
  const sends = Math.max(0, Math.floor(input.sends));
  const bounces = Math.max(0, Math.floor(input.bounces));
  if (sends === 0) return { exceeded: false, rate: 0, sampled: false };
  const rate = bounces / sends;
  const sampled = sends >= BOUNCE_WINDOW;
  return { exceeded: sampled && rate > BOUNCE_LIMIT, rate, sampled };
}