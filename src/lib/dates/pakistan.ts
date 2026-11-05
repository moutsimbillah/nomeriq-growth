/**
 * Added-filter vocabulary, named for the founder's Pakistan days.
 *
 * The calendar arithmetic itself lives in ./timezone, which owns the app timezone and is DST-safe.
 * Everything here is either a preset label/list or a thin Pakistan-defaulted wrapper, so this file
 * carries no timezone offset of its own.
 */

import { DEFAULT_TIMEZONE, calendarDay, dayStart } from "./timezone";

export { addedWindow } from "./timezone";

export type AddedRange =
  | "today"
  | "yesterday"
  | "last7"
  | "last30"
  | "this_month"
  | "last_month"
  | "custom";

export const ADDED_RANGES: AddedRange[] = [
  "today",
  "yesterday",
  "last7",
  "last30",
  "this_month",
  "last_month",
  "custom",
];

export const ADDED_LABELS: Record<AddedRange, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last7: "Last 7 days",
  last30: "Last 30 days",
  this_month: "This month",
  last_month: "Last month",
  custom: "Custom range",
};

export interface PktDay {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

/** The Pakistan calendar date an instant falls on. */
export function pktDayOf(instant: Date): PktDay {
  return calendarDay(instant, DEFAULT_TIMEZONE);
}

/** The UTC instant at which a given Pakistan day begins. */
export function pktDayStart(day: PktDay): Date {
  return dayStart(day, DEFAULT_TIMEZONE);
}

/** "2026-11-04" as read in Pakistan, or null if it is not a real date. */
export function parsePktDate(value: string | undefined | null): PktDay | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // reject a day that does not exist in that month (eg 2026-02-30)
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** `to` is inclusive, expressed as the start of the following Pakistan day. */
export interface AddedWindow {
  from: Date;
  to: Date;
}

/** The presets that can be offered with a count, ie everything except a custom range. */
export const COUNTED_ADDED_RANGES = ADDED_RANGES.filter((range) => range !== "custom");
