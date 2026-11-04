import { createHash } from "node:crypto";

/**
 * The archive's surrogate id, for the ten exported tables that have none of their own.
 *
 * Those tables are keyed by what the exporter itself ordered them by — `target_key`,
 * `account_id,message_id`, `dispatch_id`, `identity_id`, `source_id`, `suggestion_id`, `draft_id`,
 * `proposal_id`, `approval_id`. That tuple was measured to be unique across every row of each file
 * (rows == distinct keys, no nulls in any key column), so hashing it gives an id that is both unique
 * and deterministic: the same row yields the same id on every run, which is what makes a re-run of the
 * import idempotent instead of duplicating the archive.
 *
 * The key is hashed as a JSON array of its values, in the declared order, NOT as joined text. Joining
 * would let two different rows collide: ("a", "bc") and ("ab", "c") both concatenate to "abc". The
 * array keeps the boundary between the values, so those two are different inputs — a test pins it.
 *
 * Absent or null key values are refused rather than hashed: a null carries no identity, and silently
 * hashing it would put unrelated rows in the same bucket.
 */

export class ArchiveKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveKeyError";
  }
}

/** Stable JSON for one value: object key order cannot change the result. */
function canonical(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value); // strings, numbers, booleans — typed, so "1" and 1 differ
}

/**
 * `sha256:<hex>` for a row keyed by `orderBy`. The prefix says what the value is, so a hand-copied id
 * is recognisable next to the old portal's own uuids in the 37 tables that have one.
 */
export function archiveRowId(table: string, row: Record<string, unknown>, orderBy: string[]): string {
  if (!orderBy.length) {
    throw new ArchiveKeyError(`No key columns declared for ${table}.`);
  }
  const values = orderBy.map((column) => {
    const value = row[column];
    if (value === undefined || value === null) {
      throw new ArchiveKeyError(`${table}: key column "${column}" is missing or null.`);
    }
    return value;
  });
  const digest = createHash("sha256").update(`legacy:${table}:${canonical(values)}`).digest("hex");
  return `sha256:${digest}`;
}

/** The id an archived row must carry: its own, or the derived one. */
export function archivedRowId(
  table: string,
  row: Record<string, unknown>,
  orderBy: string[],
): string {
  const own = row.id;
  if (typeof own === "string" && own.trim()) return own.trim();
  return archiveRowId(table, row, orderBy);
}