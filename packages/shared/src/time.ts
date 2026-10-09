/**
 * Time helpers.
 *
 * Timestamps are stored as ISO-8601 UTC strings so they sort lexicographically
 * in SQLite and survive sync without timezone guesswork. Anything a human reads
 * — a report date, "today's sales" — is computed in the shop's local timezone,
 * because a shop day is a local day.
 */

import type { LocalDate, Timestamp } from './types/index.js';

export function nowIso(): Timestamp {
  return new Date().toISOString();
}

/** `YYYY-MM-DD` for the given moment, in local time. */
export function toLocalDate(value: Date | Timestamp = new Date()): LocalDate {
  const date = typeof value === 'string' ? new Date(value) : value;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function today(): LocalDate {
  return toLocalDate(new Date());
}

/** First instant of a local calendar day, as a UTC timestamp. */
export function startOfLocalDay(date: LocalDate): Timestamp {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year!, (month ?? 1) - 1, day ?? 1, 0, 0, 0, 0).toISOString();
}

/** First instant of the *next* local day — the exclusive end of a range. */
export function endOfLocalDay(date: LocalDate): Timestamp {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year!, (month ?? 1) - 1, (day ?? 1) + 1, 0, 0, 0, 0).toISOString();
}

export interface DateRange {
  from: LocalDate;
  to: LocalDate;
}

/** Convert an inclusive local date range into a half-open UTC timestamp range. */
export function rangeToTimestamps(range: DateRange): { start: Timestamp; end: Timestamp } {
  return { start: startOfLocalDay(range.from), end: endOfLocalDay(range.to) };
}

export function addDays(date: LocalDate, days: number): LocalDate {
  const [year, month, day] = date.split('-').map(Number);
  return toLocalDate(new Date(year!, (month ?? 1) - 1, (day ?? 1) + days));
}

/** Common ranges for the report screens. */
export function presetRange(preset: 'today' | 'yesterday' | 'last7' | 'last30' | 'thisMonth'): DateRange {
  const now = new Date();
  const todayDate = toLocalDate(now);
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
      return { from: toLocalDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: todayDate };
  }
}

const DATE_FMT = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
});

const TIME_FMT = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});

/** `20 Sep 2026` */
export function formatDate(value: Timestamp | LocalDate | Date): string {
  const date = value instanceof Date ? value : new Date(value.length === 10 ? `${value}T00:00:00` : value);
  return DATE_FMT.format(date);
}

/** `20 Sep 2026, 02:31 pm` */
export function formatDateTime(value: Timestamp | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return `${DATE_FMT.format(date)}, ${TIME_FMT.format(date).toLowerCase()}`;
}

/** `02:31 pm` */
export function formatTime(value: Timestamp | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  return TIME_FMT.format(date).toLowerCase();
}

export function isValidLocalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00`);
  return !Number.isNaN(date.getTime()) && toLocalDate(date) === value;
}
