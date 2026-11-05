import { beforeEach, it, expect, vi } from "vitest";
import { AppError } from "@/lib/utils";
import { POST } from "@/app/api/email/messages/[id]/translate/route";

const h = vi.hoisted(() => ({ editor: vi.fn(), translate: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({ requireEditor: h.editor }));
vi.mock("@/lib/services/message-translations", () => ({
  translateMessage: h.translate,
}));

const ID = "123e4567-e89b-42d3-a456-426614174000";
const params = Promise.resolve({ id: ID });
const req = (origin: string) =>
  new Request(`http://localhost:3100/api/email/messages/${ID}/translate`, {
    method: "POST",
    headers: { origin },
  });

beforeEach(() => {
  h.editor.mockReset().mockResolvedValue({ id: "fixture" });
  h.translate.mockReset().mockResolvedValue({
    ok: false,
    code: "provider_unavailable",
    reason: "Configure AI.",
  });
});

it("rejects a wrong origin without translating", async () => {
  const res = await POST(req("https://evil.example"), { params });
  expect(res.status).toBe(403);
  expect(h.translate).toHaveBeenCalledTimes(0);
});

it("rejects a signed-out editor with 401", async () => {
  h.editor.mockRejectedValue(new AppError("Sign in", 401, "unauthorized"));
  const res = await POST(req("http://localhost:3100"), { params });
  expect(res.status).toBe(401);
  expect(h.translate).toHaveBeenCalledTimes(0);
});

it("returns provider_unavailable when no provider is configured", async () => {
  const res = await POST(req("http://localhost:3100"), { params });
  expect(res.status).toBe(200);
  const json = await res.json();
  expect(json.data.code).toBe("provider_unavailable");
  expect(json.data.reason).toBe("Configure AI.");
});
