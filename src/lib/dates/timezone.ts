export const DEFAULT_TIMEZONE = "Asia/Karachi";

export interface CalendarDay {
  year: number;
  month: number;
  day: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatterCache.set(zone, f);
  }
  return f;
}

export function isValidTimezone(value: string): boolean {
  if (typeof value !== "string" || value.length === 0) return false;
  if (/^[+-]\d{2}:?\d{2}$/.test(value)) return false;
  if (value !== "UTC" && !value.includes("/")) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function listTimezones(): string[] {
  let supported: string[] = [];
  const intl = Intl as typeof Intl & {
    supportedValuesOf?: (key: string) => string[];
  };
  if (typeof intl.supportedValuesOf === "function") {
    try {
      supported = intl.supportedValuesOf("timeZone");
    } catch {
      supported = [];
    }
  }
  const set = new Set<string>(supported);
  set.add("UTC");
  set.add(DEFAULT_TIMEZONE);
  return [...set].sort();
}

export function calendarDay(
  instant: Date,
  zone: string = DEFAULT_TIMEZONE,
): CalendarDay {
  const parts = formatterFor(zone).formatToParts(instant);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? "0");
  return { year: get("year"), month: get("month"), day: get("day") };
}

export function shiftDay(day: CalendarDay, n: number): CalendarDay {
  const base = Date.UTC(day.year, day.month - 1, day.day);
  const shifted = new Date(base + n * 86_400_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function utcOrdinal(day: CalendarDay): number {
  return Date.UTC(day.year, day.month - 1, day.day);
}

export function calendarDaysBetween(
  a: Date,
  b: Date,
  zone: string = DEFAULT_TIMEZONE,
): number {
  const ordA = utcOrdinal(calendarDay(a, zone));
  const ordB = utcOrdinal(calendarDay(b, zone));
  return (ordB - ordA) / 86_400_000;
}

function numericDay(day: CalendarDay): number {
  return day.year * 10_000 + day.month * 100 + day.day;
}

const DAY_MS = 86_400_000;
const DAY_SLACK_MS = 2 * DAY_MS;

export function dayStart(
  day: CalendarDay,
  zone: string = DEFAULT_TIMEZONE,
): Date {
  if (!isValidTimezone(zone)) {
    throw new Error(`Invalid timezone: ${zone}`);
  }
  const target = numericDay(day);
  const anchor = utcOrdinal(day);
  let low = anchor - DAY_SLACK_MS;
  let high = anchor + DAY_SLACK_MS;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (numericDay(calendarDay(new Date(mid), zone)) >= target) high = mid;
    else low = mid + 1;
  }
  return new Date(low);
}

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const wallClockFormatterCache = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(zone: string): Intl.DateTimeFormat {
  let f = wallClockFormatterCache.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    wallClockFormatterCache.set(zone, f);
  }
  return f;
}

const WALL_CLOCK_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/** The wall-clock time a zone shows for an instant, as `YYYY-MM-DDTHH:mm`. Deterministic, host-zone free. */
export function wallClockInZone(instant: Date, zone: string = DEFAULT_TIMEZONE): string {
  const parts = wallClockFormatter(zone).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}

/** The zone's offset from UTC at a given instant, in milliseconds (positive east of UTC). */
function zoneOffsetMs(instant: Date, zone: string): number {
  const parts = wallClockFormatter(zone).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    get("hour"),
    get("minute"),
    get("second"),
  );
  return asUtc - instant.getTime();
}

/**
 * The UTC instant a founder meant when they typed a wall-clock time in a named zone. This is what makes
 * a schedule honest: the founder enters "2026-11-23 14:00" and thinks in Asia/Karachi, and the value
 * stored and compared is the single UTC instant that Karachi wall clock denotes — never the browser's,
 * or the server's, own zone.
 *
 * It is computed from the zone's offset at the instant, refined once so a DST transition does not pick
 * the wrong offset, and it round-trips: the result must show back as exactly the entered wall clock, so
 * an impossible time (30 Feb, or a clock time a spring-forward skips) is refused rather than silently
 * shifted.
 */
export function zonedWallClockToUtc(
  wallClock: string,
  zone: string = DEFAULT_TIMEZONE,
): Date {
  const match = WALL_CLOCK_RE.exec(String(wallClock).trim());
  if (!match) throw new Error(`Invalid wall clock: ${wallClock}`);
  if (!isValidTimezone(zone)) throw new Error(`Invalid timezone: ${zone}`);
  const [, y, mo, d, h, mi, s] = match;
  const target = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? "0"));
  let utc = target - zoneOffsetMs(new Date(target), zone);
  utc = target - zoneOffsetMs(new Date(utc), zone);
  const result = new Date(utc);
  const rounded = `${y}-${mo}-${d}T${h}:${mi}`;
  if (wallClockInZone(result, zone) !== rounded) {
    throw new Error(`That date and time does not exist in ${zone}.`);
  }
  return result;
}

function parseCalendarDay(value: string): CalendarDay | null {
  if (!ISO_DAY_RE.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12 || day < 1) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function monthStart(day: CalendarDay): CalendarDay {
  return { year: day.year, month: day.month, day: 1 };
}

export function addedWindow(
  range: string,
  now: Date,
  customFrom?: string | null,
  customTo?: string | null,
  zone: string = DEFAULT_TIMEZONE,
): { from: Date; to: Date } | null {
  const today = calendarDay(now, zone);
  const startOf = (day: CalendarDay): Date => dayStart(day, zone);
  const endOf = (day: CalendarDay): Date => startOf(shiftDay(day, 1));

  switch (range) {
    case "today":
      return { from: startOf(today), to: endOf(today) };
    case "yesterday": {
      const yesterday = shiftDay(today, -1);
      return { from: startOf(yesterday), to: endOf(yesterday) };
    }
    case "last7":
      return { from: startOf(shiftDay(today, -6)), to: endOf(today) };
    case "last30":
      return { from: startOf(shiftDay(today, -29)), to: endOf(today) };
    case "this_month": {
      const firstOfThis = monthStart(today);
      const firstOfNext = monthStart(shiftDay(firstOfThis, 32));
      return { from: startOf(firstOfThis), to: startOf(firstOfNext) };
    }
    case "last_month": {
      const firstOfThis = monthStart(today);
      const lastOfPrev = shiftDay(firstOfThis, -1);
      return { from: startOf(monthStart(lastOfPrev)), to: startOf(firstOfThis) };
    }
    case "custom": {
      if (!customFrom || !customTo) return null;
      const from = parseCalendarDay(customFrom);
      const to = parseCalendarDay(customTo);
      if (!from || !to) return null;
      if (utcOrdinal(from) > utcOrdinal(to)) return null;
      return { from: startOf(from), to: startOf(shiftDay(to, 1)) };
    }
    default:
      return null;
  }
}
