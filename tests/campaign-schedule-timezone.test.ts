import { describe, expect, it } from "vitest";
import { wallClockInZone, zonedWallClockToUtc } from "@/lib/dates/timezone";

/**
 * The founder enters a start time in Asia/Karachi; the app stores and compares one UTC instant. These
 * cases pin that conversion, including the two ways a wall-clock time can be impossible.
 */

const HOUR = 3_600_000;

describe("zonedWallClockToUtc", () => {
  it("reads a Karachi wall clock as UTC+5, the instant the founder meant", () => {
    const utc = zonedWallClockToUtc("2026-11-23T14:00", "Asia/Karachi");
    expect(utc.toISOString()).toBe("2026-11-23T09:00:00.000Z");
    expect(wallClockInZone(utc, "Asia/Karachi")).toBe("2026-11-23T14:00");
  });

  it("round-trips a range of Karachi times", () => {
    for (const wall of ["2026-01-01T00:00", "2026-06-15T23:59", "2026-11-22T19:00"]) {
      const utc = zonedWallClockToUtc(wall, "Asia/Karachi");
      expect(wallClockInZone(utc, "Asia/Karachi")).toBe(wall);
    }
  });

  it("honours a zone with daylight saving: New York in summer and winter differ by an hour", () => {
    const summer = zonedWallClockToUtc("2026-07-01T12:00", "America/New_York");
    const winter = zonedWallClockToUtc("2026-12-01T12:00", "America/New_York");
    expect(summer.toISOString()).toBe("2026-07-01T16:00:00.000Z"); // EDT, UTC-4
    expect(winter.toISOString()).toBe("2026-12-01T17:00:00.000Z"); // EST, UTC-5
    expect(winter.getTime() - summer.getTime()).not.toBe(0);
  });

  it("refuses a wall-clock time that daylight saving skips", () => {
    // 2026-03-08 02:30 does not exist in New York: the clock jumps 02:00 -> 03:00.
    expect(() => zonedWallClockToUtc("2026-03-08T02:30", "America/New_York")).toThrow();
  });

  it("refuses an impossible calendar date and a malformed string", () => {
    expect(() => zonedWallClockToUtc("2026-02-30T10:00", "Asia/Karachi")).toThrow();
    expect(() => zonedWallClockToUtc("not a time", "Asia/Karachi")).toThrow();
    expect(() => zonedWallClockToUtc("2026-11-23T14:00", "Nope/Zone")).toThrow();
  });

  it("carries seconds when given and defaults to zero", () => {
    expect(zonedWallClockToUtc("2026-11-23T14:00:30", "Asia/Karachi").toISOString()).toBe(
      "2026-11-23T09:00:30.000Z",
    );
    expect(zonedWallClockToUtc("2026-11-23T14:00", "Asia/Karachi").toISOString()).toBe(
      "2026-11-23T09:00:00.000Z",
    );
  });

  it("is a pure conversion: sixty minutes of wall clock is sixty minutes of real time", () => {
    const a = zonedWallClockToUtc("2026-11-23T09:00", "Asia/Karachi");
    const b = zonedWallClockToUtc("2026-11-23T10:00", "Asia/Karachi");
    expect(b.getTime() - a.getTime()).toBe(HOUR);
  });
});
