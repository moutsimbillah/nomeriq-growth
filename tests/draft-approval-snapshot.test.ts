import { describe, expect, it } from "vitest";
import { matchesDraftApprovalSnapshot } from "@/lib/services/drafts";

describe("draft approval freshness snapshot", () => {
  const reviewed = {
    subject: "Founder-reviewed subject",
    body: "Founder-reviewed text",
    status: "draft",
    approvedAtExact: null,
    approvedByExact: null,
    updatedAtExact: "2026-11-25 00:40:00.123456+00",
  };

  it("matches an unchanged exact database snapshot", () => {
    expect(matchesDraftApprovalSnapshot({ ...reviewed }, reviewed)).toBe(true);
  });

  it("rejects a timestamp changed by one PostgreSQL microsecond", () => {
    expect(matchesDraftApprovalSnapshot(
      { ...reviewed, updatedAtExact: "2026-11-25 00:40:00.123457+00" },
      reviewed,
    )).toBe(false);
  });

  it("rejects changed body or status", () => {
    expect(matchesDraftApprovalSnapshot({ ...reviewed, body: "New unseen text" }, reviewed)).toBe(false);
    expect(matchesDraftApprovalSnapshot({ ...reviewed, status: "approved" }, reviewed)).toBe(false);
    expect(matchesDraftApprovalSnapshot(null, reviewed)).toBe(false);
  });

  it("rejects a subject change even when the timestamp is unchanged", () => {
    expect(matchesDraftApprovalSnapshot({ ...reviewed, subject: "Concurrent unseen subject" }, reviewed)).toBe(false);
  });

  it("rejects approval metadata appearing on a reviewed draft", () => {
    expect(matchesDraftApprovalSnapshot(
      { ...reviewed, approvedAtExact: "2026-11-25 00:41:00.000001+00", approvedByExact: "00000000-0000-4000-8000-000000000001" },
      reviewed,
    )).toBe(false);
  });
});
