import { randomUUID } from "node:crypto";
import { AppError } from "@/lib/utils";

export interface ToolFailure {
  /** Safe to show the caller: says why, never a stack, a driver message or a parameter value. */
  message: string;
  code: string;
  status: number;
  /** Present only for unexpected failures, so the caller can quote it and we can find the log. */
  reference?: string;
}

/**
 * Text that must never reach a caller: SQL, table and column names, constraint names, driver
 * wording, file paths, stack frames and tokens.
 *
 * A validation or permission message is written by us and names an argument or a scope. Anything
 * matching this pattern is treated as a leak and replaced with the generic message, whatever kind
 * of error carried it — the guarantee is a property of the code, not a review of today's messages.
 */
const INTERNAL_TEXT: RegExp[] = [
  /\brelation\s+"/i,
  /\bcolumn\s+"?[a-z_][a-z0-9_]*"?/i,
  /\bis of type\b/i,
  /\bconstraint\s+"/i,
  /\bviolates\b/i,
  /\bsyntax error\b/i,
  /\bSQLSTATE\b/i,
  /\bpg_[a-z_]+/i,
  /\binsert into\b/i,
  /\bselect\b[\s\S]*\bfrom\b/i,
  /(^|[\s(])\/[a-z][a-z0-9_-]*\//i,
  /[A-Za-z]:\\[^\s]+/,
  /\bat\s+\S+\s+\(.*:\d+:\d+\)/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i,
  /\b(nq_|sk-|gsk_)[A-Za-z0-9_-]{6,}/,
];

/** True when a string carries something a caller must not see. */
export function looksInternal(text: string): boolean {
  return INTERNAL_TEXT.some((pattern) => pattern.test(text));
}

/**
 * Turns whatever a tool threw into a client-safe reason plus a server-side log entry naming the
 * tool. A failure must always be actionable for the agent (which field, which permission) and
 * always leave a trace on the server, because the caller's transcript is not ours to keep.
 *
 * Unexpected failures — and any message that looks like SQL, a path or a token — become one generic
 * sentence with a short reference code. The full detail stays in the log, joined by that reference.
 */
export function reportToolError(tool: string, error: unknown): ToolFailure {
  if (error instanceof AppError && !looksInternal(error.message)) {
    console.error(
      `[agent] tool=${tool} code=${error.code} status=${error.status} reason=${error.message}`,
    );
    return { message: error.message, code: error.code, status: error.status };
  }

  const reference = `err_${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const name =
    error instanceof AppError
      ? `AppError(${error.code})`
      : error instanceof Error
        ? error.name
        : typeof error;
  const reason = error instanceof Error ? error.message : String(error);
  console.error(
    `[agent] tool=${tool} code=internal_error status=500 reference=${reference} reason=${name}: ${reason}`,
  );

  return {
    message: `${tool} failed inside Growth, so nothing was written. Reference ${reference}. This is a fault on our side, not in your request.`,
    code: "internal_error",
    status: 500,
    reference,
  };
}
