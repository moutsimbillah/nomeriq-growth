import { describe, expect, it } from "vitest";

import { FOLDERS, folderFor, folderDefinition } from "@/lib/services/folders";
import { PIPELINE, PIPELINE_LABELS } from "@/lib/types";

describe("Not contacted labels", () => {
  it("labels the new pipeline stage Not contacted", () => {
    expect(PIPELINE_LABELS.new).toBe("Not contacted");
  });

  it("keeps the stored pipeline enum value and key order unchanged", () => {
    expect(PIPELINE[0]).toBe("new");
    expect(PIPELINE).toContain("new");
  });

  it("labels the new_leads folder Not contacted", () => {
    expect(folderDefinition("new_leads").label).toBe("Not contacted");
  });

  it("keeps the new_leads folder key and routing unchanged", () => {
    expect(folderFor({ status: "new" })).toBe("new_leads");
    expect(folderFor({ status: "verified" })).toBe("new_leads");
  });

  it("carries no user-visible New lead label anywhere", () => {
    const visible = [...Object.values(PIPELINE_LABELS), ...FOLDERS.map((f) => f.label)];
    expect(visible).not.toContain("New lead");
    expect(visible).not.toContain("New leads");
  });
});
