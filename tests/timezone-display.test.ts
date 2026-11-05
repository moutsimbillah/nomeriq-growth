import { describe, expect, it } from "vitest";

import { DEFAULT_TIMEZONE } from "@/lib/dates/timezone";
import { formatDate, formatDateTime } from "@/lib/utils";

/**
 * Display formatting must resolve the zone it is asked for, per call.
 * 01:00Z on 5 Nov 2026 is still 4 Nov in New York but already 5 Nov in Karachi,
 * so a helper that ignores its zone cannot pass both rows.
 */

const DAY_OPTIONS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
};

describe("formatDate timezone handling", () => {
  it("renders the New York calendar day, not the Karachi one", () => {
    expect(
      formatDate("2026-11-05T01:00Z", DAY_OPTIONS, "America/New_York"),
    ).toBe("04/11/2026");
  });

  it("renders the Karachi calendar day", () => {
    expect(formatDate("2026-11-05T01:00Z", DAY_OPTIONS, "Asia/Karachi")).toBe(
      "05/11/2026",
    );
  });

  it("defaults to the workspace default zone when no zone is given", () => {
    expect(formatDate("2026-11-05T01:00Z", DAY_OPTIONS)).toBe(
      formatDate("2026-11-05T01:00Z", DAY_OPTIONS, DEFAULT_TIMEZONE),
    );
  });

  it("respects an explicit options.timeZone over the zone argument", () => {
    expect(
      formatDate(
        "2026-11-05T01:00Z",
        { ...DAY_OPTIONS, timeZone: "America/New_York" },
        "Asia/Karachi",
      ),
    ).toBe("04/11/2026");
  });

  it("returns Unknown for an invalid timestamp", () => {
    expect(formatDate("not-a-date", DAY_OPTIONS, "America/New_York")).toBe(
      "Unknown",
    );
    expect(formatDate(null, DAY_OPTIONS, "Asia/Karachi")).toBe("Unknown");
  });
});

describe("formatDateTime timezone handling", () => {
  it("accepts a second zone and shows different dates for the same instant", () => {
    const newYork = formatDateTime("2026-11-05T01:00Z", "America/New_York");
    const karachi = formatDateTime("2026-11-05T01:00Z", "Asia/Karachi");

    // 01:00Z is 4 Nov (20:00) in New York and 5 Nov (06:00) in Karachi.
    expect(newYork).not.toBe(karachi);
    expect(newYork).toMatch(/^4 Nov 2026, \d{2}:\d{2}$/);
    expect(karachi).toMatch(/^5 Nov 2026, \d{2}:\d{2}$/);
  });

  it("forwards the zone with the medium/short style it promises", () => {
    const options: Intl.DateTimeFormatOptions = {
      dateStyle: "medium",
      timeStyle: "short",
    };
    const forwarded = formatDateTime("2026-11-05T01:00Z", "America/New_York");

    expect(forwarded).toBe(
      formatDate("2026-11-05T01:00Z", options, "America/New_York"),
    );
    expect(forwarded).not.toBe(
      formatDate("2026-11-05T01:00Z", options, "Asia/Karachi"),
    );
  });

  it("defaults to the workspace default zone when no zone is given", () => {
    expect(formatDateTime("2026-11-05T01:00Z")).toBe(
      formatDateTime("2026-11-05T01:00Z", DEFAULT_TIMEZONE),
    );
  });
});
