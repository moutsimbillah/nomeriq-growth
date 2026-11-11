import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { runAgentAction } from "@/lib/agent/service";
import {
  AUDIT_CAP_PER_WINDOW,
  AUDIT_GLOBAL_CAP_PER_WINDOW,
  __shiftAuditWindow,
  __shiftGlobalAuditWindow,
  logAgentAction,
} from "@/lib/agent/apiKeys";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import { assessmentFor } from "./helpers/lead-assessment";

/**
 * Every tool call leaves one audit entry saying what happened: ok, denied, invalid or internal, with
 * the flags that let a run be graded from the log — created, duplicate, preserved, and the duplicate
 * flag from check_duplicate. Never an argument value, never a request body.
 */

const SCOPES = ["research:read", "research:write", "drafts:write", "product_truth:read", "progress:read"];
const KEY = { id: "oauth:nq_outcomes", name: "Claude", assistant: "custom" as const, scopes: SCOPES };

function payload(name: string, domain: string) {
  return {
    businessName: name,
    websiteUrl: `https://${domain}`,
    categories: ["forex"],
    signalDescription: `${name} sells paid trading signal subscriptions to retail traders.`,
    email: `contact@${domain}`,
    emailSourceType: "official_website",
    emailSourceUrl: `https://${domain}/contact`,
    leadAssessment: assessmentFor(`https://${domain}`),
    sources: [{ url: `https://${domain}/pricing`, label: "Official pricing page" }],
  };
}

async function entriesFor(actorId: string, action?: string) {
  const db = await getDb();
  const rows = await db.query<{ action: string; metadata: Record<string, unknown> }>(
    `SELECT action, metadata FROM audit_log WHERE actor_id = $1 ${action ? "AND action = $2" : ""}
     ORDER BY created_at`,
    action ? [actorId, action] : [actorId],
  );
  return rows.rows;
}

afterAll(async () => {
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) await fs.rm(dir, { recursive: true, force: true });
});

beforeAll(async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await ensureWorkspaceDefaults();
});

describe("a successful call records what it did", () => {
  it("records ok, created and duplicate:false for a new prospect", async () => {
    await runAgentAction(KEY as never, "save_prospect", payload("Outcome Co", "outcome.example"));

    const rows = await entriesFor(KEY.id, "save_prospect");
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.outcome).toBe("ok");
    expect(rows[0].metadata.created).toBe(true);
    expect(rows[0].metadata.duplicate).toBe(false);
    expect(rows[0].metadata.client).toBe("Claude");
    // Argument names only — no values, no body.
    expect(rows[0].metadata.args).toEqual(expect.arrayContaining(["businessName", "email"]));
    expect(JSON.stringify(rows[0].metadata)).not.toContain("contact@outcome.example");
  });

  it("records duplicate:true when the same lead is saved twice", async () => {
    await runAgentAction(KEY as never, "save_prospect", payload("Outcome Duplicate Co", "outcome-dup.example"));
    const again = await runAgentAction(KEY as never, "save_prospect", payload("Outcome Duplicate Co", "outcome-dup.example"));
    expect((again.data as { duplicate: boolean }).duplicate).toBe(true);

    const rows = await entriesFor(KEY.id, "save_prospect");
    const last = rows[rows.length - 1];
    expect(last.metadata.outcome).toBe("ok");
    expect(last.metadata.created).toBe(false);
    expect(last.metadata.duplicate).toBe(true);
  });

  it("records created and preserved for a draft", async () => {
    const saved = await runAgentAction(KEY as never, "save_prospect", payload("Outcome Draft Co", "outcome-draft.example"));
    const prospectId = (saved.data as { prospect: { id: string } }).prospect.id;
    await runAgentAction(KEY as never, "save_draft", {
      prospectId,
      subject: "First contact",
      body: "A draft long enough to be accepted by the draft writer, with a question at the end?",
    });

    const rows = await entriesFor(KEY.id, "save_draft");
    expect(rows[0].metadata.outcome).toBe("ok");
    expect(rows[0].metadata.created).toBe(true);
    expect(rows[0].metadata.preserved).toBe(false);
  });

  it("records the duplicate flag from check_duplicate", async () => {
    await runAgentAction(KEY as never, "check_duplicate", {
      businessName: "Nothing Like This Exists",
      websiteUrl: "https://nothing-like-this.example",
    });

    const rows = await entriesFor(KEY.id, "check_duplicate");
    expect(rows[0].metadata.outcome).toBe("ok");
    expect(rows[0].metadata.duplicate).toBe(false);
  });
});

describe("a call that did not succeed says why", () => {
  it("records a permission problem as denied, with the code", async () => {
    const readOnly = { ...KEY, id: "oauth:nq_outcomes_readonly", scopes: ["research:read"] };
    await runAgentAction(readOnly as never, "save_prospect", payload("Denied Co", "denied.example")).catch(() => undefined);

    const rows = await entriesFor(readOnly.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.outcome).toBe("denied");
    expect(rows[0].metadata.code).toBe("insufficient_scope");
    expect(String(rows[0].metadata.reference ?? "")).toBe("");
  });

  it("records bad arguments as invalid, naming no values", async () => {
    await runAgentAction(KEY as never, "save_prospect", { businessName: "x" }).catch(() => undefined);

    const rows = await entriesFor(KEY.id, "save_prospect");
    const last = rows[rows.length - 1];
    expect(last.metadata.outcome).toBe("invalid");
    expect(last.metadata.code).toBe("invalid_arguments");
  });

  it("records our own fault as internal, with a reference to match the caller's message", async () => {
    await logAgentAction({
      key: KEY as never,
      action: "save_prospect",
      outcome: "internal",
      code: "internal_error",
      reference: "err_deadbeef",
    });

    const rows = await entriesFor(KEY.id, "save_prospect");
    const last = rows[rows.length - 1];
    expect(last.metadata.outcome).toBe("internal");
    expect(last.metadata.reference).toBe("err_deadbeef");
  });
});

describe("the write cap", () => {
  it("counts calls beyond the cap instead of writing them, and reports the count", async () => {
    const busy = { ...KEY, id: "oauth:nq_outcomes_busy" };
    for (let i = 0; i < AUDIT_CAP_PER_WINDOW + 3; i += 1) {
      await logAgentAction({ key: busy as never, action: "get_instructions", outcome: "ok" });
    }

    const rows = await entriesFor(busy.id, "get_instructions");
    expect(rows).toHaveLength(AUDIT_CAP_PER_WINDOW);

    // The next minute's first entry carries how many were suppressed.
    __shiftAuditWindow(busy.id);
    await logAgentAction({ key: busy as never, action: "get_instructions", outcome: "ok" });

    const after = await entriesFor(busy.id, "get_instructions");
    expect(after).toHaveLength(AUDIT_CAP_PER_WINDOW + 1);
    expect(after[after.length - 1].metadata.suppressedSince).toBe(3);
  });

  it("caps total writes, so a flood of clients cannot fill the table", async () => {
    const db = await getDb();
    const total = async () =>
      (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_log`)).rows[0].n;

    // Start a fresh global window, then flood it from many distinct clients: each one has its own
    // per-client allowance, so only the global cap can stop this.
    __shiftGlobalAuditWindow();
    const before = await total();
    for (let i = 0; i < AUDIT_GLOBAL_CAP_PER_WINDOW + 2; i += 1) {
      await logAgentAction({
        key: { ...KEY, id: `oauth:nq_flood_${i}` } as never,
        action: "get_instructions",
        outcome: "ok",
      });
    }
    const after = await total();
    expect(after - before).toBe(AUDIT_GLOBAL_CAP_PER_WINDOW);

    // The next window's first entry reports what the cap swallowed.
    __shiftGlobalAuditWindow();
    const next = { ...KEY, id: "oauth:nq_after_flood" };
    await logAgentAction({ key: next as never, action: "get_instructions", outcome: "ok" });
    const rows = await entriesFor(next.id, "get_instructions");
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.suppressedGlobalSince).toBe(2);
  });

  it("caps each client separately", async () => {
    const other = { ...KEY, id: "oauth:nq_outcomes_other" };
    await logAgentAction({ key: other as never, action: "get_instructions", outcome: "ok" });
    expect(await entriesFor(other.id, "get_instructions")).toHaveLength(1);
  });
});