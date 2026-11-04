import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";

import { closeDb } from "@/lib/db/client";
import { runAgentAction } from "@/lib/agent/service";
import { reportToolError } from "@/lib/agent/toolErrors";
import { AppError } from "@/lib/utils";

/**
 * A tool failure has to say why — which field, which permission, or that it broke on our side — and
 * it has to leave a trace on the server. It must never hand the caller a stack trace, a driver
 * message or a parameter value.
 */

const FULL_KEY = {
  id: "11111111-2222-3333-4444-555555555555",
  name: "Hermes laptop",
  assistant: "hermes" as const,
  scopes: ["research:read"],
};

afterAll(async () => {
  await closeDb();
  const dir = process.env.PGLITE_DIR;
  if (dir && dir.startsWith(".data/test-vitest-")) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

beforeAll(async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

describe("a failed tool call explains itself", () => {
  it("names the field and the reason when the input is wrong", async () => {
    // research:write, so the scope check passes and the input check is what rejects it.
    const writer = { ...FULL_KEY, scopes: ["research:read", "research:write"] };
    const failure = await runAgentAction(writer as never, "save_prospect", {}).catch((e) => e);

    expect(failure).toBeInstanceOf(AppError);
    expect(failure.code).toBe("invalid_arguments");
    // The field names the caller has to fix, not a generic "invalid input".
    expect(failure.message).toContain("businessName");
    expect(failure.message).toContain("sources");
    expect(failure.message).toContain("Invalid arguments");
  });

  it("names the missing permission when the key lacks a scope", async () => {
    const failure = await runAgentAction(FULL_KEY as never, "save_draft", {
      prospectId: "11111111-2222-3333-4444-555555555555",
      subject: "Hello",
      body: "A body long enough to pass validation.",
    }).catch((e) => e);

    expect(failure).toBeInstanceOf(AppError);
    expect(failure.status).toBe(403);
    expect(failure.code).toBe("insufficient_scope");
    expect(failure.message).toContain("drafts:write");
  });
});

describe("reportToolError", () => {
  it("passes an AppError through and logs the tool with its code", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = reportToolError("save_prospect", new AppError("Invalid arguments: email — Required", 400, "invalid_arguments"));

    expect(failure).toEqual({
      message: "Invalid arguments: email — Required",
      code: "invalid_arguments",
      status: 400,
    });
    expect(log.mock.calls[0][0]).toContain("tool=save_prospect");
    expect(log.mock.calls[0][0]).toContain("code=invalid_arguments");
    expect(log.mock.calls[0][0]).toContain("reason=Invalid arguments: email — Required");
  });

  it("keeps a driver message off the wire, logs it, and returns a reference code", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const driverError = new Error('invalid input syntax for type uuid: "oauth:nq_leak"');

    const failure = reportToolError("save_prospect", driverError);

    expect(failure.code).toBe("internal_error");
    expect(failure.status).toBe(500);
    expect(failure.reference).toMatch(/^err_[0-9a-f]{8}$/);
    // The caller learns that it failed, that nothing was written, and a code to quote.
    expect(failure.message).toContain("save_prospect");
    expect(failure.message).toContain(failure.reference as string);
    expect(failure.message).not.toContain("uuid");
    expect(failure.message).not.toContain("oauth:");
    expect(failure.message).not.toContain("    at ");
    // The server log carries the real reason, joined to the same reference.
    expect(log.mock.calls[0][0]).toContain("tool=save_prospect");
    expect(log.mock.calls[0][0]).toContain("internal_error");
    expect(log.mock.calls[0][0]).toContain(`reference=${failure.reference}`);
    expect(log.mock.calls[0][0]).toContain("invalid input syntax for type uuid");
  });

  it("replaces an AppError message that carries SQL, a path or a token", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const leaks = [
      'insert into "prospects" ("created_by_key_id") values ($1) failed',
      'relation "drafts" does not exist',
      "column created_by_key_id is of type uuid but expression is of type text",
      "connect ECONNREFUSED /home/growth/.env.production",
      "Authorization: Bearer nq_9f8e7d6c5b4a",
      "at Object.saveProspect (/home/growth/app/.next/server/chunks/9.js:1:2345)",
    ];

    for (const leak of leaks) {
      const failure = reportToolError("save_prospect", new AppError(leak, 500, "boom"));
      expect(failure.code).toBe("internal_error");
      expect(failure.message).not.toContain("insert into");
      expect(failure.message).not.toContain('"prospects"');
      expect(failure.message).not.toContain("created_by_key_id");
      expect(failure.message).not.toContain("/home/growth");
      expect(failure.message).not.toContain("nq_9f8e7d6c5b4a");
      expect(failure.message).not.toContain("at Object.saveProspect");
      expect(failure.message).toContain(failure.reference as string);
    }
    // Each one still reaches the log, with the tool and the code it came in with.
    expect(log.mock.calls[0][0]).toContain("tool=save_prospect");
    expect(log.mock.calls[0][0]).toContain("AppError(boom)");
  });

  it("keeps our own validation and permission messages exactly as written", () => {
    const cases = [
      new AppError("Invalid arguments: sources — Array must contain at least 1 element(s)", 400, "invalid_arguments"),
      new AppError("This API key lacks the drafts:write permission.", 403, "insufficient_scope"),
      new AppError("A valid published contact email is required.", 400),
    ];
    for (const appError of cases) {
      const failure = reportToolError("save_draft", appError);
      expect(failure.message).toBe(appError.message);
      expect(failure.reference).toBeUndefined();
    }
  });

  it("handles a thrown non-Error without leaking anything", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failure = reportToolError("list_research_jobs", "boom");

    expect(failure.code).toBe("internal_error");
    expect(failure.message).not.toContain("boom");
    expect(log.mock.calls[0][0]).toContain("reason=string: boom");
  });
});