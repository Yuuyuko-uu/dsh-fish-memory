import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, sha256Bytes } from '../contracts/canonical.ts';
import { RuntimeError, requireState } from '../runtime/errors.ts';

// Call only inside the owning storage transaction. Original bytes stay immutable.
export function putBytes(db: DatabaseSync, companion: string, bytes: Uint8Array): string {
  requireState(db.isTransaction, 'TRANSACTION_REQUIRED', 'Content writes require a transaction');
  const id = `object-${randomUUID()}`;
  db.prepare('INSERT INTO content_objects VALUES(?,?,?,?)').run(id, companion, sha256Bytes(bytes), bytes.length);
  db.prepare('INSERT INTO object_locations VALUES(?,?,?,NULL,NULL)').run(companion, id, bytes);
  return id;
}
export function putJson(db: DatabaseSync, companion: string, value: unknown): string {
  return putBytes(db, companion, Buffer.from(canonicalJson(value), 'utf8'));
}
export function readBytes(db: DatabaseSync, companion: string, id: string): Buffer {
  const row = db.prepare(`SELECT c.sha256,c.byte_length,l.inline_bytes FROM content_objects c
    JOIN object_locations l ON l.companion_id=c.companion_id AND l.object_id=c.id WHERE c.companion_id=? AND c.id=?`).get(companion, id);
  requireState(row, 'DATABASE_CORRUPT', 'Referenced content is missing');
  if (!(row.inline_bytes instanceof Uint8Array)) throw new RuntimeError('ARCHIVE_UNAVAILABLE', 'Cold content reading will be available in the archive phase');
  const bytes = Buffer.from(row.inline_bytes);
  requireState(bytes.length === row.byte_length && sha256Bytes(bytes) === row.sha256, 'DATABASE_CORRUPT', 'Content integrity check failed');
  return bytes;
}
export function readJson(db: DatabaseSync, companion: string, id: string): unknown {
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readBytes(db, companion, id))); }
  catch (error) { if (error instanceof RuntimeError) throw error; throw new RuntimeError('DATABASE_CORRUPT', 'Stored content is not valid UTF-8 JSON'); }
}
