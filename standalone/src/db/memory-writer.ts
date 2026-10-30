import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CandidatePatch, Evidence, Memory } from '../domain/memory.ts';
import { hashJson, canonicalJson } from '../contracts/canonical.ts';
import { requireState } from '../runtime/errors.ts';
import { conversationId, currentMemory, messageVersionId, storedId } from './context.ts';
import { putJson, readJson } from './objects.ts';

export interface CommitResult {
  committed: true;
  changed: {memory_id: string; version: number; suppression_generation: number}[];
  created: {temporary_id: string; memory_id: string; version: 1}[];
}
function allEvidence(memory: Memory): string[] {
  const ids = [...memory.evidence_ids];
  if (memory.kind === 'episode') ids.push(...memory.occurred.evidence_ids,
    ...memory.interpretations.flatMap(item => [...item.evidence_ids, ...item.felt_time.evidence_ids, ...item.retrospective_evidence_ids]));
  if (memory.kind === 'communication_pattern') ids.push(...memory.counterexample_evidence_ids);
  return [...new Set(ids)];
}
function remap(memory: Memory, ids: Map<string,string>, now: string, created: boolean): Memory {
  const next = structuredClone(memory);
  next.id = ids.get(next.id) ?? next.id;
  if (created) next.created_at = now;
  next.updated_at = now;
  if (next.kind === 'episode') {
    for (const interpretation of next.interpretations) if (interpretation.scope.kind === 'episode') interpretation.scope.id = ids.get(interpretation.scope.id) ?? interpretation.scope.id;
  } else if (next.scope.kind === 'episode') next.scope.id = ids.get(next.scope.id) ?? next.scope.id;
  return next;
}

// Every row here is written inside the caller's guarded BEGIN IMMEDIATE transaction.
// The revision content object is authoritative; typed tables are rebuildable projections.
export function persistPatch(db: DatabaseSync, companion: string, patch: CandidatePatch, now: string, hook: (point: string) => void): CommitResult {
  requireState(db.isTransaction, 'TRANSACTION_REQUIRED', 'Patch commits require one transaction');
  const ids = new Map(patch.mutations.filter(item => item.operation === 'create').map(item => [item.temporary_id, `memory-${randomUUID()}`]));
  const records = patch.mutations.map(item => ({mutation: item, record: remap(item.record, ids, now, item.operation === 'create'), revision_id: `revision-${randomUUID()}`}));
  for (const item of records) {
    const memory = item.record;
    if(item.mutation.operation==='revise') {
      const previous=currentMemory(db,companion,memory.id)!;
      requireState(Date.parse(now)>=Date.parse(previous.updated_at),'CLOCK_SKEW','System clock predates the current memory revision');
    }
    if (item.mutation.operation === 'create') {
      db.prepare('INSERT INTO memory_records VALUES(?,?,?,?,?,?,?,?,?)').run(memory.id,companion,memory.kind,memory.version,
        memory.suppression_generation,memory.content_status,memory.publication_status,memory.created_at,memory.updated_at);
    } else {
      const target = patch.targets.find(target => target.memory_id === item.mutation.record.id)!;
      const updated = db.prepare(`UPDATE memory_records SET version=?,suppression_generation=?,content_status=?,publication_status=?,updated_at=?
        WHERE companion_id=? AND id=? AND version=? AND suppression_generation=?`).run(memory.version,memory.suppression_generation,
          memory.content_status,memory.publication_status,memory.updated_at,companion,memory.id,target.expected_version,target.suppression_generation);
      requireState(updated.changes === 1, 'VERSION_CONFLICT', 'A guarded memory changed before commit');
    }
    const object = putJson(db,companion,memory);
    db.prepare('INSERT INTO memory_revisions VALUES(?,?,?,?,?,?,?)').run(item.revision_id,companion,memory.id,memory.version,object,patch.reason,now);
    hook('afterRevision');
  }
  // Episodes precede locally scoped response needs, regardless of candidate ordering.
  for (const item of [...records].sort((a,b) => Number(b.record.kind === 'episode')-Number(a.record.kind === 'episode'))) {
    const memory = item.record;
    if (memory.kind === 'episode') {
      db.prepare(`INSERT INTO episodes VALUES(?,?,'episode',?,?,?,?,?) ON CONFLICT(memory_id) DO UPDATE SET
        summary=excluded.summary,occurred_json=excluded.occurred_json,topic_status=excluded.topic_status,
        storage_tier=excluded.storage_tier,last_effective_mention_at=excluded.last_effective_mention_at`)
        .run(companion,memory.id,memory.summary,canonicalJson(memory.occurred),memory.topic_status,memory.storage_tier,memory.last_effective_mention_at);
      db.prepare('DELETE FROM episode_participants WHERE companion_id=? AND memory_id=?').run(companion,memory.id);
      for (const actor of memory.participant_ids) db.prepare('INSERT INTO episode_participants VALUES(?,?,?)').run(companion,memory.id,actor);
      for (const interpretation of memory.interpretations) {
        const physicalId = storedId('interpretation',[memory.id,String(memory.version),interpretation.id]);
        const replacement = interpretation.superseded_by ? storedId('interpretation',[memory.id,String(memory.version),interpretation.superseded_by]) : null;
        db.prepare(`INSERT INTO interpretations(id,companion_id,memory_revision_id,actor_id,kind,label,basis_kind,status,felt_time_json,expressed_version_id,superseded_by,external_id)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(physicalId,companion,item.revision_id,interpretation.actor_id,interpretation.kind,
            interpretation.label,interpretation.basis_kind,interpretation.status,canonicalJson(interpretation.felt_time),
            interpretation.expressed_at ? messageVersionId(db,companion,interpretation.expressed_at) : null,replacement,interpretation.id);
      }
    } else if (memory.kind === 'communication_pattern') {
      db.prepare(`INSERT INTO communication_patterns VALUES(?,?,'communication_pattern',?,'companion',?,?) ON CONFLICT(memory_id)
        DO UPDATE SET pattern_kind=excluded.pattern_kind,content=excluded.content,conditions_json=excluded.conditions_json`)
        .run(companion,memory.id,memory.pattern_kind,memory.content,canonicalJson(memory.conditions));
    } else {
      db.prepare(`INSERT INTO response_needs VALUES(?,?,'response_need',?,?,?,?) ON CONFLICT(memory_id)
        DO UPDATE SET scope_kind=excluded.scope_kind,scope_episode_id=excluded.scope_episode_id,scope_conversation_id=excluded.scope_conversation_id,content=excluded.content`)
        .run(companion,memory.id,memory.scope.kind,memory.scope.kind==='episode'?memory.scope.id:null,
          memory.scope.kind==='conversation'?conversationId(companion,memory.scope.id):null,memory.content);
    }
  }
  const firstRevision = records[0]!.revision_id;
  for (const evidence of patch.evidence) {
    const existing = db.prepare('SELECT content_object_id FROM evidence_catalog WHERE companion_id=? AND id=?').get(companion,evidence.id);
    if (existing) requireState(hashJson(readJson(db,companion,existing.content_object_id as string))===hashJson(evidence), 'VALIDATION_ERROR','Evidence identity cannot change');
    else {
      db.prepare('INSERT INTO evidence_catalog VALUES(?,?,?)').run(evidence.id,companion,putJson(db,companion,evidence));
      requireState(evidence.source.kind==='message','UNSUPPORTED_SOURCE','Legacy import is not implemented in phase 2');
      db.prepare('INSERT INTO evidence VALUES(?,?,?,?,?,?,?, ?,?)').run(evidence.id,companion,firstRevision,evidence.speaker_actor_id,
        messageVersionId(db,companion,evidence.source.ref),null,evidence.quote,evidence.start,evidence.end);
    }
  }
  for (const item of records) {
    const memory = item.record;
    for (const id of allEvidence(memory)) {
      db.prepare('INSERT INTO revision_evidence VALUES(?,?,?)').run(companion,item.revision_id,id);
      // Reused evidence is still a dependency even when the new job did not read that turn again.
      db.prepare(`INSERT OR IGNORE INTO revision_inputs SELECT ?,?,turn_version_id FROM evidence
        WHERE companion_id=? AND id=? AND turn_version_id IS NOT NULL`).run(companion,item.revision_id,companion,id);
    }
    for (const ref of patch.input_messages) db.prepare('INSERT OR IGNORE INTO revision_inputs VALUES(?,?,?)').run(companion,item.revision_id,messageVersionId(db,companion,ref));
    if(memory.kind==='episode') for(const interpretation of memory.interpretations) if(interpretation.expressed_at)
      db.prepare('INSERT OR IGNORE INTO revision_inputs VALUES(?,?,?)').run(companion,item.revision_id,messageVersionId(db,companion,interpretation.expressed_at));
    db.prepare(`INSERT INTO memory_validity VALUES(?,?,?,'valid',NULL) ON CONFLICT(companion_id,memory_id)
      DO UPDATE SET version=excluded.version,status='valid',reason=NULL`).run(companion,memory.id,memory.version);
    const document = storedId('document',[companion,memory.id]);
    db.prepare('DELETE FROM search_terms WHERE companion_id=? AND document_id=?').run(companion,document);
    db.prepare('DELETE FROM search_documents WHERE companion_id=? AND memory_id=?').run(companion,memory.id);
    if (memory.content_status==='active' && memory.publication_status==='published') {
      db.prepare('INSERT INTO search_documents VALUES(?,?,?,?,?,?,?,?)').run(document,companion,memory.id,memory.version,memory.suppression_generation,'structure-v1',1,
        memory.kind==='episode'?memory.summary:memory.content);
    }
  }
  for (const link of patch.links) db.prepare('INSERT OR IGNORE INTO memory_links VALUES(?,?,?,?)').run(companion,ids.get(link.from)??link.from,ids.get(link.to)??link.to,link.relation);
  hook('afterProjection');
  return {committed:true,
    changed:records.filter(item=>item.mutation.operation==='revise').map(({record})=>({memory_id:record.id,version:record.version,suppression_generation:record.suppression_generation})),
    created:[...ids].map(([temporary_id,memory_id])=>({temporary_id,memory_id,version:1})),
  };
}
