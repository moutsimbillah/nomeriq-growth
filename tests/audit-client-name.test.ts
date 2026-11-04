import { describe, expect, it } from "vitest";

import { sanitizeClientName } from "@/lib/agent/apiKeys";

/**
 * The client name is supplied by the client itself, so it is untrusted text that ends up in audit
 * metadata and in any report built from it.
 */
describe("sanitizeClientName", () => {
  it("strips control characters and line breaks so an entry cannot be forged across lines", () => {
    const raw = "Claude\n2026-01-01 admin\tauth.login\r\u0000\u001b[31m";
    const safe = sanitizeClientName(raw);

    expect(safe).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(safe).not.toContain("\n");
    expect(safe).not.toContain("\r");
    expect(safe).toBe("Claude 2026-01-01 admin auth.login [31m");
  });

  it("truncates to 80 characters", () => {
    const safe = sanitizeClientName("x".repeat(500));
    expect(safe).toHaveLength(80);
  });

  it("collapses runs of whitespace and trims the ends", () => {
    expect(sanitizeClientName("  ChatGPT     connector  ")).toBe("ChatGPT connector");
  });

  it("leaves an ordinary name untouched", () => {
    expect(sanitizeClientName("Gemini")).toBe("Gemini");
  });
});