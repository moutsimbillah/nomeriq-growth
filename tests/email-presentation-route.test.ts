import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/utils";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), settings: vi.fn(), profile: vi.fn(), conversation: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireApiUser: mocks.auth }));
vi.mock("@/lib/services/settings", () => ({ getWorkspaceSettings: mocks.settings }));
vi.mock("@/lib/email/profiles", () => ({ resolveSendingProfile: mocks.profile }));
vi.mock("@/lib/services/conversations", () => ({ getConversation: mocks.conversation }));
import { GET } from "@/app/api/email-presentation/route";

const prospectId = "7731d836-e367-4e17-a953-a6f7f8d7c284";
const conversationId = "1376be94-1755-42a6-b6b6-d939230c5bc8";
const settings = {
  senderSignature: "Regards,\nFixture Founder", senderSignatureEnabled: true,
  postalAddress: "1 Fixture Road", postalAddressEnabled: true,
  legalBusinessName: "Fixture Business", footerNote: "Reply to opt out.",
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ id: "fixture-user" });
  mocks.settings.mockResolvedValue({ ...settings, timezone: "UTC", unrelatedInternalField: crypto.randomUUID() });
  mocks.profile.mockResolvedValue({ signature: "Mailbox Fixture", encryptedCredentials: crypto.randomUUID() });
  mocks.conversation.mockResolvedValue({ prospect: { id: prospectId } });
});

describe("read-only current email presentation", () => {
  it("requires a session before any private lookup", async () => {
    mocks.auth.mockRejectedValueOnce(new AppError("Sign in.", 401, "unauthorized"));
    const response = await GET(new Request(`http://localhost/api/email-presentation?prospectId=${prospectId}`));
    expect(response.status).toBe(401);
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.profile).not.toHaveBeenCalled();
    expect(mocks.conversation).not.toHaveBeenCalled();
  });
  it.each(["", "?prospectId=invalid", "?conversationId=invalid"])("rejects malformed identity lookup %s before reads", async query => {
    expect((await GET(new Request(`http://localhost/api/email-presentation${query}`))).status).toBe(400);
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.profile).not.toHaveBeenCalled();
  });
  it("returns an explicit safe allowlist, never the mailbox record or internal settings", async () => {
    const response = await GET(new Request(`http://localhost/api/email-presentation?prospectId=${prospectId}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toEqual({ ok: true, data: { settings, profileSignature: "Mailbox Fixture" } });
    expect(mocks.profile).toHaveBeenCalledWith({ prospectId, conversationId: null });
  });
  it("derives a reply's prospect and uses its conversation profile", async () => {
    const response = await GET(new Request(`http://localhost/api/email-presentation?conversationId=${conversationId}`));
    expect(response.status).toBe(200);
    expect(mocks.profile).toHaveBeenCalledWith({ prospectId, conversationId });
  });
  it("refuses a missing conversation without reading the identity", async () => {
    mocks.conversation.mockResolvedValueOnce(null);
    expect((await GET(new Request(`http://localhost/api/email-presentation?conversationId=${conversationId}`))).status).toBe(404);
    expect(mocks.settings).not.toHaveBeenCalled();
  });
  it("reads updated switches without rewriting any draft or calling a provider", async () => {
    const url = new Request(`http://localhost/api/email-presentation?prospectId=${prospectId}`);
    const first = await (await GET(url)).json();
    mocks.settings.mockResolvedValueOnce({ ...settings, senderSignatureEnabled: false, postalAddressEnabled: false });
    const next = await (await GET(url)).json();
    expect(first.data.settings.senderSignatureEnabled).toBe(true);
    expect(next.data.settings.senderSignatureEnabled).toBe(false);
    expect(next.data.settings.postalAddressEnabled).toBe(false);
    expect(next.data.settings.senderSignature).toBe(settings.senderSignature);
    expect(next.data.settings.postalAddress).toBe(settings.postalAddress);
  });
});
