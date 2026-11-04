/**
 * Asia/Karachi calendar boundaries.
 *
 * The server runs in UTC and the founder does not, so "today" has to mean *their* today. Pakistan has
 * observed no daylight saving since 2009, so Asia/Karachi is a fixed +05:00 — but the current calendar
 * date is still derived through Intl rather than by arithmetic, so a future change of offset cannot
 * silently shift the day the app considers today.
 */

export const PKT_OFFSET_MINUTES = 300;
const PKT_OFFSET_MS = PKT_OFFSET_MINUTES * 60 * 1000;

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

const PKT_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Karachi",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The Asia/Karachi calendar date an instant falls on. */
export function pktDayOf(instant: Date): PktDay {
  const [year, month, day] = PKT_DATE.format(instant).split("-").map(Number);
  return { year, month, day };
}

/** The UTC instant at which a given Asia/Karachi day begins. */
export function pktDayStart(day: PktDay): Date {
  return new Date(Date.UTC(day.year, day.month - 1, day.day) - PKT_OFFSET_MS);
}

/** "2026-11-04" as read in Asia/Karachi, or null if it is not a real date. */
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

/** `to` is inclusive, expressed as the start of the following Asia/Karachi day. */
export interface AddedWindow {
  from: Date;
  to: Date;
}

function addDays(day: PktDay, delta: number): PktDay {
  const shifted = new Date(Date.UTC(day.year, day.month - 1, day.day + delta));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/**
 * The half-open instant window for a preset — `from` inclusive, `to` exclusive — always as whole
 * Asia/Karachi days, so an entry saved at 23:59 in Karachi belongs to that day and not the next.
 */
export function addedWindow(
  range: AddedRange,
  now: Date,
  customFrom?: string | null,
  customTo?: string | null,
): AddedWindow | null {
  const today = pktDayOf(now);

  switch (range) {
    case "today":
      return { from: pktDayStart(today), to: pktDayStart(addDays(today, 1)) };
    case "yesterday":
      return { from: pktDayStart(addDays(today, -1)), to: pktDayStart(today) };
    case "last7":
      return { from: pktDayStart(addDays(today, -6)), to: pktDayStart(addDays(today, 1)) };
    case "last30":
      return { from: pktDayStart(addDays(today, -29)), to: pktDayStart(addDays(today, 1)) };
    case "this_month":
      return {
        from: pktDayStart({ ...today, day: 1 }),
        to: pktDayStart({ year: today.month === 12 ? today.year + 1 : today.year, month: today.month === 12 ? 1 : today.month + 1, day: 1 }),
      };
    case "last_month": {
      const prev = today.month === 1 ? { year: today.year - 1, month: 12, day: 1 } : { year: today.year, month: today.month - 1, day: 1 };
      return { from: pktDayStart(prev), to: pktDayStart({ ...today, day: 1 }) };
    }
    case "custom": {
      const from = parsePktDate(customFrom);
      const to = parsePktDate(customTo);
      if (!from || !to) return null;
      const start = pktDayStart(from);
      const end = pktDayStart(addDays(to, 1));
      if (end <= start) return null;
      return { from: start, to: end };
    }
    default:
      return null;
  }
}

/** The presets that can be offered with a count, ie everything except a custom range. */
export const COUNTED_ADDED_RANGES = ADDED_RANGES.filter((range) => range !== "custom");