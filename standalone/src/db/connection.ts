import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sha256Bytes } from '../contracts/canonical.ts';
import { RuntimeError, requireState } from '../runtime/errors.ts';

export interface Migration { version: number; name: string; sql: string; }
export function migrations(): Migration[] {
  return [
    {version: 1, name: 'initial-contract', sql: readFileSync(new URL('../../contracts/database/001-initial.sql', import.meta.url), 'utf8')},
    {version: 2, name: 'runtime-persistence', sql: readFileSync(new URL('./migrations/002-runtime.sql', import.meta.url), 'utf8')},
  ];
}
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  requireState(!db.isTransaction, 'TRANSACTION_NESTING', 'Nested transactions are not supported');
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = work();
    requireState(!(value && typeof value === 'object' && 'then' in value), 'ASYNC_TRANSACTION', 'Transaction callbacks must be synchronous');
    db.exec('COMMIT');
    return value;
  } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
}
export function migrate(db: DatabaseSync, planned: Migration[] = migrations()): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL
  ) STRICT`);
  transaction(db, () => {
    const applied = db.prepare('SELECT version,name,sha256 FROM schema_migrations ORDER BY version').all();
    requireState(planned.every((migration, index) => migration.version === index + 1), 'MIGRATION_ERROR', 'Migration versions must be contiguous');
    for (const row of applied) {
      const migration = planned.find(item => item.version === row.version);
      requireState(migration && migration.name === row.name && sha256Bytes(Buffer.from(migration.sql)) === row.sha256,
        'MIGRATION_MISMATCH', 'Database migration history does not match this program');
    }
    for (const migration of planned) {
      if (applied.some(row => row.version === migration.version)) continue;
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations VALUES(?,?,?,?)').run(migration.version, migration.name,
        sha256Bytes(Buffer.from(migration.sql)), new Date().toISOString());
    }
    requireState(db.prepare('PRAGMA foreign_key_check').all().length === 0, 'DATABASE_CORRUPT', 'Foreign key check failed after migration');
  });
}
export function openDatabase(path: string, busyTimeout = 5000): DatabaseSync {
  requireState(Number.isInteger(busyTimeout) && busyTimeout >= 0 && busyTimeout <= 10000, 'INVALID_CONFIG', 'Invalid database timeout');
  const db = new DatabaseSync(path, { timeout: busyTimeout });
  try {
    db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=${busyTimeout}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;`);
    migrate(db);
    return db;
  } catch (error) { db.close(); throw error; }
}
// A separate rollback-journal SQLite database holds an OS-managed exclusive lock.
// Process death releases it automatically; no PID guesses or stale-file deletion.
export function acquireOwner(home: string): () => void {
  const lock = new DatabaseSync(join(home, 'writer.lock.sqlite'), { timeout: 0 });
  try {
    lock.exec('PRAGMA journal_mode=DELETE; CREATE TABLE IF NOT EXISTS owner_lock(id INTEGER PRIMARY KEY); BEGIN EXCLUSIVE;');
  } catch(error) {
    lock.close();
    const sqliteCode=error && typeof error==='object' && 'errcode' in error ? error.errcode : undefined;
    if(typeof sqliteCode==='number' && [5,6].includes(sqliteCode & 255))
      throw new RuntimeError('ALREADY_RUNNING', 'Another service or offline command owns this data directory');
    throw new RuntimeError('LOCK_UNAVAILABLE', 'Cannot initialize the writer lock database; check its integrity and directory access');
  }
  let released = false;
  return () => { if (!released) { released = true; if (lock.isTransaction) lock.exec('ROLLBACK'); lock.close(); } };
}
