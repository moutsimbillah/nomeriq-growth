import { afterEach, expect, it, vi } from "vitest";
import { AppError } from "@/lib/utils";

const mocks = vi.hoisted(() => ({ editor: vi.fn(), test: vi.fn(), config: vi.fn(), jobs: vi.fn(), usage: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireEditor: mocks.editor }));
vi.mock("@/lib/services/research-routing", () => ({ testLeadResearchConnection: mocks.test, getResearchConfiguration: mocks.config }));
vi.mock("@/lib/services/research", () => ({ listResearchJobs: mocks.jobs }));
vi.mock("@/lib/services/research-usage", () => ({ getAllResearchUsage: mocks.usage }));
import { POST } from "@/app/api/research/test-connection/route";
import { GET } from "@/app/api/research/status/route";
const origin = "http://localhost:3100";
function request(from = origin) {
  return new Request(`${origin}/api/research/test-connection`, { method: "POST", headers: { origin: from }, body: JSON.stringify({ providerId: crypto.randomUUID(), model: "attacker-model", apiKey: crypto.randomUUID() }) });
}
afterEach(() => vi.resetAllMocks());
it("rejects cross-origin tests before provider resolution/network", async () => {
  expect((await POST(request("https://untrusted.test"))).status).toBe(403);
  expect(mocks.test).not.toHaveBeenCalled();
});
it("rejects unauthenticated callers before provider resolution/network", async () => {
  mocks.editor.mockRejectedValue(new AppError("Sign in", 401, "unauthorized"));
  expect((await POST(request())).status).toBe(401);
  expect(mocks.test).not.toHaveBeenCalled();
});
it("explicit test ignores arbitrary client provider/key/model, resolving server-side only", async () => {
  mocks.test.mockResolvedValue({ ok: false, message: "Fetch failed", results: [] });
  const response = await POST(request());
  expect(response.status).toBe(200);
  expect(mocks.test).toHaveBeenCalledExactlyOnceWith();
  expect((await response.json()).data.ok).toBe(false);
});
it("status reads configuration without executing a connection test", async () => {
  mocks.config.mockResolvedValue({ configured: true, selected: { name: "Synthetic", model: "deepseek-flash" } });
  mocks.jobs.mockResolvedValue([]); mocks.usage.mockResolvedValue({ costUsd: 0 });
  expect((await GET()).status).toBe(200);
  expect(mocks.config).toHaveBeenCalledOnce();
  expect(mocks.test).not.toHaveBeenCalled();
});
