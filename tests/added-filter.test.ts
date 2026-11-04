import { describe, expect, it } from "vitest";

import {
  ADDED_RANGES,
  addedWindow,
  parsePktDate,
  pktDayOf,
  pktDayStart,
} from "@/lib/dates/pakistan";
import { leadFilterQuery, readLeadFilters } from "@/lib/leads/leadFilters";

/**
 * The Added filter is a Pakistan-day filter. The server runs in UTC, so every boundary here is the
 * interesting case: an entry saved at 23:59 Karachi is 18:59 UTC and belongs to that Karachi day, and
 * one saved at 00:01 Karachi is 19:01 UTC the previous day and belongs to the next one.
 */

const iso = (d: Date) => d.toISOString();

describe("the Karachi day an instant falls on", () => {
  it("treats 19:00 UTC as midnight in Pakistan", () => {
    expect(pktDayOf(new Date("2026-11-04T18:59:59.999Z"))).toEqual({ year: 2026, month: 11, day: 4 });
    expect(pktDayOf(new Date("2026-11-04T19:00:00.000Z"))).toEqual({ year: 2026, month: 11, day: 5 });
  });

  it("gives the instant a Karachi day begins at", () => {
    expect(iso(pktDayStart({ year: 2026, month: 11, day: 5 }))).toBe("2026-11-04T19:00:00.000Z");
  });

  it("puts a late-evening Karachi entry on the earlier day, not UTC's", () => {
    // 2026-11-04 23:30 Karachi == 18:30 UTC on the 4th
    const instant = new Date("2026-11-04T18:30:00Z");
    expect(pktDayOf(instant)).toEqual({ year: 2026, month: 11, day: 4 });
    const today = addedWindow("today", instant)!;
    expect(iso(today.from)).toBe("2026-11-03T19:00:00.000Z");
    expect(iso(today.to)).toBe("2026-11-04T19:00:00.000Z");
    expect(instant >= today.from && instant < today.to).toBe(true);
  });

  it("puts an after-midnight Karachi entry on the next day", () => {
    // 2026-11-05 00:30 Karachi == 19:30 UTC on the 4th
    const instant = new Date("2026-11-04T19:30:00Z");
    expect(pktDayOf(instant)).toEqual({ year: 2026, month: 11, day: 5 });
    const today = addedWindow("today", instant)!;
    expect(iso(today.from)).toBe("2026-11-04T19:00:00.000Z");
    expect(iso(today.to)).toBe("2026-11-05T19:00:00.000Z");
    expect(instant >= today.from && instant < today.to).toBe(true);
  });
});

describe("midnight in Pakistan", () => {
  const midnight = new Date("2026-11-04T19:00:00.000Z"); // 00:00 on the 5th in Karachi

  it("includes the entry saved at exactly midnight", () => {
    const today = addedWindow("today", midnight)!;
    expect(today.from.getTime()).toBe(midnight.getTime());
    expect(midnight >= today.from && midnight < today.to).toBe(true);
  });

  it("puts the entry one millisecond earlier on yesterday", () => {
    const before = new Date(midnight.getTime() - 1);
    const today = addedWindow("today", midnight)!;
    const yesterday = addedWindow("yesterday", midnight)!;
    expect(today.from.getTime() < 0 ? false : before >= today.from).toBe(false);
    expect(before >= yesterday.from && before < yesterday.to).toBe(true);
    expect(iso(yesterday.from)).toBe("2026-11-03T19:00:00.000Z");
    expect(iso(yesterday.to)).toBe("2026-11-04T19:00:00.000Z");
  });

  it("never leaves a gap or an overlap between today and yesterday", () => {
    const today = addedWindow("today", midnight)!;
    const yesterday = addedWindow("yesterday", midnight)!;
    expect(yesterday.to.getTime()).toBe(today.from.getTime());
  });
});

describe("the presets", () => {
  const now = new Date("2026-11-04T19:30:00Z"); // 2026-11-05 00:30 Karachi

  it("covers whole Karachi days", () => {
    expect(iso(addedWindow("last7", now)!.from)).toBe("2026-10-29T19:00:00.000Z");
    expect(iso(addedWindow("last7", now)!.to)).toBe("2026-11-05T19:00:00.000Z");
    expect(iso(addedWindow("last30", now)!.from)).toBe("2026-10-06T19:00:00.000Z");
  });

  it("uses Karachi months, not UTC ones", () => {
    // 00:30 Karachi on 5 Nov: this month started 00:00 on 1 Nov Karachi
    expect(iso(addedWindow("this_month", now)!.from)).toBe("2026-10-31T19:00:00.000Z");
    expect(iso(addedWindow("this_month", now)!.to)).toBe("2026-11-30T19:00:00.000Z");
    expect(iso(addedWindow("last_month", now)!.from)).toBe("2026-09-30T19:00:00.000Z");
    expect(iso(addedWindow("last_month", now)!.to)).toBe("2026-10-31T19:00:00.000Z");
  });

  it("handles the year boundary", () => {
    const newYear = new Date("2026-01-01T10:00:00Z");
    expect(iso(addedWindow("this_month", newYear)!.from)).toBe("2025-12-31T19:00:00.000Z");
    expect(iso(addedWindow("last_month", newYear)!.from)).toBe("2025-11-30T19:00:00.000Z");
    expect(iso(addedWindow("last_month", newYear)!.to)).toBe("2025-12-31T19:00:00.000Z");
  });

  it("covers every preset without leaving a hole", () => {
    for (const range of ADDED_RANGES.filter((r) => r !== "custom")) {
      const window = addedWindow(range, now);
      expect(window, range).not.toBeNull();
      expect(window!.to.getTime(), range).toBeGreaterThan(window!.from.getTime());
      expect(window!.from.getUTCMinutes(), range).toBe(0);
    }
  });
});

describe("a custom range", () => {
  const now = new Date("2026-11-04T19:30:00Z");

  it("is inclusive of both Karachi days", () => {
    const window = addedWindow("custom", now, "2026-11-01", "2026-11-03")!;
    expect(iso(window.from)).toBe("2026-10-31T19:00:00.000Z");
    // the 3rd ends when the 4th begins in Karachi
    expect(iso(window.to)).toBe("2026-11-03T19:00:00.000Z");
  });

  it("includes an entry from the last minute of the end day", () => {
    const window = addedWindow("custom", now, "2026-11-01", "2026-11-03")!;
    const lastMinute = new Date("2026-11-03T18:59:00Z"); // 23:59 Karachi on the 3rd
    expect(lastMinute >= window.from && lastMinute < window.to).toBe(true);
  });

  it("refuses a half-open or backwards range", () => {
    expect(addedWindow("custom", now, "2026-11-01", null)).toBeNull();
    expect(addedWindow("custom", now, null, "2026-11-03")).toBeNull();
    expect(addedWindow("custom", now, "2026-11-03", "2026-11-01")).toBeNull();
  });

  it("rejects a date that does not exist", () => {
    expect(parsePktDate("2026-02-30")).toBeNull();
    expect(parsePktDate("2026-13-01")).toBeNull();
    expect(parsePktDate("tomorrow")).toBeNull();
    expect(parsePktDate("2026-02-28")).toEqual({ year: 2026, month: 2, day: 28 });
  });
});

describe("the filter in the URL", () => {
  it("round-trips a preset", () => {
    const filters = { added: "last7" as const };
    expect(readLeadFilters(Object.fromEntries(new URLSearchParams(leadFilterQuery(filters).slice(1))))).toEqual(filters);
  });

  it("round-trips a custom range, keeping both ends", () => {
    const filters = { added: "custom" as const, addedFrom: "2026-11-01", addedTo: "2026-11-03" };
    const query = leadFilterQuery(filters);
    expect(query).toContain("added=custom");
    expect(query).toContain("from=2026-11-01");
    expect(query).toContain("to=2026-11-03");
    expect(readLeadFilters(Object.fromEntries(new URLSearchParams(query.slice(1))))).toEqual(filters);
  });

  it("drops a custom range that is missing an end, rather than half-applying it", () => {
    expect(readLeadFilters({ added: "custom", from: "2026-11-01" }).added).toBeUndefined();
    expect(readLeadFilters({ added: "custom", to: "2026-11-03" }).added).toBeUndefined();
    expect(readLeadFilters({ added: "custom", from: "nonsense", to: "2026-11-03" }).added).toBeUndefined();
  });

  it("drops an unknown range", () => {
    expect(readLeadFilters({ added: "since-the-dawn-of-time" }).added).toBeUndefined();
    expect(readLeadFilters({}).added).toBeUndefined();
  });
});