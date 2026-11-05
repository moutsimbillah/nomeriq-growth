import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { translateOnArrival } from "@/lib/services/message-translations";

const MESSAGE_ID = "6f2f3c1a-0d5b-4e7a-9c48-1b2d3e4f5a99";

describe("translateOnArrival", () => {
  it("does nothing when the provider is an empty string", async () => {
    const translate = vi.fn();
    await translateOnArrival(MESSAGE_ID, { provider: "", translate });
    expect(translate).not.toHaveBeenCalled();
  });

  it("does nothing when the provider is 'none'", async () => {
    const translate = vi.fn();
    await translateOnArrival(MESSAGE_ID, { provider: "none", translate });
    expect(translate).not.toHaveBeenCalled();
  });

  it("translates exactly once, with the id it was given, for a real provider", async () => {
    const translate = vi.fn().mockResolvedValue({ ok: true });
    await translateOnArrival(MESSAGE_ID, { provider: "OpenAI", translate });
    expect(translate).toHaveBeenCalledTimes(1);
    expect(translate).toHaveBeenCalledWith(MESSAGE_ID);
  });

  it("resolves without throwing when the provider fails", async () => {
    const translate = vi.fn().mockRejectedValue(new Error("provider down"));
    await expect(translateOnArrival(MESSAGE_ID, { provider: "openai", translate })).resolves.toBeUndefined();
  });
});

describe("the arrival wiring in sync.ts", () => {
  it("fires translateOnArrival inside the inbound branch only", () => {
    const source = readFileSync("src/lib/email/sync.ts", "utf8");
    const call = source.indexOf("void translateOnArrival(messageDbId);");
    const inbound = source.indexOf(`if (input.direction === "inbound")`);
    const elseBranch = source.indexOf("} else {", inbound);
    expect(call).toBeGreaterThan(inbound);
    expect(call).toBeLessThan(elseBranch);
  });
});
