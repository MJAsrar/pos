import { sql as m001 } from './001_init.js';

export interface Migration {
  /** Matches the value written to `PRAGMA user_version` once applied. */
  version: number;
  name: string;
  sql: string;
}

/**
 * Forward-only migrations, applied in order.
 *
 * These are TypeScript modules rather than .sql files on purpose: a .sql file
 * has to be copied into the packaged app as an extra resource, and a missing
 * one fails at the worst possible moment — first launch on the shop PC. A
 * module is bundled and cannot go missing.
 *
 * Never edit a migration that has shipped. Add the next one instead.
 */
export const migrations: readonly Migration[] = [
  { version: 1, name: 'init', sql: m001 },
];

export const latestVersion = migrations.reduce((max, m) => Math.max(max, m.version), 0);
