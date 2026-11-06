import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
const { editor } = vi.hoisted(() => ({ editor: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireEditor: editor }));
import { POST } from "@/app/api/settings/provider-models/route";
import { AppError } from "@/lib/utils";
const key = randomBytes(24).toString("hex");
const request = (origin = "http://localhost:3100") => new Request("http://localhost:3100/api/settings/provider-models", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify({ provider: "custom", baseUrl: "https://gateway.example.test/v1", apiKey: key }) });
beforeEach(() => { editor.mockResolvedValue({ id: "fixture" }); });
afterEach(() => vi.unstubAllGlobals());
it("returns exact model IDs only, never the submitted credential", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "exact-model" }] }))));
  const response = await POST(request());
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(JSON.parse(text)).toEqual({ ok: true, data: { models: ["exact-model"] } });
  expect(text).not.toContain(key);
});
it("refuses cross-origin discovery without calling the provider", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  expect((await POST(request("https://attacker.example.test"))).status).toBe(403);
  expect(fetcher).not.toHaveBeenCalled();
});
it("requires editor authorization", async () => {
  editor.mockRejectedValue(new AppError("Not authorized", 403, "forbidden"));
  expect((await POST(request())).status).toBe(403);
});
it("does not echo a remote failure body", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: `Private fixture ${key}` } }), { status: 400 })));
  const response = await POST(request());
  const text = await response.text();
  expect(response.status).toBe(502);
  expect(text).not.toContain(key);
  expect(text).not.toContain("Private fixture");
});
