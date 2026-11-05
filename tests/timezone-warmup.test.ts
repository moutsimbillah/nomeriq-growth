import { describe, expect, it } from "vitest";

import { warmupDailyLimit, WARMUP_DAILY_STEP } from "@/lib/email/profiles";

/**
 * The warm-up ramp counts calendar days in the workspace's own timezone, not elapsed 24-hour blocks.
 *
 * These are pure cases: one mailbox, one limit, an explicit start and clock — no database, no clock
 * read inside. Karachi and New York disagree about which day the same instant falls on, which is the
 * whole point; the DST case is 23 hours of wall time that is still one calendar day.
 */

const LIMIT = 100;

describe("warm-up days are calendar days in the workspace timezone", () => {
  it("counts a calendar-day boundary in Karachi as a full day, and no boundary in New York as none", () => {
    const start = new Date("2026-11-05T18:59:00.000Z");
    const now = new Date("2026-11-05T19:00:00.000Z");

    // 18:59Z is 23:59 on 5 Nov in Karachi; 19:00Z is 00:00 on 6 Nov — one calendar day apart.
    expect(warmupDailyLimit(LIMIT, start, now, "Asia/Karachi")).toBe(2 * WARMUP_DAILY_STEP);
    // the same two instants are both 5 Nov in New York — no day has passed at all.
    expect(warmupDailyLimit(LIMIT, start, now, "America/New_York")).toBe(WARMUP_DAILY_STEP);
  });

  it("counts a 23-hour DST day in New York as one calendar day", () => {
    // 05:00Z on 8 Mar is midnight EST; 04:00Z on 9 Mar is midnight EDT — 23 hours, one day.
    const start = new Date("2026-03-08T05:00:00.000Z");
    const now = new Date("2026-03-09T04:00:00.000Z");

    expect(now.getTime() - start.getTime()).toBe(23 * 3_600_000);
    expect(warmupDailyLimit(LIMIT, start, now, "America/New_York")).toBe(2 * WARMUP_DAILY_STEP);
  });

  it("treats a start in the future as no elapsed days", () => {
    const now = new Date("2026-11-05T19:00:00.000Z");
    const start = new Date("2026-11-06T00:00:00.000Z");

    expect(warmupDailyLimit(LIMIT, start, now, "Asia/Karachi")).toBe(WARMUP_DAILY_STEP);
    expect(warmupDailyLimit(LIMIT, start, now, "America/New_York")).toBe(WARMUP_DAILY_STEP);
  });
});
