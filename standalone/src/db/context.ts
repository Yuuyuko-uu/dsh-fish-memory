import type { DatabaseSync } from 'node:sqlite';
import { ActorSchema, EvidenceSchema, MemorySchema, type Memory } from '../domain/memory.ts';
import {
  branchKey, messageKey, type ValidationContext, type MessageSnapshot,
} from '../contracts/validation.ts';
import type { MessageRef } from '../domain/common.ts';
import { hashJson } from '../contracts/canonical.ts';
import { readJson } from './objects.ts';
import { requireState } from '../runtime/errors.ts';

export const storedId = (kind: string, parts: string[]): string => `${kind}-${hashJson(parts).slice(0, 48)}`;
export function conversationId(companion: string, external: string): string { return storedId('conversation', [companion, external]); }
export function currentMemory(db: DatabaseSync, companion: string, id: string): Memory | null {
  const row = db.prepare(`SELECT m.*,r.content_object_id FROM memory_records m JOIN memory_revisions r
    ON r.companion_id=m.companion_id AND r.memory_id=m.id AND r.version=m.version WHERE m.companion_id=? AND m.id=?`).get(companion, id);
  if (!row) return null;
  const memory = MemorySchema.parse(readJson(db, companion, row.content_object_id as string));
  requireState(memory.id === row.id && memory.companion_id === companion && memory.version === row.version
    && memory.suppression_generation === row.suppression_generation && memory.content_status === row.content_status
    && memory.publication_status === row.publication_status && memory.kind === row.kind,
    'DATABASE_CORRUPT', 'Memory snapshot and current projection disagree');
  return memory;
}
export function messageVersionId(db: DatabaseSync, companion: string, ref: MessageRef): string {
  const row = db.prepare(`SELECT v.id FROM turn_versions v JOIN messages m ON m.id=v.message_id JOIN turns t ON t.id=m.turn_id
    JOIN conversations c ON c.id=t.conversation_id JOIN branch_messages b ON b.message_id=m.id AND b.turn_version_id=v.id
    WHERE c.companion_id=? AND c.external_id=? AND b.branch_id=? AND COALESCE(t.external_id,t.id)=? AND t.sequence=?
      AND COALESCE(m.external_id,m.id)=? AND v.revision=? AND b.active=1`).get(companion, ref.conversation_id, ref.branch_id,
        ref.turn_id, ref.sequence, ref.message_id, ref.revision);
  requireState(row, 'STALE_INPUT', 'Referenced message version is not active');
  return row.id as string;
}
export function loadContext(db: DatabaseSync, companion: string, capabilities: ValidationContext['capabilities']): ValidationContext {
  const owner = db.prepare('SELECT timezone FROM companions WHERE id=?').get(companion);
  requireState(owner, 'DATABASE_CORRUPT', 'Companion is missing');
  const actors = new Map(db.prepare('SELECT * FROM actors WHERE companion_id=?').all(companion).map(row => {
    const actor = ActorSchema.parse(row); return [actor.id, actor] as const;
  }));
  const conversations = new Set(db.prepare('SELECT external_id FROM conversations WHERE companion_id=?').all(companion).map(row => row.external_id as string));
  const branches = new Map<string, {conversation_id: string; branch_id: string; chain_revision: number; turns: Map<number,string>}>();
  for (const row of db.prepare('SELECT b.*,c.external_id FROM branches b JOIN conversations c ON c.id=b.conversation_id WHERE b.companion_id=?').all(companion)) {
    branches.set(branchKey(row.external_id as string, row.id as string), {conversation_id: row.external_id as string,
      branch_id: row.id as string, chain_revision: Number(row.chain_revision), turns: new Map()});
  }
  const messages = new Map<string, MessageSnapshot>();
  for (const row of db.prepare(`SELECT b.branch_id,c.external_id AS conversation_external,t.sequence,COALESCE(t.external_id,t.id) AS turn_external,
      COALESCE(m.external_id,m.id) AS message_external,m.role,m.actor_id,v.revision,v.content_object_id,v.captured_at
    FROM branch_messages b JOIN messages m ON m.id=b.message_id JOIN turn_versions v ON v.id=b.turn_version_id
    JOIN turns t ON t.id=m.turn_id JOIN conversations c ON c.id=t.conversation_id WHERE b.companion_id=? AND b.active=1`).all(companion)) {
    const payload = readJson(db, companion, row.content_object_id as string) as {text?: unknown};
    requireState(typeof payload.text === 'string', 'DATABASE_CORRUPT', 'Message payload is missing visible text');
    const ref: MessageRef = {conversation_id: row.conversation_external as string, branch_id: row.branch_id as string,
      turn_id: row.turn_external as string, sequence: Number(row.sequence), message_id: row.message_external as string, revision: Number(row.revision)};
    const snapshot: MessageSnapshot = {ref, companion_id: companion, actor_id: row.actor_id as string,
      role: row.role as 'user' | 'assistant', text: payload.text, captured_at: row.captured_at as string, channel: 'visible', active: true};
    messages.set(messageKey(ref), snapshot);
    branches.get(branchKey(ref.conversation_id,ref.branch_id))?.turns.set(ref.sequence,ref.turn_id);
  }
  const memories = new Map<string, Memory>();
  for (const row of db.prepare('SELECT id FROM memory_records WHERE companion_id=?').all(companion)) {
    const memory = currentMemory(db, companion, row.id as string)!; memories.set(memory.id,memory);
  }
  const evidence = new Map(db.prepare('SELECT id,content_object_id FROM evidence_catalog WHERE companion_id=?').all(companion).map(row => {
    const item = EvidenceSchema.parse(readJson(db, companion, row.content_object_id as string));
    requireState(item.id === row.id && item.companion_id === companion, 'DATABASE_CORRUPT', 'Evidence identity mismatch');
    return [item.id,item] as const;
  }));
  // DSH import is phase 6. No imported body is silently treated as a user message.
  return {companion_id: companion, timezone: owner.timezone as string, actors, conversations, branches, messages,
    memories, evidence, sources: new Map(), capabilities};
}
