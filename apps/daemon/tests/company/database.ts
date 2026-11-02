import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';

const require = createRequire(import.meta.url);

/** Prefer the production driver; native Windows can exercise the same SQL with Node 24 SQLite. */
export function companyTestDatabase(): Database.Database {
  try {
    const Constructor = require('better-sqlite3') as typeof Database;
    return new Constructor(':memory:');
  } catch (error) {
    if (process.platform !== 'win32' || !String(error).includes('bindings file')) throw error;
  }
  const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: new (filename: string) => {
    exec(sql: string): void;
    prepare(sql: string): unknown;
    close(): void;
  } };
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys=ON');
  return {
    exec: (sql: string) => sqlite.exec(sql),
    prepare: (sql: string) => sqlite.prepare(sql),
    close: () => sqlite.close(),
    transaction: (operation: () => unknown) => () => {
      sqlite.exec('SAVEPOINT company_test');
      try { const result = operation(); sqlite.exec('RELEASE company_test'); return result; }
      catch (error) { sqlite.exec('ROLLBACK TO company_test; RELEASE company_test'); throw error; }
    },
  } as unknown as Database.Database;
}
