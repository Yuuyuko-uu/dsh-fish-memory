import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './connection.ts';
import { canonicalJson } from '../contracts/canonical.ts';
import { requireState } from '../runtime/errors.ts';

export interface JobLease { job_id: string; token: string; generation: number; lease_until: string; input: unknown; }
export class JobQueue {
  readonly db: DatabaseSync;
  readonly companion: string;
  readonly clock: () => Date;
  readonly maxAttempts: number;
  readonly leaseMs: number;
  readonly writable: () => void;
  constructor(db: DatabaseSync, companion: string, clock: () => Date, maxAttempts: number, leaseMs: number, writable:()=>void) {
    this.db = db; this.companion = companion; this.clock = clock; this.maxAttempts = maxAttempts; this.leaseMs = leaseMs;
    this.writable=writable;
  }
  enqueueInTransaction(kind: 'extract' | 'reinterpret' | 'archive' | 'reindex' | 'import', key: string, input: unknown): string {
    requireState(this.db.isTransaction, 'TRANSACTION_REQUIRED', 'Enqueue must participate in the receipt transaction');
    const existing = this.db.prepare('SELECT id,input_json FROM jobs WHERE companion_id=? AND kind=? AND idempotency_key=?').get(this.companion, kind, key);
    const encoded = canonicalJson(input);
    if (existing) { requireState(existing.input_json === encoded, 'IDEMPOTENCY_CONFLICT', 'Job key was used for different input'); return existing.id as string; }
    const id = `job-${randomUUID()}`;
    this.db.prepare('INSERT INTO jobs(id,companion_id,kind,idempotency_key,input_json,status,available_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, this.companion, kind, key, encoded, 'queued', this.clock().toISOString());
    return id;
  }
  recoverInTransaction(): number {
    requireState(this.db.isTransaction, 'TRANSACTION_REQUIRED', 'Lease recovery requires a transaction');
    const now = this.clock().toISOString();
    this.db.prepare(`UPDATE job_candidates SET status='stale' WHERE companion_id=? AND status='staged' AND job_id IN
      (SELECT id FROM jobs WHERE companion_id=? AND status='running' AND lease_until<=?)`).run(this.companion, this.companion, now);
    const expired = this.db.prepare(`UPDATE jobs SET status=CASE WHEN attempts>=? THEN 'failed' ELSE 'retry_wait' END,
      lease_token=NULL,lease_until=NULL,lease_generation=lease_generation+1,error_code='LEASE_EXPIRED',available_at=?
      WHERE companion_id=? AND status='running' AND lease_until<=?`).run(this.maxAttempts, now, this.companion, now);
    this.db.prepare(`UPDATE jobs SET status='queued' WHERE companion_id=? AND status='retry_wait' AND available_at<=?`).run(this.companion, now);
    return Number(expired.changes);
  }
  recover(): number { this.writable(); return transaction(this.db, () => this.recoverInTransaction()); }
  claim(): JobLease | null {
    this.writable();
    return transaction(this.db, () => {
      this.recoverInTransaction();
      const now = this.clock().toISOString();
      const row = this.db.prepare(`SELECT id,lease_generation,input_json FROM jobs WHERE companion_id=? AND status='queued' AND attempts<? AND available_at<=? ORDER BY rowid LIMIT 1`)
        .get(this.companion, this.maxAttempts, now);
      if (!row) return null;
      const token = randomUUID(); const generation = Number(row.lease_generation) + 1;
      const until = new Date(this.clock().getTime() + this.leaseMs).toISOString();
      this.db.prepare(`UPDATE jobs SET status='running',lease_token=?,lease_generation=?,lease_until=?,attempts=attempts+1,error_code=NULL WHERE id=? AND status='queued'`)
        .run(token, generation, until, row.id as string);
      return {job_id: row.id as string, token, generation, lease_until: until, input: JSON.parse(row.input_json as string)};
    });
  }
  assertLease(lease: JobLease): void {
    const row = this.db.prepare('SELECT status,lease_token,lease_generation,lease_until,input_json FROM jobs WHERE companion_id=? AND id=?').get(this.companion, lease.job_id);
    requireState(row && row.status === 'running' && row.lease_token === lease.token && row.lease_generation === lease.generation
      && typeof row.lease_until === 'string' && row.lease_until > this.clock().toISOString(), 'STALE_LEASE', 'Worker lease has expired or changed');
    requireState(row.input_json===canonicalJson(lease.input),'STALE_LEASE','Lease input does not match the persisted job');
  }
  renew(lease: JobLease): JobLease {
    this.writable();
    return transaction(this.db, () => {
      this.assertLease(lease);
      const until = new Date(this.clock().getTime() + this.leaseMs).toISOString();
      this.db.prepare('UPDATE jobs SET lease_until=? WHERE companion_id=? AND id=?').run(until, this.companion, lease.job_id);
      return {...lease, lease_until: until};
    });
  }
  finishInTransaction(lease: JobLease, result: unknown): void {
    this.assertLease(lease);
    requireState(this.db.isTransaction, 'TRANSACTION_REQUIRED', 'Completion must participate in the output transaction');
    this.db.prepare(`UPDATE jobs SET status='completed',result_json=?,lease_token=NULL,lease_until=NULL WHERE companion_id=? AND id=?`)
      .run(canonicalJson(result), this.companion, lease.job_id);
  }
  fail(lease: JobLease, retryable: boolean, code: string): void {
    this.writable();
    transaction(this.db, () => {
      this.assertLease(lease);
      const row = this.db.prepare('SELECT attempts FROM jobs WHERE id=?').get(lease.job_id)!;
      const retry = retryable && Number(row.attempts) < this.maxAttempts;
      const available = new Date(this.clock().getTime() + Math.min(60000, 1000 * 2 ** Number(row.attempts))).toISOString();
      this.db.prepare('UPDATE jobs SET status=?,available_at=?,error_code=?,lease_token=NULL,lease_until=NULL WHERE companion_id=? AND id=?')
        .run(retry ? 'retry_wait' : 'failed', available, code.slice(0, 128), this.companion, lease.job_id);
    });
  }
}
