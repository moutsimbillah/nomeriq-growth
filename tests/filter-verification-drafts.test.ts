import { afterAll, beforeAll, describe, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { cleanupFilterVerificationFixture, seedFilterVerificationFixture } from "./helpers/filter-verification-fixture";
import { draftVerificationTotals, verifyDraftFilterState } from "./helpers/verify-draft-filter-state";
import { AGENT_TAGS } from "@/lib/agent/agentTag";
import { ADDED_RANGES } from "@/lib/dates/pakistan";

/**
 * The whole Drafts filter matrix: every axis alone, then every distinct pair of axes together.
 * `status` is a service-only axis. The service reads whole SQL rows, not just the 120 that load.
 */
const BASE = {
  now: new Date("2026-11-05T20:00:00.000Z"),
  timezone: "Asia/Karachi",
  addedFrom: "2026-10-01",
  addedTo: "2026-11-05",
};
const STATUSES = ["draft", "approved", "sent", "discarded", "cancelled"];
const AXES = ["status", "agent", "sender", "added"] as const;
type Axis = (typeof AXES)[number];
const PAIRS: [Axis, Axis][] = AXES.flatMap((a, i) => AXES.slice(i + 1).map((b): [Axis, Axis] => [a, b]));
let senders: string[] = [];
let axes: Record<Axis, unknown[]>;

beforeAll(async () => {
  const seeded = await seedFilterVerificationFixture("drafts");
  senders = seeded.senders;
  axes = {
    status: STATUSES,
    agent: [...AGENT_TAGS],
    sender: ["default", ...senders],
    added: [...ADDED_RANGES],
  };
});

afterAll(async () => {
  const counts = { ...draftVerificationTotals, fixtureRows: 450, uiAxes: 3, serviceAxes: 4, pairs: 6 };
  await mkdir("scratch", { recursive: true });
  await writeFile("scratch/filter-verification-drafts.json", JSON.stringify(counts, null, 2));
  await cleanupFilterVerificationFixture();
});

describe("the Drafts filter matrix", () => {
  it("verifies the unfiltered baseline", async () => {
    await verifyDraftFilterState({ ...BASE }, senders);
  });

  for (const axis of AXES) {
    it(`verifies ${axis} alone across every value`, async () => {
      for (const value of axes[axis]) await verifyDraftFilterState({ ...BASE, [axis]: value }, senders);
    });
  }

  for (const [a, b] of PAIRS) {
    it(
      `verifies ${a} x ${b} across every pair of values`,
      async () => {
        for (const av of axes[a]) {
          for (const bv of axes[b]) {
            await verifyDraftFilterState({ ...BASE, [a]: av, [b]: bv }, senders);
          }
        }
      },
      120_000,
    );
  }
});
