import { describe, expect, it } from "vitest";

import { FOLDERS, folderFor, foldersByGroup, folderDefinition } from "@/lib/services/folders";

const T1 = "2026-11-01T10:00:00.000Z";
const T2 = "2026-11-02T10:00:00.000Z";

describe("folder model", () => {
  it("lists the plan's eleven folders in rule order", () => {
    expect(FOLDERS.map((folder) => folder.label)).toEqual([
      "Opted out",
      "Failed",
      "Rejected",
      "Won",
      "Closed (lost)",
      "Meeting or proposal",
      "Needs reply",
      "To approve",
      "In conversation",
      "Waiting",
      "New leads",
    ]);
  });

  it("groups them as Active, Outcome and Problem", () => {
    const groups = foldersByGroup();
    expect(groups.map((entry) => entry.group)).toEqual(["Active", "Outcome", "Problem"]);
    expect(groups[0]!.folders.length).toBe(6);
    expect(groups[1]!.folders.length).toBe(4);
    expect(groups[2]!.folders.map((folder) => folder.key)).toEqual(["failed"]);
  });

  it("puts an unsubscribed or complaining provider in Opted out", () => {
    expect(folderFor({ status: "contacted", suppressionReason: "unsubscribe" })).toBe("opted_out");
    expect(folderFor({ status: "contacted", suppressionReason: "opt_out" })).toBe("opted_out");
    expect(folderFor({ status: "contacted", suppressionReason: "complaint" })).toBe("opted_out");
    expect(folderFor({ status: "contacted", suppressionReason: "manual" })).not.toBe("opted_out");
  });

  it("puts a bounced provider in Failed", () => {
    expect(folderFor({ status: "contacted", suppressionReason: "bounce" })).toBe("failed");
  });

  it("prefers the outcome over the stage", () => {
    // A won deal that was also unsubscribed stays in Opted out: rule order wins.
    expect(
      folderFor({ status: "won", suppressionReason: "unsubscribe", lastInboundAt: T2 }),
    ).toBe("opted_out");
    expect(folderFor({ status: "won" })).toBe("won");
    expect(folderFor({ status: "lost" })).toBe("closed_lost");
  });

  it("puts demo and proposal in Meeting or proposal", () => {
    expect(folderFor({ status: "demo" })).toBe("meeting");
    expect(folderFor({ status: "proposal" })).toBe("meeting");
  });

  it("puts a provider whose message is newest in Needs reply, even with a draft waiting", () => {
    expect(
      folderFor({
        status: "interested",
        lastInboundAt: T2,
        lastOutboundAt: T1,
        hasDraftWaiting: true,
      }),
    ).toBe("needs_reply");
  });

  it("puts a provider with a waiting draft in To approve when they have not replied since", () => {
    expect(
      folderFor({ status: "contacted", lastOutboundAt: T2, hasDraftWaiting: true }),
    ).toBe("to_approve");
  });

  it("puts an interested stage or an answered reply in In conversation", () => {
    expect(folderFor({ status: "interested" })).toBe("in_conversation");
    expect(
      folderFor({ status: "replied", hasReplied: true, lastInboundAt: T1, lastOutboundAt: T2 }),
    ).toBe("in_conversation");
  });

  it("puts a contacted provider with no reply and no draft in Waiting", () => {
    expect(folderFor({ status: "contacted", lastOutboundAt: T1 })).toBe("waiting");
  });

  it("falls back to New leads for a verified or new provider", () => {
    expect(folderFor({ status: "verified" })).toBe("new_leads");
    expect(folderFor({ status: "new" })).toBe("new_leads");
    expect(folderFor({ status: "draft_prepared" })).toBe("new_leads");
  });

  it("keeps archived providers out of every folder", () => {
    expect(folderFor({ status: "won", archivedAt: T1 })).toBe("archived");
    expect(folderFor({ status: "contacted", archivedAt: T1 })).toBe("archived");
  });

  it("resolves a folder definition by key", () => {
    expect(folderDefinition("to_approve").label).toBe("To approve");
    expect(folderDefinition("needs_reply").group).toBe("Active");
  });
});