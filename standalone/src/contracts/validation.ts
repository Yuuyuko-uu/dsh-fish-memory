import * as z from 'zod';
import {
  codePointLength, sliceCodePoints, type MessageRef, type TimeRange,
} from '../domain/common.ts';
import {
  CandidatePatchSchema, MemorySchema, type Actor, type CandidatePatch,
  type Evidence, type Memory, type PreferenceValue, type ResponseNeedRecord,
} from '../domain/memory.ts';
import { ArchiveManifestSchema, type ArchiveManifest } from './archive.ts';
import { toolContracts, type ToolInput, type ToolName, type ToolOutput } from './tools.ts';
import { hashJson } from './canonical.ts';

export interface ContractIssue { code: string; path: string; message: string; }
export interface MessageSnapshot {
  ref: MessageRef; companion_id: string; actor_id: string;
  role: 'user' | 'assistant'; text: string; captured_at: string;
  channel: 'visible' | 'injected'; active: boolean;
}
export interface SourceSnapshot {
  source_id: string; external_id: string; content_hash: string;
  companion_id: string; actor_id: string; text: string;
  kind: 'legacy_summary' | 'dialogue'; suppressed: boolean; generation: number;
}
export interface BranchSnapshot {
  conversation_id: string; branch_id: string; chain_revision: number;
  turns: ReadonlyMap<number, string>;
}
export interface ValidationContext {
  companion_id: string;
  timezone: string;
  actors: ReadonlyMap<string, Actor>;
  messages: ReadonlyMap<string, MessageSnapshot>;
  sources: ReadonlyMap<string, SourceSnapshot>;
  memories: ReadonlyMap<string, Memory>;
  evidence: ReadonlyMap<string, Evidence>;
  branches: ReadonlyMap<string, BranchSnapshot>;
  conversations: ReadonlySet<string>;
  capabilities: ReadonlySet<'read' | 'observe' | 'user_edit' | 'candidate'>;
}
export type ContractResult<T> = { ok: true; value: T } | { ok: false; issues: ContractIssue[] };
const issue = (issues: ContractIssue[], code: string, path: string, message: string): void => {
  issues.push({ code, path, message });
};
export const messageKey = (ref: MessageRef): string =>
  [ref.conversation_id, ref.branch_id, ref.turn_id, ref.sequence, ref.message_id, ref.revision].join('/');
export const sourceKey = (source: { source_id: string; external_id: string; content_hash: string }): string =>
  [source.source_id, source.external_id, source.content_hash].join('/');
export const branchKey = (conversation: string, branch: string): string => `${conversation}/${branch}`;

function structural<T>(schema: z.ZodType<T>, value: unknown): ContractResult<T> {
  const parsed = schema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: parsed.error.issues.map(item => ({
    code: 'VALIDATION_ERROR', path: item.path.join('.'), message: item.message,
  })) };
}
function checkTime(time: TimeRange, path: string, issues: ContractIssue[]): void {
  if (time.precision === 'unknown') return;
  if (Number(time.start.slice(0, 4)) === 0) issue(issues, 'VALIDATION_ERROR', path, 'Year zero is outside contract v1');
  if (time.end !== null) {
    const backwards = time.precision === 'instant'
      ? Date.parse(time.end) < Date.parse(time.start) : time.end < time.start;
    if (backwards) issue(issues, 'VALIDATION_ERROR', path, 'Time range ends before it starts');
  }
}
function checkMessage(ref: MessageRef, context: ValidationContext, path: string, issues: ContractIssue[]): MessageSnapshot | undefined {
  const message = context.messages.get(messageKey(ref));
  const branch = context.branches.get(branchKey(ref.conversation_id, ref.branch_id));
  if (!message?.active || !branch || branch.turns.get(ref.sequence) !== ref.turn_id) {
    issue(issues, 'STALE_INPUT', path, 'Message version is not on the active branch');
    return;
  }
  if (message.companion_id !== context.companion_id || message.channel !== 'visible') {
    issue(issues, 'FORBIDDEN', path, 'Only visible messages of the bound companion are evidence');
    return;
  }
  return message;
}

function checkEvidence(evidence: Evidence, context: ValidationContext, path: string, issues: ContractIssue[]): void {
  if (evidence.companion_id !== context.companion_id) issue(issues, 'FORBIDDEN', path, 'Cross-companion evidence');
  let text: string | undefined;
  let actor: string | undefined;
  if (evidence.source.kind === 'message') {
    const snapshot = checkMessage(evidence.source.ref, context, `${path}.source`, issues);
    text = snapshot?.text; actor = snapshot?.actor_id;
  } else {
    const snapshot = context.sources.get(sourceKey(evidence.source));
    if (!snapshot || snapshot.suppressed) issue(issues, 'STALE_INPUT', path, 'Missing or suppressed source record');
    else if (snapshot.companion_id !== context.companion_id) issue(issues, 'FORBIDDEN', path, 'Cross-companion source');
    else { text = snapshot.text; actor = snapshot.actor_id; }
  }
  if (actor !== undefined && actor !== evidence.speaker_actor_id) issue(issues, 'VALIDATION_ERROR', path, 'Evidence speaker differs from the stored source');
  const knownActor = context.actors.get(evidence.speaker_actor_id);
  if (!knownActor || knownActor.companion_id !== context.companion_id) issue(issues, 'FORBIDDEN', path, 'Unknown evidence actor');
  if (evidence.end <= evidence.start || (text !== undefined &&
    (evidence.end > codePointLength(text) || sliceCodePoints(text, evidence.start, evidence.end) !== evidence.quote))) {
    issue(issues, 'VALIDATION_ERROR', path, 'Evidence span does not match the stored source in code points');
  }
}
function referencedEvidence(ids: readonly string[], context: ValidationContext, issues: ContractIssue[], path: string): Evidence[] {
  const found: Evidence[] = [];
  if (new Set(ids).size !== ids.length) issue(issues, 'VALIDATION_ERROR', path, 'Evidence IDs must be unique');
  for (const id of ids) {
    const evidence = context.evidence.get(id);
    if (!evidence) issue(issues, 'NOT_FOUND', path, 'Referenced evidence does not exist');
    else { checkEvidence(evidence, context, `${path}.${id}`, issues); found.push(evidence); }
  }
  return found;
}
function isDirectUserEvidence(evidence: Evidence, context: ValidationContext): boolean {
  if (evidence.source.kind === 'source_record') {
    const source = context.sources.get(sourceKey(evidence.source));
    return source?.kind === 'dialogue' && context.actors.get(source.actor_id)?.kind === 'user';
  }
  const message = context.messages.get(messageKey(evidence.source.ref));
  return message?.role === 'user' && context.actors.get(message.actor_id)?.kind === 'user';
}
function checkScope(scope: {kind: string; id: string}, context: ValidationContext, issues: ContractIssue[], path: string, extraIds: ReadonlySet<string> = new Set()): void {
  const valid = scope.kind === 'companion' ? scope.id === context.companion_id
    : scope.kind === 'conversation' ? context.conversations.has(scope.id)
    : extraIds.has(scope.id) || (context.memories.get(scope.id)?.kind === 'episode' && context.memories.get(scope.id)?.companion_id === context.companion_id);
  if (!valid) issue(issues, 'NOT_FOUND', path, 'Scope does not name an object of the required kind');
}
function checkPattern(value: PreferenceValue | Extract<Memory, {kind: 'communication_pattern'}> | ResponseNeedRecord, context: ValidationContext, issues: ContractIssue[], path: string): void {
  const evidence = referencedEvidence(value.evidence_ids, context, issues, `${path}.evidence_ids`);
  checkScope(value.scope, context, issues, `${path}.scope`);
  if (('category' in value && value.category === 'response_need') || ('kind' in value && value.kind === 'response_need')) {
    if (!evidence.some(e => isDirectUserEvidence(e, context))) issue(issues, 'VALIDATION_ERROR', path, 'A response need cannot be inferred from assistant-only material');
    if (value.basis_kind === 'user_explicit' && !evidence.some(e => isDirectUserEvidence(e, context))) issue(issues, 'VALIDATION_ERROR', path, 'An explicit response need requires user evidence');
    if (value.status === 'user_confirmed' && (value.basis_kind !== 'user_explicit' || !evidence.some(e => isDirectUserEvidence(e, context)))) {
      issue(issues, 'VALIDATION_ERROR', path, 'A confirmed response need requires user evidence');
    }
    return;
  }
  if (!('pattern_kind' in value)) return;
  if (value.pattern_kind === 'explicit_preference') {
    if (!evidence.some(e => isDirectUserEvidence(e, context))) issue(issues, 'VALIDATION_ERROR', path, 'An explicit preference requires direct user evidence');
  } else {
    const contexts = new Set(evidence.map(e => e.source.kind === 'message' ? e.source.ref.conversation_id : `source:${e.source.source_id}`));
    const declared = new Set(value.independent_context_ids);
    const ready = contexts.size >= 2 && declared.size >= 2 && [...declared].every(id => contexts.has(id))
      && value.conditions.length > 0 && value.counterexamples_reviewed;
    if (!ready) issue(issues, 'VALIDATION_ERROR', path, 'An observed pattern needs independent contexts, conditions and counterexample review');
    if (value.status === 'user_confirmed') issue(issues, 'VALIDATION_ERROR', path, 'Repeated observations are not user confirmation');
  }
  referencedEvidence(value.counterexample_evidence_ids, context, issues, `${path}.counterexamples`);
}

function checkMemory(memory: Memory, context: ValidationContext, issues: ContractIssue[], extraIds: ReadonlySet<string> = new Set()): void {
  if (memory.companion_id !== context.companion_id) issue(issues, 'FORBIDDEN', memory.id, 'Cross-companion memory');
  if (Date.parse(memory.updated_at) < Date.parse(memory.created_at)) issue(issues, 'VALIDATION_ERROR', memory.id, 'Updated time precedes creation');
  referencedEvidence(memory.evidence_ids, context, issues, `${memory.id}.evidence_ids`);
  if (memory.kind !== 'episode') { checkPattern(memory, context, issues, memory.id); return; }
  if (!memory.summary.trim()) issue(issues, 'VALIDATION_ERROR', memory.id, 'Summary must contain text');
  checkTime(memory.occurred, `${memory.id}.occurred`, issues);
  referencedEvidence(memory.occurred.evidence_ids, context, issues, `${memory.id}.occurred.evidence_ids`);
  for (const actorId of memory.participant_ids) {
    const actor = context.actors.get(actorId);
    if (!actor || actor.companion_id !== context.companion_id) issue(issues, 'FORBIDDEN', memory.id, 'Unknown or cross-companion participant');
    else if (actor.kind === 'unknown' && memory.publication_status === 'published') issue(issues, 'VALIDATION_ERROR', memory.id, 'Unknown participants must remain staged');
  }
  for (const interpretation of memory.interpretations) {
    const path = `${memory.id}.interpretations.${interpretation.id}`;
    const evidence = referencedEvidence(interpretation.evidence_ids, context, issues, path);
    const actor = context.actors.get(interpretation.actor_id);
    if (!actor || actor.companion_id !== context.companion_id) issue(issues, 'FORBIDDEN', path, 'Unknown interpretation actor');
    checkScope(interpretation.scope, context, issues, path, new Set([...extraIds, memory.id]));
    if (interpretation.scope.kind === 'companion' || (interpretation.scope.kind === 'episode' && interpretation.scope.id !== memory.id)) issue(issues, 'VALIDATION_ERROR', path, 'Episode interpretations cannot silently become global rules or another episode');
    checkTime(interpretation.felt_time, path, issues);
    referencedEvidence(interpretation.felt_time.evidence_ids, context, issues, path);
    if (interpretation.expressed_at) checkMessage(interpretation.expressed_at, context, path, issues);
    if (interpretation.expressed_at && !evidence.some(item => item.source.kind === 'message' && messageKey(item.source.ref) === messageKey(interpretation.expressed_at!))) issue(issues, 'VALIDATION_ERROR', path, 'Expression anchor must be supported by the interpretation evidence');
    if ((interpretation.basis_kind === 'user_explicit' || interpretation.status === 'user_confirmed') && !evidence.some(e => isDirectUserEvidence(e, context))) {
      issue(issues, 'VALIDATION_ERROR', path, 'User attribution needs actual user evidence');
    }
    if (interpretation.status === 'user_confirmed' && interpretation.basis_kind !== 'user_explicit') issue(issues, 'VALIDATION_ERROR', path, 'Confirmation must be explicit');
    if (interpretation.basis_kind === 'context_inferred' && !evidence.some(e => isDirectUserEvidence(e, context))) issue(issues, 'VALIDATION_ERROR', path, 'Contextual inference requires user evidence; old summaries retain legacy_summary attribution');
    if (memory.publication_status === 'published' && interpretation.status !== 'corrected' &&
      ['assistant_suggested', 'unknown'].includes(interpretation.basis_kind)) issue(issues, 'VALIDATION_ERROR', path, 'Assistant suggestions and unknown emotions cannot be published as user history');
    if ((interpretation.status === 'corrected') !== (interpretation.superseded_by !== null)) issue(issues, 'VALIDATION_ERROR', path, 'Corrected interpretations need a replacement reference');
    if (interpretation.superseded_by && !memory.interpretations.some(item => item.id === interpretation.superseded_by && item.id !== interpretation.id && item.status !== 'corrected')) issue(issues, 'VALIDATION_ERROR', path, 'Corrected interpretation must point to an effective replacement in this revision');
    if (interpretation.temporal_update === 'retrospective') {
      if (!interpretation.retrospective_evidence_ids.length || !interpretation.expressed_at) issue(issues, 'VALIDATION_ERROR', path, 'Retrospective interpretation requires an expression anchor and evidence');
      const references = referencedEvidence(interpretation.retrospective_evidence_ids, context, issues, path);
      if (!references.some(e => isDirectUserEvidence(e, context))) issue(issues, 'VALIDATION_ERROR', path, 'Retrospection requires user context, not only assistant speculation');
    } else if (interpretation.retrospective_evidence_ids.length) issue(issues, 'VALIDATION_ERROR', path, 'Retrospective evidence requires retrospective mode');
    if (interpretation.expressed_at && interpretation.felt_time.precision !== 'unknown') {
      const expressed = context.messages.get(messageKey(interpretation.expressed_at));
      if (expressed) {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: context.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(expressed.captured_at));
        const part = (name: string) => parts.find(item => item.type === name)!.value;
        const day = `${part('year')}-${part('month')}-${part('day')}`;
        const precision = interpretation.felt_time.precision;
        const before = precision === 'instant' ? Date.parse(interpretation.felt_time.start) < Date.parse(expressed.captured_at)
          : interpretation.felt_time.start < day.slice(0, precision === 'year' ? 4 : precision === 'month' ? 7 : 10);
        if (before && interpretation.temporal_update !== 'retrospective') issue(issues, 'VALIDATION_ERROR', path, 'Backdating requires explicit retrospective handling');
      }
    }
  }
}

export function validateMemory(value: unknown, context: ValidationContext): ContractResult<Memory> {
  const parsed = structural(MemorySchema, value);
  if (!parsed.ok) return parsed;
  const issues: ContractIssue[] = [];
  checkMemory(parsed.value, context, issues);
  return issues.length ? { ok: false, issues } : parsed;
}

function checkProjection(view: Memory, stored: Memory | undefined, truncated: boolean, includeCorrected: boolean, context: ValidationContext, issues: ContractIssue[], path: string): void {
  if (!stored || stored.companion_id !== context.companion_id || view.companion_id !== context.companion_id
    || stored.version !== view.version || stored.suppression_generation !== view.suppression_generation) {
    issue(issues, 'STALE_INPUT', path, 'Projection is not the current bound memory'); return;
  }
  const expected = structuredClone(stored);
  if (expected.kind === 'episode') {
    expected.interpretations = expected.interpretations.filter(item => includeCorrected || item.status !== 'corrected');
    if (view.kind === 'episode' && truncated) {
      if (!expected.summary.startsWith(view.summary) || !expected.details.startsWith(view.details)) issue(issues, 'VALIDATION_ERROR', path, 'Truncated text must be a prefix of stored text');
      expected.summary = view.summary; expected.details = view.details;
    }
  }
  if (hashJson(view) !== hashJson(expected)) issue(issues, 'VALIDATION_ERROR', path, 'Read projection differs from the stored record');
}

export function validateToolInput<N extends ToolName>(name: N, value: unknown, context: ValidationContext): ContractResult<ToolInput<N>> {
  // The runtime index and generic input are correlated, which TS cannot express for this union.
  const parsed = structural(toolContracts[name].input as unknown as z.ZodType<ToolInput<N>>, value);
  if (!parsed.ok) return parsed;
  const issues: ContractIssue[] = [];
  if (!context.capabilities.has(toolContracts[name].capability)) issue(issues, 'FORBIDDEN', name, 'Caller lacks the required capability');
  if (name === 'recall_context') {
    const input = parsed.value as ToolInput<'recall_context'>;
    if (input.recent_context.reduce((n, item) => n + codePointLength(item.text), 0) > 8000) issue(issues, 'BUDGET_EXCEEDED', name, 'Recent context exceeds the combined budget');
    if (input.time_range) checkTime(input.time_range, name, issues);
    const branch = context.branches.get(branchKey(input.conversation_id, input.branch_id));
    if (branch && branch.chain_revision !== input.chain_revision) issue(issues, 'STALE_INPUT', name, 'Recall refers to an obsolete chain');
    for (const item of input.recent_context) {
      const source = checkMessage(item.ref, context, name, issues);
      if (source && (source.text !== item.text || source.role !== item.role)) issue(issues, 'VALIDATION_ERROR', name, 'Recent context differs from the stored message');
    }
  }
  if (name === 'get_episode') {
    const input = parsed.value as ToolInput<'get_episode'>;
    const memory = context.memories.get(input.episode_id);
    if (!memory || memory.kind !== 'episode' || memory.companion_id !== context.companion_id || memory.content_status !== 'active' || memory.publication_status !== 'published') issue(issues, 'NOT_FOUND', name, 'Episode is not visible in the bound companion');
  }
  if (name === 'observe_turn') {
    const input = parsed.value as ToolInput<'observe_turn'>;
    if (new Set(input.messages.map(m => m.message_id)).size !== input.messages.length || input.messages.some((m, i) => m.position !== i)) issue(issues, 'VALIDATION_ERROR', name, 'Message IDs and contiguous positions must be unique');
    if (input.messages[0]?.role !== 'user') issue(issues, 'VALIDATION_ERROR', name, 'A turn begins with the actual user message');
    let sawAssistant = false;
    for (const message of input.messages) {
      if (message.role === 'assistant') sawAssistant = true;
      else if (sawAssistant || message.status !== 'complete') issue(issues, 'VALIDATION_ERROR', name, 'User messages precede assistant messages and are complete');
      if (!message.text.trim() && (message.role === 'user' || message.status === 'complete')) issue(issues, 'VALIDATION_ERROR', name, 'Completed messages must contain visible text');
    }
    if (input.messages.reduce((n, message) => n + codePointLength(message.text), 0) > 128000) issue(issues, 'BUDGET_EXCEEDED', name, 'Turn payload exceeds the combined budget');
    const branch = context.branches.get(branchKey(input.conversation_id, input.branch_id));
    if (branch && input.chain_revision < branch.chain_revision) issue(issues, 'STALE_INPUT', name, 'The branch has been edited');
    const existing = branch?.turns.get(input.sequence);
    if (existing && existing !== input.turn_id) issue(issues, 'VERSION_CONFLICT', name, 'Sequence already identifies another turn');
  }
  if (name === 'set_memory_preference') {
    const input = parsed.value as ToolInput<'set_memory_preference'>;
    checkPattern(input.value, context, issues, name);
    if (input.operation === 'update') {
      checkTargets([{ memory_id: input.memory_id, expected_version: input.expected_version, suppression_generation: input.suppression_generation }], context, issues);
      const previous = context.memories.get(input.memory_id);
      if (previous && previous.kind !== input.value.category) issue(issues, 'VALIDATION_ERROR', name, 'Preference updates cannot change an episode or switch record kind');
      if (previous && previous.kind !== 'episode' && (previous.scope.kind !== input.value.scope.kind || previous.scope.id !== input.value.scope.id
        || (previous.kind === 'communication_pattern' && 'pattern_kind' in input.value && previous.pattern_kind !== input.value.pattern_kind))
        && !input.value.evidence_ids.some(id => !previous.evidence_ids.includes(id))) issue(issues, 'VALIDATION_ERROR', name, 'Scope or attribution changes require new evidence');
    }
  }
  if (name === 'retract_memory') {
    const input = parsed.value as ToolInput<'retract_memory'>;
    checkTargets([input], context, issues);
    if (!referencedEvidence(input.evidence_ids, context, issues, name).some(e => isDirectUserEvidence(e, context))) issue(issues, 'VALIDATION_ERROR', name, 'Retraction requires user evidence');
  }
  if (name === 'correct_memory') {
    const input = parsed.value as ToolInput<'correct_memory'>;
    checkTargets(input.targets, context, issues);
    if (!referencedEvidence(input.evidence_ids, context, issues, name).some(e => isDirectUserEvidence(e, context))) issue(issues, 'VALIDATION_ERROR', name, 'Correction requires actual user evidence');
    checkMutations(input.targets, input.mutations, context, issues);
    checkLinks(input.links, input.mutations, context, issues);
  }
  return issues.length ? { ok: false, issues } : parsed;
}

function checkTargets(targets: readonly {memory_id: string; expected_version: number; suppression_generation: number}[], context: ValidationContext, issues: ContractIssue[]): void {
  if (new Set(targets.map(target => target.memory_id)).size !== targets.length) issue(issues, 'VALIDATION_ERROR', 'targets', 'Targets must be unique');
  for (const target of targets) {
    const memory = context.memories.get(target.memory_id);
    if (!memory || memory.companion_id !== context.companion_id) issue(issues, 'NOT_FOUND', 'targets', 'Target is not visible');
    else if (memory.version !== target.expected_version || memory.suppression_generation !== target.suppression_generation) issue(issues, 'VERSION_CONFLICT', 'targets', 'Target revision or suppression guard changed');
    else if (memory.content_status === 'retracted') issue(issues, 'STALE_INPUT', 'targets', 'Automatic or ordinary updates cannot restore a retracted record');
  }
}
function checkMutations(targets: CandidatePatch['targets'], mutations: CandidatePatch['mutations'], context: ValidationContext, issues: ContractIssue[]): void {
  const targetMap = new Map(targets.map(target => [target.memory_id, target]));
  const extraIds = new Set(mutations.filter(m => m.operation === 'create').map(m => m.record.id));
  const touched = new Set<string>();
  for (const mutation of mutations) {
    if (touched.has(mutation.record.id)) issue(issues, 'VALIDATION_ERROR', 'mutations', 'Record is mutated more than once');
    touched.add(mutation.record.id);
    if (mutation.operation === 'create') {
      if (mutation.temporary_id !== mutation.record.id || mutation.record.version !== 1 || mutation.record.suppression_generation !== 0 || context.memories.has(mutation.record.id)) issue(issues, 'VALIDATION_ERROR', 'mutations', 'New records require unique temporary IDs and initial versions');
    } else {
      const target = targetMap.get(mutation.memory_id);
      const previous = context.memories.get(mutation.memory_id);
      const expectedGeneration = target ? target.suppression_generation + (mutation.record.content_status === 'retracted' ? 1 : 0) : -1;
      if (!target || mutation.record.id !== mutation.memory_id || mutation.record.version !== target.expected_version + 1
        || mutation.record.suppression_generation !== expectedGeneration
        || (previous && (previous.kind !== mutation.record.kind || previous.created_at !== mutation.record.created_at))) {
        issue(issues, 'VALIDATION_ERROR', 'mutations', 'Every revision must match a guarded target and immutable record identity');
      }
    }
    checkMemory(mutation.record, context, issues, extraIds);
  }
  for (const target of targets) if (!mutations.some(m => m.operation === 'revise' && m.memory_id === target.memory_id)) issue(issues, 'VALIDATION_ERROR', 'targets', 'Every guarded target must be in the atomic mutation set');
}

function checkLinks(links: CandidatePatch['links'], mutations: CandidatePatch['mutations'], context: ValidationContext, issues: ContractIssue[]): void {
  const ids = new Set([...context.memories.values()].filter(memory => memory.companion_id === context.companion_id).map(memory => memory.id));
  for (const mutation of mutations) ids.add(mutation.record.id);
  const seen = new Set<string>();
  for (const link of links) {
    const key = `${link.from}/${link.to}/${link.relation}`;
    if (link.from === link.to || !ids.has(link.from) || !ids.has(link.to) || seen.has(key)) issue(issues, 'VALIDATION_ERROR', 'links', 'Links need distinct existing endpoints and must not repeat');
    seen.add(key);
  }
}

export function validateCandidate(value: unknown, context: ValidationContext): ContractResult<CandidatePatch> {
  const parsed = structural(CandidatePatchSchema, value);
  if (!parsed.ok) return parsed;
  const patch = parsed.value;
  const issues: ContractIssue[] = [];
  if (!context.capabilities.has('candidate') || patch.companion_id !== context.companion_id) issue(issues, 'FORBIDDEN', 'candidate', 'Candidate validation is bound to the internal companion context');
  const branch = context.branches.get(branchKey(patch.input_watermark.conversation_id, patch.input_watermark.branch_id));
  if (!branch || branch.chain_revision !== patch.input_watermark.chain_revision) issue(issues, 'STALE_INPUT', 'input_watermark', 'Candidate chain is stale');
  if (Math.max(...patch.input_messages.map(ref => ref.sequence)) !== patch.input_watermark.sequence) issue(issues, 'STALE_INPUT', 'input_watermark', 'Snapshot must include its terminal turn');
  for (const ref of patch.input_messages) {
    checkMessage(ref, context, 'input_messages', issues);
    if (ref.conversation_id !== patch.input_watermark.conversation_id || ref.branch_id !== patch.input_watermark.branch_id || ref.sequence > patch.input_watermark.sequence) issue(issues, 'STALE_INPUT', 'input_messages', 'Input lies outside the declared snapshot');
  }
  const inputKeys = new Set(patch.input_messages.map(messageKey));
  for (const evidence of patch.evidence) if (evidence.source.kind === 'message' && !inputKeys.has(messageKey(evidence.source.ref))) issue(issues, 'VALIDATION_ERROR', 'evidence', 'New message evidence must be part of the declared snapshot');
  const evidence = new Map(context.evidence);
  if (new Set(patch.evidence.map(item => item.id)).size !== patch.evidence.length) issue(issues, 'VALIDATION_ERROR', 'evidence', 'Candidate evidence IDs must be unique');
  for (const item of patch.evidence) {
    if (evidence.has(item.id) && hashJson(evidence.get(item.id)) !== hashJson(item)) issue(issues, 'VALIDATION_ERROR', 'evidence', 'Evidence IDs are immutable');
    evidence.set(item.id, item);
    checkEvidence(item, context, 'evidence', issues);
  }
  for (const guard of patch.source_guards) {
    const versions = [...context.sources.values()].filter(source => source.source_id === guard.source_id && source.external_id === guard.external_id);
    if (!versions.length || versions.some(source => source.suppressed || source.generation !== guard.generation)) issue(issues, 'STALE_INPUT', 'source_guards', 'Source suppression changed');
  }
  const usedIds = new Set(patch.mutations.flatMap(mutation => {
    const record = mutation.record;
    return record.kind === 'episode'
      ? [...record.evidence_ids, ...record.occurred.evidence_ids, ...record.interpretations.flatMap(item => [...item.evidence_ids, ...item.felt_time.evidence_ids, ...item.retrospective_evidence_ids])]
      : record.kind === 'communication_pattern' ? [...record.evidence_ids, ...record.counterexample_evidence_ids] : record.evidence_ids;
  }));
  const usedEvidence = [...patch.evidence, ...[...usedIds].map(id => evidence.get(id)).filter((item): item is Evidence => !!item)];
  for (const item of usedEvidence) if (item.source.kind === 'source_record' && !patch.source_guards.some(guard => item.source.kind === 'source_record' && guard.source_id === item.source.source_id && guard.external_id === item.source.external_id)) issue(issues, 'VALIDATION_ERROR', 'source_guards', 'Imported evidence needs a cross-hash suppression guard, including reused evidence');
  checkTargets(patch.targets, context, issues);
  checkMutations(patch.targets, patch.mutations, { ...context, evidence }, issues);
  checkLinks(patch.links, patch.mutations, context, issues);
  return issues.length ? { ok: false, issues } : parsed;
}

export function validateToolOutput<N extends ToolName>(name: N, input: ToolInput<N>, value: unknown, context: ValidationContext): ContractResult<ToolOutput<N>> {
  const parsed = structural(toolContracts[name].output as unknown as z.ZodType<ToolOutput<N>>, value);
  if (!parsed.ok) return parsed;
  const issues: ContractIssue[] = [];
  if (name === 'recall_context' && parsed.value.outcome.status === 'ok') {
    const data = (parsed.value as ToolOutput<'recall_context'>).outcome;
    if (data.status === 'ok') {
      const query = input as ToolInput<'recall_context'>;
      const chars = codePointLength(JSON.stringify(data.data.items));
      if (data.data.items.length > query.max_items || chars > query.max_chars) issue(issues, 'BUDGET_EXCEEDED', name, 'Recall items exceed the requested count or serialized code-point budget');
      for (const item of data.data.items) {
        const stored = context.memories.get(item.memory.id);
        checkProjection(item.memory, stored, item.truncated, false, context, issues, name);
        if (!stored || stored.companion_id !== context.companion_id || stored.version !== item.memory.version || stored.suppression_generation !== item.memory.suppression_generation || stored.content_status !== 'active') issue(issues, 'STALE_INPUT', name, 'Recall hit is not the current visible memory');
        const available = new Map(context.evidence);
        for (const entry of item.evidence) { checkEvidence(entry, context, name, issues); available.set(entry.id, entry); }
        checkMemory(item.memory, { ...context, evidence: available }, issues);
        if (item.memory.content_status !== 'active' || item.memory.publication_status !== 'published') issue(issues, 'VALIDATION_ERROR', name, 'Only current published active memories may be recalled');
        if (item.memory.kind === 'episode' && item.memory.interpretations.some(entry => entry.status === 'corrected')) issue(issues, 'VALIDATION_ERROR', name, 'Corrected interpretations belong to history, not default recall');
      }
    }
  }
  if (name === 'observe_turn' && parsed.value.outcome.status === 'ok') {
    const output = (parsed.value as ToolOutput<'observe_turn'>).outcome;
    if (output.status === 'ok') {
      const accepted = output.data.accepted_through; const processed = output.data.processed_through;
      const observation = input as ToolInput<'observe_turn'>;
      if ([accepted, processed].some(mark => mark.conversation_id !== observation.conversation_id || mark.branch_id !== observation.branch_id || mark.chain_revision !== observation.chain_revision)
        || processed.sequence > accepted.sequence) issue(issues, 'VALIDATION_ERROR', name, 'Receipt watermarks must refer to the same input chain and be ordered');
      if (output.data.processing_status === 'processed' && processed.sequence < observation.sequence) issue(issues, 'VALIDATION_ERROR', name, 'A processed receipt cannot lie beyond its processed watermark');
    }
  }
  if (name === 'get_episode' && parsed.value.outcome.status === 'ok') {
    const output = (parsed.value as ToolOutput<'get_episode'>).outcome;
    if (output.status === 'ok') {
      const query = input as ToolInput<'get_episode'>;
      if (output.data.episode.id !== query.episode_id) issue(issues, 'VALIDATION_ERROR', name, 'Episode result differs from requested ID');
      if (codePointLength(JSON.stringify(output.data)) > query.max_chars) issue(issues, 'BUDGET_EXCEEDED', name, 'Episode result exceeds requested budget');
      checkProjection(output.data.episode, context.memories.get(query.episode_id), output.data.truncated, query.include_history, context, issues, name);
      if (output.data.episode.content_status !== 'active' || output.data.episode.publication_status !== 'published') issue(issues, 'STALE_INPUT', name, 'Withdrawn or staged episodes are not available through read tools');
      const evidence = new Map(context.evidence);
      for (const item of output.data.evidence) { checkEvidence(item, context, name, issues); evidence.set(item.id, item); }
      checkMemory(output.data.episode, { ...context, evidence }, issues);
    }
  }
  if (name === 'correct_memory' && parsed.value.outcome.status === 'ok') {
    const output = (parsed.value as ToolOutput<'correct_memory'>).outcome;
    const correction = input as ToolInput<'correct_memory'>;
    if (output.status === 'ok') {
      const changedIds = output.data.changed.map(item => item.memory_id);
      if (new Set(changedIds).size !== changedIds.length || correction.targets.some(target => !output.data.changed.some(item => item.memory_id === target.memory_id && item.version === target.expected_version + 1
        && item.suppression_generation === correction.mutations.find(mutation => mutation.operation === 'revise' && mutation.memory_id === target.memory_id)?.record.suppression_generation))
        || output.data.changed.some(item => !correction.targets.some(target => target.memory_id === item.memory_id))) issue(issues, 'VALIDATION_ERROR', name, 'Correction receipt must cover exactly the entire guarded target set');
      const requestedCreates = correction.mutations.filter(item => item.operation === 'create');
      const mapped = output.data.created;
      if (mapped.length !== requestedCreates.length || new Set(mapped.map(item => item.temporary_id)).size !== mapped.length
        || new Set(mapped.map(item => item.memory_id)).size !== mapped.length
        || mapped.some(item => !requestedCreates.some(requested => requested.temporary_id === item.temporary_id) || context.memories.has(item.memory_id))) issue(issues, 'VALIDATION_ERROR', name, 'Created mappings must match requested temporary IDs and use fresh final IDs');
    }
  }
  if (name === 'retract_memory' && parsed.value.outcome.status === 'ok') {
    const output = (parsed.value as ToolOutput<'retract_memory'>).outcome;
    const request = input as ToolInput<'retract_memory'>;
    if (output.status === 'ok' && (output.data.memory_id !== request.memory_id || output.data.version !== request.expected_version + 1
      || output.data.suppression_generation !== request.suppression_generation + 1)) issue(issues, 'VALIDATION_ERROR', name, 'Retraction receipt must match its target and next revision/generation');
  }
  if (name === 'set_memory_preference' && parsed.value.outcome.status === 'ok') {
    const output = (parsed.value as ToolOutput<'set_memory_preference'>).outcome;
    const request = input as ToolInput<'set_memory_preference'>;
    const effect = request.value.category === 'response_need' ? 'local_response_need' : request.value.pattern_kind;
    if (output.status === 'ok' && (output.data.version !== request.expected_version + 1 || output.data.effect !== effect
      || (request.operation === 'update' ? output.data.memory_id !== request.memory_id : context.memories.has(output.data.memory_id)))) issue(issues, 'VALIDATION_ERROR', name, 'Preference receipt must match creation/update and local/long-term effect');
  }
  if (Buffer.byteLength(JSON.stringify(parsed.value), 'utf8') > 128 * 1024) issue(issues, 'BUDGET_EXCEEDED', name, 'Business envelope exceeds the hard byte budget');
  return issues.length ? { ok: false, issues } : parsed;
}

export function validateArchiveManifest(value: unknown): ContractResult<ArchiveManifest> {
  const parsed = structural(ArchiveManifestSchema, value);
  if (!parsed.ok) return parsed;
  const manifest = parsed.value;
  const issues: ContractIssue[] = [];
  if (Buffer.byteLength(JSON.stringify(manifest), 'utf8') > 1024 * 1024) issue(issues, 'BUDGET_EXCEEDED', 'manifest', 'Manifest exceeds the 1 MiB byte limit');
  const ids = new Set<string>();
  let offset = 0;
  let total = 0;
  for (const member of manifest.members) {
    if (ids.has(member.member_id) || member.offset_bytes !== offset) issue(issues, 'VALIDATION_ERROR', 'members', 'Members must be unique, contiguous and ordered');
    ids.add(member.member_id);
    if ((member.memory_id === null) !== (member.memory_version === null)) issue(issues, 'VALIDATION_ERROR', 'members', 'Memory ID and version must both be present or both absent');
    if (member.kind === 'memory_revision' && member.memory_id === null) issue(issues, 'VALIDATION_ERROR', 'members', 'A memory revision needs a memory identity');
    offset += member.compressed_bytes; total += member.uncompressed_bytes;
  }
  if (offset !== manifest.compressed_bytes || total !== manifest.uncompressed_bytes) issue(issues, 'VALIDATION_ERROR', 'members', 'Declared byte totals do not match members');
  return issues.length ? { ok: false, issues } : parsed;
}
