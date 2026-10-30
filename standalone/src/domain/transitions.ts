// Pure contract predicates only. No storage, timers, files or model calls.
export const jobTransitions = {
  queued: ['running', 'cancelled', 'stale'],
  running: ['retry_wait', 'completed', 'failed', 'stale', 'cancelled'],
  retry_wait: ['queued', 'failed', 'stale', 'cancelled'],
  completed: [], stale: [], failed: [], cancelled: [],
} as const;
export type JobStatus = keyof typeof jobTransitions;
export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return (jobTransitions[from] as readonly string[]).includes(to);
}

export type ContentStatus = 'active' | 'disputed' | 'retracted';
export function canTransitionContent(from: ContentStatus, to: ContentStatus): boolean {
  return from !== 'retracted' || to === 'retracted';
}

export type UnderstandingStatus = 'tentative' | 'supported' | 'user_confirmed' | 'corrected';
export function canTransitionUnderstanding(from: UnderstandingStatus, to: UnderstandingStatus,
  guard: { direct_user_evidence: boolean; replacement_present: boolean }): boolean {
  if (from === to) return true;
  if (from === 'corrected') return false;
  if (to === 'user_confirmed' && !guard.direct_user_evidence) return false;
  if (to === 'corrected' && !guard.replacement_present) return false;
  if (from === 'user_confirmed' && to === 'corrected' && !guard.direct_user_evidence) return false;
  if (from === 'user_confirmed' && to !== 'corrected') return false;
  return true;
}

export interface ArchivePromotionGuard {
  source_versions_current: boolean;
  no_pending_revisions: boolean;
  verified: boolean;
  object_published: boolean;
  catalog_committed: boolean;
  recoverable_copy_available: boolean;
  retracted: boolean;
}
export function canMarkCold(guard: ArchivePromotionGuard): boolean {
  return guard.source_versions_current && guard.no_pending_revisions && guard.verified
    && guard.object_published && guard.catalog_committed && guard.recoverable_copy_available
    && !guard.retracted;
}

export type StorageTier = 'hot' | 'warm' | 'cold';
export function canTransitionStorage(from: StorageTier, to: StorageTier, guard: ArchivePromotionGuard & {
  idle: boolean; event_closed: boolean; effective_user_mention: boolean;
}): boolean {
  if (from === to) return true;
  if (guard.retracted) return false;
  if (to === 'hot') return guard.effective_user_mention;
  if (from === 'hot' && to === 'warm') return guard.idle && guard.no_pending_revisions;
  return from === 'warm' && to === 'cold' && guard.event_closed && canMarkCold(guard);
}

export interface SequencedStatus { sequence: number; received: boolean; status: JobStatus | 'no_change'; }
export function contiguousWatermark(rows: readonly SequencedStatus[], kind: 'accepted' | 'processed'): number {
  const bySequence = new Map<number, SequencedStatus>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.sequence) || row.sequence < 1 || bySequence.has(row.sequence)) {
      throw new Error('Sequences must be unique positive safe integers');
    }
    bySequence.set(row.sequence, row);
  }
  let through = 0;
  while (true) {
    const next = bySequence.get(through + 1);
    if (!next?.received) return through;
    if (kind === 'processed' && next.status !== 'completed' && next.status !== 'no_change') return through;
    through++;
  }
}
