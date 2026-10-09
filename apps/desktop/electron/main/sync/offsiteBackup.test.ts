import { describe, expect, it } from 'vitest';
import { dateFromObjectName, expiredObjects, offsiteObjectName } from './offsiteBackup.js';

/**
 * The upload itself needs a network and a database; these are the parts worth
 * testing without either. `expiredObjects` decides what gets deleted, and a
 * mistake there destroys the only offsite copy the shop has.
 */

describe('offsiteObjectName', () => {
  it('names the copy after the shop day, in local time', () => {
    // Local, not UTC: the shop day the owner means is the one on their wall
    // calendar. A copy taken at 2am in Dina belongs to that date.
    const name = offsiteObjectName(new Date(2026, 9, 10, 2, 15));
    expect(name).toBe('pos-2026-10-10.db.gz');
  });

  it('pads single-digit months and days, so names sort by date', () => {
    expect(offsiteObjectName(new Date(2027, 0, 5, 12, 0))).toBe('pos-2027-01-05.db.gz');
  });

  it('gives the same name twice in a day, so the day has one copy', () => {
    const morning = offsiteObjectName(new Date(2026, 9, 10, 9, 0));
    const evening = offsiteObjectName(new Date(2026, 9, 10, 21, 30));
    expect(morning).toBe(evening);
  });
});

describe('dateFromObjectName', () => {
  it('reads the date back out', () => {
    expect(dateFromObjectName('pos-2026-10-10.db.gz')).toBe('2026-10-10');
  });

  it('refuses anything that is not one of ours', () => {
    // Anything else in the bucket was put there by a person, and is not this
    // code's business to delete.
    for (const name of [
      'pos.db',
      'notes.txt',
      'pos-2026-10-10.db',
      'pos-10-10-2026.db.gz',
      'photos/pos-2026-10-10.db.gz',
      '',
    ]) {
      expect(dateFromObjectName(name)).toBeNull();
    }
  });
});

describe('expiredObjects', () => {
  const today = new Date(2026, 9, 10);

  it('keeps everything inside the window', () => {
    const names = ['pos-2026-10-10.db.gz', 'pos-2026-09-20.db.gz', 'pos-2026-09-11.db.gz'];
    expect(expiredObjects(names, today, 30)).toEqual([]);
  });

  it('clears what has fallen out of it', () => {
    // 10 September is the oldest date still inside a thirty-day window from
    // the 10th of October, so the 9th goes with the 1st of August.
    const names = [
      'pos-2026-08-01.db.gz',
      'pos-2026-09-09.db.gz',
      'pos-2026-09-10.db.gz',
      'pos-2026-10-10.db.gz',
    ];
    expect(expiredObjects(names, today, 30)).toEqual([
      'pos-2026-08-01.db.gz',
      'pos-2026-09-09.db.gz',
    ]);
  });

  it('keeps the copy sitting exactly on the boundary', () => {
    // Thirty days back from the 10th is 10 September. Off by one here would
    // quietly shorten the window every time it ran.
    expect(expiredObjects(['pos-2026-09-10.db.gz'], today, 30)).toEqual([]);
    expect(expiredObjects(['pos-2026-09-09.db.gz'], today, 30)).toEqual([
      'pos-2026-09-09.db.gz',
    ]);
  });

  it('leaves alone anything it does not recognise', () => {
    const names = ['readme.txt', 'pos-manual-copy.db.gz', 'pos-2020-01-01.db.gz'];
    expect(expiredObjects(names, today, 30)).toEqual(['pos-2020-01-01.db.gz']);
  });

  it('handles a window that crosses a year boundary', () => {
    const january = new Date(2027, 0, 5);
    const names = ['pos-2026-12-20.db.gz', 'pos-2026-11-30.db.gz'];
    expect(expiredObjects(names, january, 30)).toEqual(['pos-2026-11-30.db.gz']);
  });
});
