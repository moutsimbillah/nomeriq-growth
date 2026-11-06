import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { draftProvenance } from "@/lib/ai/provenance";
import { languageName } from "@/lib/email/translation-view";

/** Every draft says who wrote it, the same way wherever it is listed. */
describe("draft provenance", () => {
  it("names the provider by its Settings name and the model", () => {
    expect(draftProvenance({ aiGenerated: true, aiModel: "deepseek-flash", aiProvider: "Growth-Chat-Search" }))
      .toBe("Written by Growth-Chat-Search · deepseek-flash");
  });

  it("labels the standard template as the No-AI fallback, never as AI", () => {
    expect(draftProvenance({ aiGenerated: false, aiModel: null, aiProvider: null })).toBe("No-AI fallback — standard template");
  });

  it("names a connected assistant as the drafter", () => {
    expect(draftProvenance({ aiGenerated: true, aiModel: null, sourceAgent: "gemini", sourceClient: null }, (agent) => `Agent ${agent}`))
      .toBe("Drafted by Agent gemini");
  });

  it("is shown on the lead draft, the lead's follow-up list and the Email follow-ups tab", () => {
    const read = (file: string) => fs.readFileSync(path.join(process.cwd(), file), "utf8");
    expect(read("src/components/lead-actions.tsx")).toContain("draftProvenance(draft, agentPillLabel)");
    expect(read("src/app/(app)/leads/[id]/page.tsx")).toContain("draftProvenance(followUp)");
    expect(read("src/components/follow-up-bulk.tsx")).toContain("draftProvenance(draft)");
    expect(read("src/app/(app)/email/email-tools.tsx")).toContain("<FollowUpDraftList");
  });

  it("names the reply language in words for the founder", () => {
    expect(languageName("fr")).toBe("French");
    expect(languageName("es")).toBe("Spanish");
  });
});
