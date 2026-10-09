import { describe, expect, it } from 'vitest';
import { nextBackupName } from './backupService.js';

/**
 * This exists because the name was once stamped only to the second. Two
 * backups taken in the same second wrote to the same file, and the second
 * silently destroyed the first — which cost a restore its source file.
 */
describe('nextBackupName', () => {
  const at = (iso: string) => new Date(iso);
  const none = () => false;

  it('includes milliseconds, so same-second backups differ', () => {
    const a = nextBackupName('manual', at('2026-10-09T20:08:44.120Z'), none);
    const b = nextBackupName('manual', at('2026-10-09T20:08:44.880Z'), none);
    expect(a).not.toBe(b);
  });

  it('never returns a name that is already on disk', () => {
    const existing = new Set(['pos-2026-10-09T20-08-44-123-manual.db']);
    const name = nextBackupName('manual', at('2026-10-09T20:08:44.123Z'), (n) => existing.has(n));
    expect(existing.has(name)).toBe(false);
    expect(name).toBe('pos-2026-10-09T20-08-44-123-manual-1.db');
  });

  it('keeps counting past a run of collisions', () => {
    const existing = new Set([
      'pos-2026-10-09T20-08-44-123-manual.db',
      'pos-2026-10-09T20-08-44-123-manual-1.db',
      'pos-2026-10-09T20-08-44-123-manual-2.db',
    ]);
    expect(nextBackupName('manual', at('2026-10-09T20:08:44.123Z'), (n) => existing.has(n))).toBe(
      'pos-2026-10-09T20-08-44-123-manual-3.db',
    );
  });

  it('keeps the reason in the name, so the folder is readable', () => {
    for (const reason of ['startup', 'shutdown', 'manual', 'replaced']) {
      expect(nextBackupName(reason, at('2026-10-09T20:08:44.123Z'), none)).toContain(`-${reason}.db`);
    }
  });

  it('sorts chronologically as plain text', () => {
    const names = [
      nextBackupName('startup', at('2026-10-09T20:08:44.123Z'), none),
      nextBackupName('manual', at('2026-10-09T20:08:44.900Z'), none),
      nextBackupName('manual', at('2026-10-10T06:01:02.000Z'), none),
    ];
    expect([...names].sort()).toEqual(names);
  });
});
