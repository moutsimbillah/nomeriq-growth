import { afterAll, beforeAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs/promises";

import { closeDb, getDb } from "@/lib/db/client";
import { runAgentAction, TOOL_DEFINITIONS } from "@/lib/agent/service";
import { ensureWorkspaceDefaults } from "@/lib/services/settings";
import {
  getJobQueryLedger,
  isQueryRecentlyUsed,
  normalizeQuery,
  recordQueryOutcome,
  recordQueryPlanned,
} from "@/lib/services/research-ledger";

const state = {
  jobA: "",
  jobB: "",
};

beforeAll(async () => {
  const db = await getDb();
  await ensureWorkspaceDefaults();

  state.jobA = crypto.randomUUID();
  state.jobB = crypto.randomUUID();

  for (const [id, name] of [
    [state.jobA, "Ledger A"],
    [state.jobB, "Ledger B"],
  ] as const) {
    await db.query(
      `INSERT INTO research_jobs (id, name, target_count, categories, status)
       VALUES ($1, $2, 10, '[]'::jsonb, 'active')`,
      [id, name],
    );
  }
});

afterAll(async () => {
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("research ledger", () => {
  it("normalizes a query so case and whitespace cannot hide a repeat", () => {
    expect(normalizeQuery("  Trading   Signals ")).toBe("trading signals");
    expect(normalizeQuery("trading signals")).toBe("trading signals");
    expect(normalizeQuery("TRADING SIGNALS")).toBe(normalizeQuery("trading  signals"));
  });

  it("is idempotent per job: planning the same query twice keeps one row", async () => {
    const first = await recordQueryPlanned({
      jobId: state.jobA,
      query: "idempotent ledger query",
    });
    const second = await recordQueryPlanned({
      jobId: state.jobA,
      query: "idempotent ledger query",
    });

    expect(second).toBe(first);

    const ledger = await getJobQueryLedger(state.jobA);
    const rows = ledger.filter((entry) => entry.query === "idempotent ledger query");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
  });

  it("keeps the same query separate in two different jobs", async () => {
    await recordQueryPlanned({ jobId: state.jobA, query: "shared across jobs" });
    await recordQueryPlanned({ jobId: state.jobB, query: "shared across jobs" });

    const rowsA = (await getJobQueryLedger(state.jobA)).filter(
      (entry) => entry.query === "shared across jobs",
    );
    const rowsB = (await getJobQueryLedger(state.jobB)).filter(
      (entry) => entry.query === "shared across jobs",
    );

    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0]!.id).not.toBe(rowsB[0]!.id);
  });

  it("records a used outcome with its counts and a used_at timestamp", async () => {
    await recordQueryPlanned({ jobId: state.jobA, query: "used outcome query" });
    await recordQueryOutcome({
      jobId: state.jobA,
      query: "used outcome query",
      status: "used",
      resultCount: 12,
      newLeadCount: 3,
    });

    const row = (await getJobQueryLedger(state.jobA)).find(
      (entry) => entry.query === "used outcome query",
    );

    expect(row).toBeTruthy();
    expect(row!.status).toBe("used");
    expect(row!.resultCount).toBe(12);
    expect(row!.newLeadCount).toBe(3);
    expect(row!.usedAt).toBeTruthy();
  });

  it("records a failed outcome with its error and no used_at", async () => {
    await recordQueryPlanned({ jobId: state.jobA, query: "failed outcome query" });
    await recordQueryOutcome({
      jobId: state.jobA,
      query: "failed outcome query",
      status: "failed",
      error: "DeepSeek search returned 402",
    });

    const row = (await getJobQueryLedger(state.jobA)).find(
      (entry) => entry.query === "failed outcome query",
    );

    expect(row).toBeTruthy();
    expect(row!.status).toBe("failed");
    expect(row!.error).toContain("402");
    expect(row!.usedAt).toBeNull();
  });

  it("guards against repeats across jobs, ignoring case and spacing", async () => {
    const query = "repeat guard query";

    expect((await isQueryRecentlyUsed(query)).used).toBe(false);

    await recordQueryOutcome({
      jobId: state.jobB,
      query,
      status: "used",
      resultCount: 8,
    });

    const recent = await isQueryRecentlyUsed("  REPEAT   guard QUERY ");
    expect(recent.used).toBe(true);
    expect(recent.jobId).toBe(state.jobB);
    expect(recent.lastUsedAt).toBeTruthy();
  });

  it("does not treat a failed query as a repeat", async () => {
    const query = "only failed once";
    await recordQueryOutcome({
      jobId: state.jobA,
      query,
      status: "failed",
      error: "timeout",
    });

    expect((await isQueryRecentlyUsed(query)).used).toBe(false);
  });

  it("forgets a use that falls outside the window", async () => {
    const db = await getDb();
    const query = "old search from last month";

    await recordQueryOutcome({
      jobId: state.jobA,
      query,
      status: "used",
      resultCount: 5,
    });

    expect((await isQueryRecentlyUsed(query)).used).toBe(true);

    await db.query(
      `UPDATE research_queries SET used_at = now() - interval '40 days'
       WHERE query_key = $1`,
      [normalizeQuery(query)],
    );

    expect((await isQueryRecentlyUsed(query)).used).toBe(false);
    expect((await isQueryRecentlyUsed(query, 45)).used).toBe(true);
  });

  it("returns only the requested job's ledger entries", async () => {
    const ledger = await getJobQueryLedger(state.jobB);
    const queries = ledger.map((entry) => entry.query);

    expect(queries).toContain("shared across jobs");
    expect(queries).toContain("repeat guard query");
    expect(queries).not.toContain("failed outcome query");
    expect(ledger.every((entry) => entry.jobId === state.jobB)).toBe(true);
  });
});

describe("MCP ledger tools", () => {
  const reader = {
    id: "test-reader",
    name: "Reader",
    assistant: "claude" as const,
    scopes: ["research:read"],
  };
  const writer = {
    id: "test-writer",
    name: "Writer",
    assistant: "chatgpt" as const,
    scopes: ["research:read", "research:write"],
  };

  it("exposes both ledger tools and still exposes no send or delete capability", () => {
    const names = TOOL_DEFINITIONS.map((tool) => tool.name);

    expect(names).toContain("check_search_query");
    expect(names).toContain("record_search_query");
    expect(names.some((name) => /send|delete|remove|destroy/i.test(name))).toBe(false);
  });

  it("answers check_search_query from the ledger", async () => {
    const query = "mcp visible query";
    await recordQueryOutcome({
      jobId: state.jobA,
      query,
      status: "used",
      resultCount: 4,
    });

    const fresh = await runAgentAction(reader, "check_search_query", {
      query: "  MCP   visible QUERY ",
    });
    expect(fresh.data.used).toBe(true);
    expect(fresh.data.jobId).toBe(state.jobA);
    expect(fresh.data.normalized).toBe(normalizeQuery(query));

    const never = await runAgentAction(reader, "check_search_query", {
      query: "a query nobody has ever run",
    });
    expect(never.data.used).toBe(false);
  });

  it("refuses record_search_query without research:write", async () => {
    await expect(
      runAgentAction(reader, "record_search_query", {
        jobId: state.jobA,
        query: "reader cannot write this",
        status: "used",
      }),
    ).rejects.toMatchObject({ code: "insufficient_scope", status: 403 });
  });

  it("records a search through the tool when the key has research:write", async () => {
    const query = "written through the mcp tool";
    const written = await runAgentAction(writer, "record_search_query", {
      jobId: state.jobA,
      query,
      status: "used",
      resultCount: 7,
      newLeadCount: 2,
    });

    expect(written.data.recorded).toBe(true);
    expect(String(written.data.message)).toContain("Nothing was sent");

    const row = (await getJobQueryLedger(state.jobA)).find((entry) => entry.query === query);
    expect(row).toBeTruthy();
    expect(row!.status).toBe("used");
    expect(row!.resultCount).toBe(7);
    expect(row!.newLeadCount).toBe(2);
  });
});