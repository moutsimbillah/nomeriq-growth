import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { RULE_BASED_LABEL, RULE_BASED_TASKS } from "@/lib/ai/routing";

/**
 * Classification makes no AI call (replies are sorted by fixed rules), so Settings says so plainly
 * instead of showing a provider picker and a status that look like an active AI setting.
 */
const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");

describe("the Classification row", () => {
  it("is marked rule-based with the founder's wording", () => {
    expect(RULE_BASED_TASKS.has("classification")).toBe(true);
    expect(RULE_BASED_LABEL).toBe("Rule-based — no AI used yet");
  });

  it("only rule-based actions that truly make no AI call are marked", () => {
    // Every other action has a real AI call site.
    const callers = ["src/lib/ai/reply.ts", "src/lib/ai/simulate.ts", "src/lib/ai/writer.ts", "src/lib/ai/translation.ts"]
      .map(read).join("\n");
    for (const task of ["suggest_reply", "simulate_reply", "first_email", "follow_up"]) {
      expect(RULE_BASED_TASKS.has(task)).toBe(false);
      expect(callers, task).toContain(`"${task}"`);
    }
    expect(callers).not.toContain('"classification"');
    expect(read("src/lib/email/classify.ts")).not.toMatch(/runChatTask|fetch\(/);
  });

  it("renders a plain statement with no provider picker, and is not counted as an AI action", () => {
    const row = read("src/components/settings/ai-tasks.tsx");
    const branch = row.slice(row.indexOf("if (RULE_BASED_TASKS.has(task.task))"), row.indexOf("const expanded = open === task.task;"));
    expect(branch).toContain("{RULE_BASED_LABEL}");
    expect(branch).toContain('data-status="rule_based"');
    expect(branch).not.toMatch(/<select|Switch to/);
    const page = read("src/app/(app)/settings/page.tsx");
    expect(page).toContain("!RULE_BASED_TASKS.has(task.task)");
  });
});
