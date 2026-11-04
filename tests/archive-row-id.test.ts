import { describe, expect, it } from "vitest";

import { archiveRowId, archivedRowId, ArchiveKeyError } from "@/lib/import/rowId";

/**
 * The archive's id for a table that has none: derived from the exporter's own key columns.
 *
 * It must be deterministic (so a second import updates rather than duplicates) and it must not collide
 * — including the case that a naive implementation gets wrong.
 */

const TABLE = "marketing_conversation_links";
const KEY = ["account_id", "message_id"];

describe("the archive's derived row id", () => {
  it("is deterministic: the same row yields the same id, every time", () => {
    const row = { account_id: "a-1", message_id: "<m@x>" };
    expect(archiveRowId(TABLE, row, KEY)).toBe(archiveRowId(TABLE, { ...row }, KEY));
    // and the object's own key order is irrelevant
    const reordered = { message_id: "<m@x>", account_id: "a-1" };
    expect(archiveRowId(TABLE, reordered, KEY)).toBe(archiveRowId(TABLE, row, KEY));
  });

  it("cannot be made to collide by joining the values together", () => {
    // The classic collision: concatenated without boundaries, both of these are "abc".
    const first = archiveRowId(TABLE, { account_id: "a", message_id: "bc" }, KEY);
    const second = archiveRowId(TABLE, { account_id: "ab", message_id: "c" }, KEY);
    expect(first).not.toBe(second);

    // the same trap with an empty half
    const left = archiveRowId(TABLE, { account_id: "", message_id: "x" }, KEY);
    const right = archiveRowId(TABLE, { account_id: "x", message_id: "" }, KEY);
    expect(left).not.toBe(right);
  });

  it("tells a number from the string that looks like it", () => {
    const asNumber = archiveRowId(TABLE, { account_id: 1, message_id: "m" }, KEY);
    const asString = archiveRowId(TABLE, { account_id: "1", message_id: "m" }, KEY);
    expect(asNumber).not.toBe(asString);
  });

  it("refuses a missing or null key rather than bucketing those rows together", () => {
    expect(() => archiveRowId(TABLE, { account_id: "a", message_id: null }, KEY)).toThrow(ArchiveKeyError);
    expect(() => archiveRowId(TABLE, { account_id: "a" }, KEY)).toThrow(ArchiveKeyError);
    expect(() => archiveRowId(TABLE, { account_id: "a", message_id: "m" }, [])).toThrow(ArchiveKeyError);
  });

  it("gives one distinct id per row for each of the ten tables that have no id column", () => {
    const tables: [string, string[], Record<string, unknown>][] = [
      ["marketing_conversation_attention", ["target_key"], { target_key: "t-1" }],
      ["marketing_conversation_links", ["account_id", "message_id"], { account_id: "a", message_id: "m" }],
      ["marketing_email_preflight_blocks", ["dispatch_id"], { dispatch_id: "d-1" }],
      ["marketing_email_transport_evidence", ["dispatch_id"], { dispatch_id: "d-2" }],
      ["marketing_identity_corroborations", ["identity_id"], { identity_id: "i-1" }],
      ["marketing_reply_excerpts", ["source_id"], { source_id: "s-1" }],
      ["marketing_reply_suggestion_decisions", ["suggestion_id"], { suggestion_id: "g-1" }],
      ["marketing_sales_draft_bindings", ["draft_id"], { draft_id: "r-1" }],
      ["marketing_sales_proposal_bindings", ["proposal_id"], { proposal_id: "p-1" }],
      ["marketing_workspace_revocations", ["approval_id"], { approval_id: "v-1" }],
    ];
    const ids = tables.map(([table, keys, row]) => archiveRowId(table, row, keys));
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("uses the row's own id when it has one, and derives otherwise", () => {
    expect(archivedRowId("marketing_prospects", { id: "6f0c2b7e-0000-4000-8000-000000000001" }, ["id"])).toBe(
      "6f0c2b7e-0000-4000-8000-000000000001",
    );
    const derived = archivedRowId(TABLE, { account_id: "a", message_id: "m" }, KEY);
    expect(derived).toMatch(/^sha256:/);
  });
});