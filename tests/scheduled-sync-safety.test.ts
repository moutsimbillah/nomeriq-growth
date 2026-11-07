import { afterEach, expect, it, vi } from "vitest";

const writers = vi.hoisted(() => ({
  getDb: vi.fn(() => { throw new Error("No database access from disabled scheduler"); }),
  syncEmailAccount: vi.fn(() => { throw new Error("No mailbox operations from disabled scheduler"); }),
  listEmailAccounts: vi.fn(() => { throw new Error("No account enumeration from disabled scheduler"); }),
}));
vi.mock("@/lib/db/client", () => ({ getDb: writers.getDb }));
vi.mock("@/lib/email/sync", () => ({ syncEmailAccount: writers.syncEmailAccount }));
vi.mock("@/lib/email/accounts", () => ({ listEmailAccounts: writers.listEmailAccounts }));
import { GET } from "@/app/api/cron/sync/route";

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

it("an authenticated automated caller cannot start any mailbox or database writer", async () => {
  const secret = crypto.randomUUID();
  vi.stubEnv("CRON_SECRET", secret);
  const response = await GET(new Request("http://localhost:3100/api/cron/sync", {
    headers: { authorization: `Bearer ${secret}` },
  }));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ ok: false, code: "scheduled_sync_unavailable" });
  for (const writer of Object.values(writers)) expect(writer).not.toHaveBeenCalled();
});

it("missing configuration and incorrect credentials remain fail-closed without side effects", async () => {
  vi.stubEnv("CRON_SECRET", "");
  expect((await GET(new Request("http://localhost:3100/api/cron/sync"))).status).toBe(503);
  vi.stubEnv("CRON_SECRET", crypto.randomUUID());
  expect((await GET(new Request("http://localhost:3100/api/cron/sync"))).status).toBe(401);
  for (const writer of Object.values(writers)) expect(writer).not.toHaveBeenCalled();
});
