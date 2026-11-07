import { beforeEach, describe, expect, it, vi } from "vitest";

const syncEmailAccount = vi.fn(async (accountId: string, options: unknown) => ({ accountId, options }));
const requireFounder = vi.fn(async () => ({ id: "founder-user" }));

vi.mock("@/lib/email/sync", () => ({ syncEmailAccount }));
vi.mock("@/lib/auth/request", () => ({ assertSameOrigin: () => undefined }));
vi.mock("@/lib/auth/session", () => ({ requireEditor: async () => ({ id: "editor-user" }), requireFounder }));

const { POST } = await import("@/app/api/email/accounts/[id]/sync/route");
const id = "7b0f4c5e-4c69-4a8e-9c3d-2f1f6f0f9a11";
const call = (body?: string) => POST(new Request(`http://localhost/api/email/accounts/${id}/sync`, { method: "POST", body }), { params: Promise.resolve({ id }) });

describe("mailbox sync route: recovery is explicit, linking and suppression never ride along", () => {
  beforeEach(() => { syncEmailAccount.mockClear(); requireFounder.mockClear(); });

  it("an empty Sync now stays incremental and does not ask for founder authority", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(syncEmailAccount).toHaveBeenCalledWith(id, { mode: "incremental" });
    expect(requireFounder).not.toHaveBeenCalled();
  });

  it("backfill needs the founder and the exact confirmation phrase", async () => {
    expect((await call(JSON.stringify({ mode: "backfill" }))).status).toBe(400);
    expect((await call(JSON.stringify({ mode: "backfill", confirmation: "yes" }))).status).toBe(400);
    expect(syncEmailAccount).not.toHaveBeenCalled();
    const ok = await call(JSON.stringify({ mode: "backfill", confirmation: "IMPORT FULL MAILBOX HISTORY" }));
    expect(ok.status).toBe(200);
    expect(requireFounder).toHaveBeenCalledOnce();
    expect(syncEmailAccount).toHaveBeenCalledWith(id, { mode: "backfill", founderUserId: "founder-user" });
  });

  it("refuses linking or historical-suppression flags and malformed bodies", async () => {
    for (const body of [
      JSON.stringify({ mode: "backfill", confirmation: "IMPORT FULL MAILBOX HISTORY", linkCertainAddresses: true }),
      JSON.stringify({ mode: "backfill", confirmation: "IMPORT FULL MAILBOX HISTORY", processHistoricalBounces: true }),
      JSON.stringify({ mode: "incremental", processHistoricalBounces: true }),
      "not json",
    ]) expect((await call(body)).status).toBe(400);
    expect(syncEmailAccount).not.toHaveBeenCalled();
  });
});
