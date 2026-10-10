/**
 * Time helpers.
 *
 * Timestamps are stored as ISO-8601 UTC strings so they sort lexicographically
 * in SQLite and survive sync without timezone guesswork. Anything a human reads
 * — a report date, "today's sales" — is computed in the shop's own day, because
 * a shop day is a local day.
 *
 * "The shop's own day" is stated explicitly rather than taken from whatever
 * machine the code happens to be running on. On the counter PC those are the
 * same thing. On a web server they are not: a server in UTC would put a sale
 * rung at 2am in Dina on the previous day, and the owner looking at their phone
 * would see different takings from the person standing at the till. The whole
 * point of sharing this file between the two is that the numbers agree.
 *
 * Pakistan keeps a fixed UTC+5 and has no daylight saving, so the arithmetic is
 * a plain offset rather than a timezone database lookup. If that ever changes,
 * this is the one place that needs to know.
 */

import type { LocalDate, Timestamp } from './types/index.js';

/** Dina, Punjab. Pakistan Standard Time. */
export const SHOP_TIME_ZONE = 'Asia/Karachi';

const SHOP_OFFSET_MINUTES = 5 * 60;
const SHOP_OFFSET_MS = SHOP_OFFSET_MINUTES * 60_000;

export function nowIso(): Timestamp {
  return new Date().toISOString();
}

function asDate(value: Date | Timestamp): Date {
  return typeof value === 'string' ? new Date(value) : value;
}

/** `YYYY-MM-DD` for the given moment, as the shop would date it. */
export function toLocalDate(value: Date | Timestamp = new Date()): LocalDate {
  // Shift the instant into shop time, then read it as though it were UTC.
  const shifted = new Date(asDate(value).getTime() + SHOP_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function today(): LocalDate {
  return toLocalDate(new Date());
}

function parts(date: LocalDate): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-').map(Number);
  return { year: year ?? 1970, month: month ?? 1, day: day ?? 1 };
}

/** First instant of a shop day, as a UTC timestamp. */
export function startOfLocalDay(date: LocalDate): Timestamp {
  const { year, month, day } = parts(date);
  return new Date(Date.UTC(year, month - 1, day) - SHOP_OFFSET_MS).toISOString();
}

/** First instant of the *next* shop day — the exclusive end of a range. */
export function endOfLocalDay(date: LocalDate): Timestamp {
  const { year, month, day } = parts(date);
  return new Date(Date.UTC(year, month - 1, day + 1) - SHOP_OFFSET_MS).toISOString();
}

export interface DateRange {
  from: LocalDate;
  to: LocalDate;
}

/** Convert an inclusive shop-day range into a half-open UTC timestamp range. */
export function rangeToTimestamps(range: DateRange): { start: Timestamp; end: Timestamp } {
  return { start: startOfLocalDay(range.from), end: endOfLocalDay(range.to) };
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const { year, month, day } = parts(date);
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  const movedYear = moved.getUTCFullYear();
  const movedMonth = String(moved.getUTCMonth() + 1).padStart(2, '0');
  const movedDay = String(moved.getUTCDate()).padStart(2, '0');
  return `${movedYear}-${movedMonth}-${movedDay}`;
}

/** Common ranges for the report screens. */
export function presetRange(preset: 'today' | 'yesterday' | 'last7' | 'last30' | 'thisMonth'): DateRange {
  const todayDate = today();
  switch (preset) {
    case 'today':
      return { from: todayDate, to: todayDate };
    case 'yesterday': {
      const y = addDays(todayDate, -1);
      return { from: y, to: y };
    }
    case 'last7':
      return { from: addDays(todayDate, -6), to: todayDate };
    case 'last30':
      return { from: addDays(todayDate, -29), to: todayDate };
    case 'thisMonth':
      return { from: `${todayDate.slice(0, 7)}-01`, to: todayDate };
  }
}

// Displayed in the shop's timezone for the same reason the arithmetic is: a
// bill rung at 9pm in Dina must not read as 4pm because the page was rendered
// on a server somewhere else.
const DATE_FMT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: SHOP_TIME_ZONE,
});

const TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
  timeZone: SHOP_TIME_ZONE,
});

/** `20 Sep 2026` */
export function formatDate(value: Timestamp | LocalDate | Date): string {
  // A bare `YYYY-MM-DD` is already a shop day, not an instant, so it is read
  // at midnight shop time rather than shifted again.
  const date =
    value instanceof Date
      ? value
      : value.length === 10
        ? new Date(startOfLocalDay(value))
        : new Date(value);
  return DATE_FMT.format(date);
}

/** `20 Sep 2026, 02:31 pm` */
export function formatDateTime(value: Timestamp | Date): string {
  const date = asDate(value);
  return `${DATE_FMT.format(date)}, ${TIME_FMT.format(date).toLowerCase()}`;
}

/** `02:31 pm` */
export function formatTime(value: Timestamp | Date): string {
  return TIME_FMT.format(asDate(value)).toLowerCase();
}

export function isValidLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const { year, month, day } = parts(value);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    !Number.isNaN(date.getTime()) &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
