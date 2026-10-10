import { describe, expect, it } from 'vitest';
import {
  addDays,
  endOfLocalDay,
  formatDate,
  formatTime,
  isValidLocalDate,
  presetRange,
  rangeToTimestamps,
  startOfLocalDay,
  toLocalDate,
} from './time.js';
describe('the shop day, wherever the code runs', () => {
  /**
   * These are the cases that would have gone wrong on a web server. The
   * counter PC keeps Pakistan time, so nothing here changes for it; a server
   * in UTC would have dated an evening sale to the wrong day and shown the
   * owner different takings from the person at the till.
   */

  it('dates a sale by the shop day, not the server day', () => {
    // 9pm in Dina on 10 October is 16:00 UTC the same day.
    expect(toLocalDate('2026-10-10T16:00:00.000Z')).toBe('2026-10-10');
    // 2am in Dina on 11 October is 21:00 UTC on the 10th. The shop would call
    // that the 11th; a server reading UTC would say the 10th.
    expect(toLocalDate('2026-10-10T21:00:00.000Z')).toBe('2026-10-11');
  });

  it('puts a shop day boundary five hours before midnight UTC', () => {
    expect(startOfLocalDay('2026-10-10')).toBe('2026-10-09T19:00:00.000Z');
    expect(endOfLocalDay('2026-10-10')).toBe('2026-10-10T19:00:00.000Z');
  });

  it('covers exactly one day, with no gap and no overlap', () => {
    expect(endOfLocalDay('2026-10-10')).toBe(startOfLocalDay('2026-10-11'));
  });

  it('includes the last sale of the shop day and excludes the first of the next', () => {
    const { start, end } = rangeToTimestamps({ from: '2026-10-10', to: '2026-10-10' });
    const lastSale = '2026-10-10T18:59:59.999Z'; // 11:59:59 pm in Dina
    const firstTomorrow = '2026-10-10T19:00:00.000Z'; // midnight in Dina
    expect(lastSale >= start && lastSale < end).toBe(true);
    expect(firstTomorrow < end).toBe(false);
  });

  it('counts days across a month and a year end', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('starts this month on the first of the shop month', () => {
    expect(presetRange('thisMonth').from.endsWith('-01')).toBe(true);
  });

  it('shows a time as the shop saw it', () => {
    // 16:00 UTC is 9pm at the counter.
    expect(formatTime('2026-10-10T16:00:00.000Z')).toBe('09:00 pm');
    expect(formatDate('2026-10-10T21:00:00.000Z')).toBe('11 Oct 2026');
  });

  it('reads a bare date as a day rather than shifting it again', () => {
    expect(formatDate('2026-10-10')).toBe('10 Oct 2026');
  });

  it('accepts real dates and refuses impossible ones', () => {
    expect(isValidLocalDate('2026-10-10')).toBe(true);
    expect(isValidLocalDate('2028-02-29')).toBe(true);
    expect(isValidLocalDate('2026-02-30')).toBe(false);
    expect(isValidLocalDate('2026-13-01')).toBe(false);
    expect(isValidLocalDate('10-10-2026')).toBe(false);
  });
});
