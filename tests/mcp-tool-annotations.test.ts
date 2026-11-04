import { describe, expect, it } from "vitest";

import { TOOL_DEFINITIONS } from "@/lib/agent/service";

/**
 * The tool surface is a safety boundary, so it is asserted rather than described: every tool
 * must explain itself, the read-only ones must say so (clients gate consequential calls on
 * that hint), and nothing may appear that could send, delete, change settings or drive jobs.
 */

type Tool = (typeof TOOL_DEFINITIONS)[number] & { readOnly?: boolean };

const tools = TOOL_DEFINITIONS as readonly Tool[];
const byName = new Map<string, Tool>(tools.map((tool) => [String(tool.name), tool]));

/** The only tools allowed to write anything, and what each may write. */
const WRITE_TOOLS = [
  "record_search_query", // a ledger row
  "save_prospect", // a new prospect
  "save_draft", // a draft
  "suggest_reply", // a suggestion, never a send
  "suggest_follow_up", // a suggestion, never a send
];

describe("the MCP tool surface", () => {
  it("exposes the seventeen tools the plan lists", () => {
    expect(tools.length).toBe(17);
    expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
  });

  it("gives every tool a real description and an object schema", () => {
    for (const tool of tools) {
      expect(tool.description.length, `${tool.name} description`).toBeGreaterThan(20);
      expect(tool.inputSchema?.type, `${tool.name} schema`).toBe("object");
      expect(typeof tool.inputSchema, `${tool.name} inputSchema`).toBe("object");
    }
  });

  it("marks reading the shared skill as read-only", () => {
    // The regression this test exists for: the skill is the first thing every agent calls, and
    // it was reported as a write.
    expect(byName.get("get_instructions")?.readOnly).toBe(true);
  });

  it("marks every genuinely read-only tool as read-only", () => {
    const expectedReadOnly = [
      "get_instructions",
      "read_product_truth",
      "list_research_jobs",
      "get_research_job",
      "report_progress",
      "check_search_query",
      "search_prospects",
      "get_prospect",
      "check_duplicate",
      "list_conversations",
      "get_conversation",
      "get_conversation_context",
    ];
    for (const name of expectedReadOnly) {
      expect(byName.get(name)?.readOnly, name).toBe(true);
    }
  });

  it("allows exactly the five tools that may write", () => {
    const writable = tools.filter((tool) => !tool.readOnly).map((tool) => tool.name).sort();
    expect(writable).toEqual([...WRITE_TOOLS].sort());
  });

  it("has no tool that could send, delete, change settings or drive research jobs", () => {
    // AGENTS.md rule 5: agents research, propose and save drafts; the founder approves and sends.
    const forbidden = /send|delete|remove|drop|settings|config|revoke|permission|start_job|stop_job|cancel_job|run_job/;
    for (const tool of tools) {
      expect(forbidden.test(tool.name), `${tool.name} name`).toBe(false);
    }
  });
});