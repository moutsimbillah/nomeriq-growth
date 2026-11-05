import { describe, it, expect } from 'vitest';
import {
  addedWindow,
  calendarDaysBetween,
  isValidTimezone,
  listTimezones,
  dayStart,
  calendarDay,
} from '@/lib/dates/timezone';

const iso = (value: Date) => value.toISOString();
const HOUR = 3_600_000;

describe('timezone calendar windows', () => {
  it('today in Karachi at 2026-11-05T19:00Z runs from that instant to 2026-11-06T19:00Z', () => {
    const now = new Date('2026-11-05T19:00:00Z');
    const { from, to } = addedWindow('today', now, undefined, undefined, 'Asia/Karachi')!;
    expect(iso(from)).toBe('2026-11-05T19:00:00.000Z');
    expect(iso(to)).toBe('2026-11-06T19:00:00.000Z');
    expect(iso(dayStart(calendarDay(now, 'Asia/Karachi'), 'Asia/Karachi'))).toBe(
      '2026-11-05T19:00:00.000Z',
    );
    expect(calendarDay(now, 'Asia/Karachi')).toEqual({ year: 2026, month: 11, day: 6 });
  });

  it('an instant 1ms before Karachi midnight belongs to the previous day', () => {
    const justBefore = new Date('2026-11-05T18:59:59.999Z');
    const { from, to } = addedWindow('today', justBefore, undefined, undefined, 'Asia/Karachi')!;
    expect(iso(from)).toBe('2026-11-04T19:00:00.000Z');
    expect(iso(to)).toBe('2026-11-05T19:00:00.000Z');
  });

  it('New York today on 2026-03-08T12:00Z spans 05Z to next 04Z (23h)', () => {
    const now = new Date('2026-03-08T12:00:00Z');
    const { from, to } = addedWindow('today', now, undefined, undefined, 'America/New_York')!;
    expect(iso(from)).toBe('2026-03-08T05:00:00.000Z');
    expect(iso(to)).toBe('2026-03-09T04:00:00.000Z');
    expect(to.getTime() - from.getTime()).toBe(23 * HOUR);
  });

  it('New York on 2026-11-01 spans 04Z to next 05Z (25h)', () => {
    const now = new Date('2026-11-01T12:00:00Z');
    const { from, to } = addedWindow('today', now, undefined, undefined, 'America/New_York')!;
    expect(iso(from)).toBe('2026-11-01T04:00:00.000Z');
    expect(iso(to)).toBe('2026-11-02T05:00:00.000Z');
    expect(to.getTime() - from.getTime()).toBe(25 * HOUR);
  });

  it('yesterday shares its end edge with today', () => {
    const now = new Date('2026-11-05T19:00:00Z');
    const today = addedWindow('today', now, undefined, undefined, 'Asia/Karachi')!;
    const yesterday = addedWindow('yesterday', now, undefined, undefined, 'Asia/Karachi')!;
    expect(iso(yesterday.from)).toBe('2026-11-04T19:00:00.000Z');
    expect(iso(yesterday.to)).toBe(iso(today.from));
  });

  it('this_month spans the whole Karachi month from 2026-10-31T19Z to 2026-11-30T19Z', () => {
    const now = new Date('2026-11-05T19:00:00Z');
    const { from, to } = addedWindow('this_month', now, undefined, undefined, 'Asia/Karachi')!;
    expect(iso(from)).toBe('2026-10-31T19:00:00.000Z');
    expect(iso(to)).toBe('2026-11-30T19:00:00.000Z');
  });

  it('this_month rolls into December from mid-December Karachi to 2026-12-31T19Z', () => {
    const now = new Date('2026-12-15T12:00:00Z');
    const { from, to } = addedWindow('this_month', now, undefined, undefined, 'Asia/Karachi')!;
    expect(iso(from)).toBe('2026-11-30T19:00:00.000Z');
    expect(iso(to)).toBe('2026-12-31T19:00:00.000Z');
  });

  it('custom 2026-11-04..05 includes both days', () => {
    const now = new Date('2026-11-05T19:00:00Z');
    const { from, to } = addedWindow('custom', now, '2026-11-04', '2026-11-05', 'Asia/Karachi')!;
    expect(iso(from)).toBe('2026-11-03T19:00:00.000Z');
    expect(iso(to)).toBe('2026-11-05T19:00:00.000Z');
    expect(to.getTime() - from.getTime()).toBe(48 * HOUR);
  });

  it('reversed custom range returns null', () => {
    const now = new Date('2026-11-05T19:00:00Z');
    expect(addedWindow('custom', now, '2026-11-05', '2026-11-04', 'Asia/Karachi')).toBeNull();
  });

  it('invalid February 30 custom range returns null', () => {
    const now = new Date('2026-11-05T19:00:00Z');
    expect(addedWindow('custom', now, '2026-02-30', '2026-03-02', 'Asia/Karachi')).toBeNull();
  });

  it('calendarDaysBetween across the 19Z Karachi transition is 1 for under 24h', () => {
    const from = new Date('2026-11-05T18:00:00Z');
    const to = new Date('2026-11-05T20:00:00Z');
    expect(to.getTime() - from.getTime()).toBeLessThan(24 * HOUR);
    expect(calendarDaysBetween(from, to, 'Asia/Karachi')).toBe(1);
  });

  it('accepts Asia/Karachi, America/New_York and UTC', () => {
    expect(isValidTimezone('Asia/Karachi')).toBe(true);
    expect(isValidTimezone('America/New_York')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('rejects Nope/Zone and +05:00', () => {
    expect(isValidTimezone('Nope/Zone')).toBe(false);
    expect(isValidTimezone('+05:00')).toBe(false);
  });

  it('listTimezones contains the default, UTC and New York, sorted', () => {
    const zones = listTimezones();
    expect(zones).toContain('Asia/Karachi');
    expect(zones).toContain('UTC');
    expect(zones).toContain('America/New_York');
    expect(zones).toEqual([...zones].sort());
  });
});
