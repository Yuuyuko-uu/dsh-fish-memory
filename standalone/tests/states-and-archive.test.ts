import test from 'node:test';
import assert from 'node:assert/strict';
import { validateArchiveManifest } from '../src/contracts/validation.ts';
import { ArchiveManifestSchema, ARCHIVE_LIMITS, type ArchiveManifest } from '../src/contracts/archive.ts';
import { canMarkCold, canTransitionJob, canTransitionContent, canTransitionUnderstanding, canTransitionStorage, contiguousWatermark, type ArchivePromotionGuard } from '../src/domain/transitions.ts';

const manifest: ArchiveManifest = {
  contract_version: '1.0.0', archive_format: 'fish-archive-v1', companion_id: 'companion-demo', archive_id: 'archive-demo',
  codec: 'zstd', created_at: '2026-10-30T10:00:00Z', payload_file: 'payload.zst', manifest_encoding: 'UTF-8',
  manifest_canonicalization: 'sorted-keys-json-v1', payload_sha256: 'a'.repeat(64), compressed_bytes: 12, uncompressed_bytes: 20,
  members: [{member_id: 'member-demo', kind: 'memory_revision', record_id: 'revision-demo', record_version: 1,
    memory_id: 'memory-demo', memory_version: 1, suppression_generation: 0,
    offset_bytes: 0, compressed_bytes: 12, uncompressed_bytes: 20, compressed_sha256: 'b'.repeat(64), content_sha256: 'c'.repeat(64)}],
};
test('archive draft fixes byte units, versions, frame order and hashes', () => {
  assert.equal(validateArchiveManifest(manifest).ok, true);
  for (const changed of [
    {...manifest, archive_format: 'future-v2'}, {...manifest, payload_file: '../elsewhere'},
    {...manifest, uncompressed_bytes: 21}, {...manifest, members: [{...manifest.members[0]!, offset_bytes: 1}]},
    {...manifest, members: [{...manifest.members[0]!, memory_id: null}]},
    {...manifest, members: [{...manifest.members[0]!, uncompressed_bytes: ARCHIVE_LIMITS.max_member_bytes + 1}]},
    {...manifest, members: [manifest.members[0], manifest.members[0]]},
  ]) assert.equal(validateArchiveManifest(changed).ok, false);
  assert.equal(ArchiveManifestSchema.safeParse({...manifest, hidden_path: 'secret'}).success, false);
  assert.equal(validateArchiveManifest({...manifest, created_at: '2026-10-30T10:00:00.' + '1'.repeat(1100000) + 'Z'}).ok, false);
});

test('each archive publication guard is necessary before marking cold', () => {
  const guard: ArchivePromotionGuard = {source_versions_current: true, no_pending_revisions: true, verified: true,
    object_published: true, catalog_committed: true, recoverable_copy_available: true, retracted: false};
  assert.equal(canMarkCold(guard), true);
  for (const key of Object.keys(guard) as (keyof ArchivePromotionGuard)[]) assert.equal(canMarkCold({...guard, [key]: !guard[key]}), false, key);
});

test('processed watermarks never jump missing, failed or stale turns', () => {
  const rows = [{sequence: 3, received: true, status: 'completed' as const}, {sequence: 1, received: true, status: 'completed' as const}];
  assert.equal(contiguousWatermark(rows, 'accepted'), 1);
  assert.equal(contiguousWatermark(rows, 'processed'), 1);
  for (const status of ['failed','stale','running','queued'] as const) {
    const complete = [...rows, {sequence: 2, received: true, status}];
    assert.equal(contiguousWatermark(complete, 'accepted'), 3);
    assert.equal(contiguousWatermark(complete, 'processed'), 1);
  }
  assert.equal(contiguousWatermark([...rows, {sequence: 2, received: true, status: 'no_change'}], 'processed'), 3);
  assert.throws(() => contiguousWatermark([...rows, rows[0]!], 'accepted'));
});

test('terminal jobs do not resume or silently overwrite newer work', () => {
  assert.equal(canTransitionJob('queued', 'running'), true);
  assert.equal(canTransitionJob('running', 'retry_wait'), true);
  for (const terminal of ['completed','failed','cancelled','stale'] as const) assert.equal(canTransitionJob(terminal, 'running'), false);
});

test('content, understanding and physical storage have independent transition guards', () => {
  assert.equal(canTransitionContent('active','disputed'), true);
  assert.equal(canTransitionContent('retracted','active'), false);
  assert.equal(canTransitionUnderstanding('tentative','user_confirmed',{direct_user_evidence:false,replacement_present:false}),false);
  assert.equal(canTransitionUnderstanding('user_confirmed','supported',{direct_user_evidence:true,replacement_present:true}),false);
  assert.equal(canTransitionUnderstanding('user_confirmed','corrected',{direct_user_evidence:false,replacement_present:true}),false);
  assert.equal(canTransitionUnderstanding('supported','corrected',{direct_user_evidence:true,replacement_present:false}),false);
  assert.equal(canTransitionUnderstanding('supported','corrected',{direct_user_evidence:true,replacement_present:true}),true);
  assert.equal(canTransitionUnderstanding('corrected','supported',{direct_user_evidence:true,replacement_present:true}),false);
  const guard = {source_versions_current:true,no_pending_revisions:true,verified:true,object_published:true,catalog_committed:true,
    recoverable_copy_available:true,retracted:false,idle:true,event_closed:true,effective_user_mention:false};
  assert.equal(canTransitionStorage('hot','warm',guard),true);
  assert.equal(canTransitionStorage('warm','cold',guard),true);
  assert.equal(canTransitionStorage('hot','cold',guard),false);
  assert.equal(canTransitionStorage('cold','hot',guard),false);
  assert.equal(canTransitionStorage('cold','hot',{...guard,effective_user_mention:true}),true);
});
