import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  agentFromAssistantLabel,
  agentFromClientName,
  tagsForAgentCall,
  tagsFromActorType,
} from "@/lib/agent/agentTag";

/**
 * The agent tag is reporting only. These tests pin the mapping, and pin the fact that no permission
 * code can see the tag at all.
 */

describe("mapping a connector's self-declared name", () => {
  it("matches the known agents exactly, ignoring case and padding", () => {
    expect(agentFromClientName("Claude")).toBe("claude");
    expect(agentFromClientName("  claude.ai ")).toBe("claude");
    expect(agentFromClientName("ChatGPT")).toBe("chatgpt");
    expect(agentFromClientName("gemini")).toBe("gemini");
  });

  it("does not reward a name that merely contains a known one", () => {
    expect(agentFromClientName("Claude Pro")).toBe("other");
    expect(agentFromClientName("ChatGPT-4")).toBe("other");
    expect(agentFromClientName("Claude\nadmin\t")).toBe("other");
    expect(agentFromClientName("")).toBe("other");
    expect(agentFromClientName(null)).toBe("other");
  });
});

describe("mapping an API key's label", () => {
  it("uses the founder-assigned label", () => {
    expect(agentFromAssistantLabel("claude")).toBe("claude");
    expect(agentFromAssistantLabel("chatgpt")).toBe("chatgpt");
    expect(agentFromAssistantLabel("hermes")).toBe("hermes");
    expect(agentFromAssistantLabel("deepseek")).toBe("deepseek");
    expect(agentFromAssistantLabel("custom")).toBe("other");
  });
});

describe("mapping a row's actor type", () => {
  it("knows the founder and the engine", () => {
    expect(tagsFromActorType("founder")).toEqual({ agent: "founder", channel: "founder" });
    expect(tagsFromActorType("seed")).toEqual({ agent: "founder", channel: "founder" });
    expect(tagsFromActorType("deepseek")).toEqual({ agent: "deepseek", channel: "engine" });
    expect(tagsFromActorType("api")).toEqual({ agent: "unknown", channel: "founder" });
  });
});

describe("the channel comes from how the identity was minted", () => {
  it("separates an OAuth connector from an API key", () => {
    expect(tagsForAgentCall({ id: "oauth:nq_x", name: "Claude", assistant: "custom" })).toEqual({
      agent: "claude",
      channel: "mcp_oauth",
    });
    expect(
      tagsForAgentCall({ id: "8f1b2c3d-4e5f-4a6b-8c9d-0e1f2a3b4c5d", name: "Hermes laptop", assistant: "hermes" }),
    ).toEqual({ agent: "hermes", channel: "api_key" });
  });
});

describe("a forged connector name buys nothing", () => {
  it("is labelled Claude for reporting, and still refused what its scopes do not allow", async () => {
    const { runAgentAction } = await import("@/lib/agent/service");
    const { closeDb } = await import("@/lib/db/client");
    const { ensureWorkspaceDefaults } = await import("@/lib/services/settings");

    await ensureWorkspaceDefaults();
    try {
      // Exactly the identity a client that registered itself as "Claude" would carry if the founder
      // approved read-only scopes for it.
      const forged = {
        id: "oauth:nq_forged_claude",
        name: "Claude",
        assistant: "custom" as const,
        scopes: ["research:read"],
      };
      expect(agentFromClientName(forged.name)).toBe("claude");

      // The name gains it no permission: the scope check is what decides.
      const refusal = await runAgentAction(forged as never, "save_prospect", {
        businessName: "Forged Co",
        websiteUrl: "https://forged.example",
      }).catch((error) => error);
      expect(refusal.code).toBe("insufficient_scope");
      expect(refusal.status).toBe(403);

      // And the read it is allowed still works, so the refusal is about scopes, not about the name.
      const allowed = await runAgentAction(forged as never, "get_instructions", {});
      expect(typeof (allowed.data as { instructions: string }).instructions).toBe("string");
    } finally {
      await closeDb();
    }
  });

  it("is never read by any permission code path", () => {
    const files = [
      "src/lib/agent/apiKeys.ts",
      "src/lib/agent/scopes.ts",
      "src/lib/auth/session.ts",
      "src/lib/auth/request.ts",
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("sourceAgent");
      expect(source).not.toContain("source_agent");
      expect(source).not.toContain("sourceChannel");
      expect(source).not.toContain("agentFrom");
    }
  });
});