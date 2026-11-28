import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const smtp = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
  close: vi.fn(),
  mode: "sandbox" as "sandbox" | "live",
}));

vi.mock("nodemailer", () => ({ default: { createTransport: smtp.createTransport } }));
vi.mock("@/lib/auth/crypto", () => ({ decryptSecret: () => "" }));
vi.mock("@/lib/services/settings", () => ({
  getEmailDeliveryMode: async () => smtp.mode,
}));

import type { EmailAccountRecord } from "@/lib/email/accounts";
import { deliverEmail } from "@/lib/email/send-provider";

const account = {
  provider: "ionos",
  passwordEncrypted: "",
  smtpHost: "smtp.example.test",
  smtpPort: 587,
  smtpSecure: false,
  username: "",
  fromName: "Test sender",
  emailAddress: "sender@example.test",
  replyTo: null,
} as unknown as EmailAccountRecord;

const email = {
  to: "recipient@example.test",
  subject: "Mode check",
  text: "Test only",
  html: "<p>Test only</p>",
  messageId: "<mode-check@example.test>",
  headers: {},
};

beforeEach(() => {
  smtp.mode = "sandbox";
  smtp.sendMail.mockResolvedValue({ messageId: "<accepted@example.test>", response: "250 accepted" });
  smtp.createTransport.mockReturnValue({ sendMail: smtp.sendMail, close: smtp.close });
});
afterEach(() => vi.clearAllMocks());

describe("email delivery provider mode", () => {
  it("records but does not open SMTP in sandbox mode", async () => {
    const result = await deliverEmail(account, email);
    expect(result.mode).toBe("sandbox");
    expect(smtp.createTransport).not.toHaveBeenCalled();
    expect(smtp.sendMail).not.toHaveBeenCalled();
  });

  it("opens SMTP only when the stored workspace mode is live and the account is real", async () => {
    smtp.mode = "live";
    const result = await deliverEmail(account, email);
    expect(result.mode).toBe("live");
    expect(smtp.createTransport).toHaveBeenCalledOnce();
    expect(smtp.sendMail).toHaveBeenCalledOnce();
    expect(smtp.close).toHaveBeenCalledOnce();
  });

  it("never opens SMTP for a sandbox mailbox even when workspace mode is live", async () => {
    smtp.mode = "live";
    const result = await deliverEmail({ ...account, provider: "sandbox" } as EmailAccountRecord, email);
    expect(result.mode).toBe("sandbox");
    expect(smtp.createTransport).not.toHaveBeenCalled();
    expect(smtp.sendMail).not.toHaveBeenCalled();
  });
});
