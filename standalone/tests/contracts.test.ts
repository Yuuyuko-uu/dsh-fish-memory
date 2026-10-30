import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { codePointLength, sliceCodePoints } from '../src/domain/common.ts';
import { EpisodeSchema, type CandidatePatch, type Episode } from '../src/domain/memory.ts';
import { toolContracts, type ToolInput } from '../src/contracts/tools.ts';
import { exportContractBundle } from '../src/contracts/registry.ts';
import {
  validateMemory, validateToolInput, validateToolOutput, validateCandidate,
  messageKey, type ValidationContext,
} from '../src/contracts/validation.ts';
import { canonicalJson, hashJson } from '../src/contracts/canonical.ts';
import { fixtureSet, FixtureSetSchema, contextFor, evidenceFor, message, episode, interpretation, COMPANION } from '../fixtures/scenarios.ts';

function rejected(result: {ok: boolean; issues?: {code: string}[]}, code?: string): void {
  assert.equal(result.ok, false);
  if (code) assert.ok(result.issues?.some(item => item.code === code), JSON.stringify(result));
}
const scenario = fixtureSet.scenarios[0]!;
const context = contextFor(scenario);
const finalEpisode = scenario.checkpoints.at(-1)!.expected_records[0]! as Episode;
const recall: ToolInput<'recall_context'> = {
  contract_version: '1.0.0', conversation_id: 'conversation-demo', branch_id: 'main', chain_revision: 1,
  query: '方案反复修改的事', recent_context: [], time_range: null, max_items: 6, max_chars: 6000,
};
function correctionSetup(): { context: ValidationContext; input: ToolInput<'correct_memory'>; patch: CandidatePatch } {
  const fixture = fixtureSet.scenarios.find(item => item.id === 'explicit-correction')!;
  const current = contextFor(fixture);
  const oldMemory = fixture.checkpoints[0]!.expected_records[0]!;
  const next = fixture.checkpoints[1]!.expected_records[0]!;
  const revised = { ...current, memories: new Map([[oldMemory.id, oldMemory]]) };
  const targets = [{ memory_id: oldMemory.id, expected_version: oldMemory.version, suppression_generation: 0 }];
  const mutations = [{ operation: 'revise' as const, memory_id: next.id, record: next }];
  return {
    context: revised,
    input: { contract_version: '1.0.0', request_id: 'correct-demo', correction_kind: 'reinterpret',
      targets, mutations, links: [], evidence_ids: [fixture.evidence[1]!.id], reason: '用户明确纠正先前理解。' },
    patch: { contract_version: '1.0.0', request_id: 'candidate-demo', job_id: 'job-demo', companion_id: COMPANION,
      input_watermark: fixture.checkpoints[1]!.through, input_messages: fixture.messages.map(item => item.ref),
      targets, source_guards: [], mutations, evidence: fixture.evidence, links: [], reason: '用户明确纠正先前理解。' },
  };
}

for (const item of fixtureSet.scenarios) {
  for (const [index, checkpoint] of item.checkpoints.entries()) {
    test(`labelled fixture: ${item.id} / checkpoint ${index + 1}`, () => {
      const state = contextFor(item, index);
      for (const memory of checkpoint.expected_records) {
        const result = validateMemory(memory, state);
        assert.equal(result.ok, true, JSON.stringify(result));
      }
    });
  }
}

test('generated JSON fixtures and schema bundle have not drifted', () => {
  const fixtures = JSON.parse(readFileSync(new URL('../fixtures/conversations.generated.json', import.meta.url), 'utf8'));
  assert.deepEqual(FixtureSetSchema.parse(fixtures), fixtureSet);
  const bundle = JSON.parse(readFileSync(new URL('../contracts/schema-bundle.json', import.meta.url), 'utf8'));
  assert.deepEqual(bundle, exportContractBundle());
  assert.equal(bundle.$schema, 'https://json-schema.org/draft/2020-12/schema');
  const definitions = bundle.$defs as Record<string, {additionalProperties?: boolean; type?: string}>;
  assert.equal(Object.keys(definitions).length, 23);
  assert.equal((bundle['x-tools'] as unknown[]).length, 6);
  for (const name of Object.keys(toolContracts)) {
    assert.equal(definitions[`${name}_input`]!.additionalProperties, name === 'set_memory_preference' ? undefined : false);
    assert.equal(definitions[`${name}_output`]!.type, 'object');
  }
});

test('gradual venting does not use future evidence or label the opening as confirmed distress', () => {
  const first = scenario.checkpoints[0]!.expected_records[0]! as Episode;
  assert.equal(first.interpretations.length, 0);
  assert.equal(finalEpisode.id, first.id);
  assert.equal(finalEpisode.version, 4);
  const need = finalEpisode.interpretations.find(item => item.kind === 'response_need')!;
  assert.deepEqual(need.scope, { kind: 'episode', id: first.id });
  rejected(validateMemory(finalEpisode, contextFor(scenario, 0)), 'NOT_FOUND');
});

test('unknown event time is not substituted with capture time', () => {
  assert.equal(finalEpisode.occurred.precision, 'unknown');
  rejected(validateMemory({ ...finalEpisode, occurred: { ...finalEpisode.occurred, start: finalEpisode.created_at } }, context));
  rejected(validateMemory({ ...finalEpisode, occurred: { precision: 'day', start: '2026-02-30', end: null, basis: 'user_explicit', evidence_ids: finalEpisode.evidence_ids } }, context));
  rejected(validateMemory({ ...finalEpisode, occurred: { precision: 'day', start: '2026-10-30', end: '2026-10-01', basis: 'user_explicit', evidence_ids: finalEpisode.evidence_ids } }, context));
});

test('Unicode evidence uses code points and rejects UTF-16 offsets and forged quotes', () => {
  assert.equal(codePointLength('😀e\u0301'), 3);
  assert.equal(sliceCodePoints('😀开心', 1, 3), '开心');
  assert.equal(EpisodeSchema.shape.summary.safeParse('😀'.repeat(1200)).success, true);
  assert.equal(EpisodeSchema.shape.summary.safeParse('😀'.repeat(1201)).success, false);
  const source = message(1, '😀我很开心。');
  const evidence = evidenceFor(source, '我很开心。');
  assert.equal(evidence.start, 1);
  const memory = episode('unicode-guard', 1, [source], '明确开心。');
  memory.evidence_ids = [evidence.id];
  const state = { ...context, messages: new Map([[messageKey(source.ref), source]]), evidence: new Map([[evidence.id, evidence]]) };
  assert.equal(validateMemory(memory, state).ok, true);
  const forged = { ...evidence, start: 2, end: evidence.end + 1 };
  rejected(validateMemory(memory, { ...state, evidence: new Map([[evidence.id, forged]]) }));
});

test('assistant suggestions and injected history cannot become user evidence', () => {
  const assistant = message(1, '你一定很委屈。', 'assistant');
  const ev = evidenceFor(assistant);
  const memory = episode('assistant-claim', 1, [assistant], '候选感受。');
  memory.interpretations = [interpretation(memory, assistant, '委屈')];
  const state = { ...context, messages: new Map([[messageKey(assistant.ref), assistant]]), evidence: new Map([[ev.id, ev]]) };
  rejected(validateMemory(memory, state));
  memory.interpretations[0]!.basis_kind = 'assistant_suggested';
  memory.interpretations[0]!.status = 'user_confirmed';
  rejected(validateMemory(memory, state));
  const user = scenario.messages[0]!;
  rejected(validateMemory(finalEpisode, { ...context, messages: new Map([...context.messages, [messageKey(user.ref), { ...user, channel: 'injected' }]]) }), 'FORBIDDEN');
});

test('backdating and corrected interpretations require explicit structural grounding', () => {
  const memory = structuredClone(finalEpisode);
  memory.interpretations[0]!.felt_time = { precision: 'instant', start: '2026-10-29T01:00:00Z', end: null, basis: 'user_explicit', evidence_ids: memory.interpretations[0]!.evidence_ids };
  rejected(validateMemory(memory, context));
  memory.interpretations[0]!.temporal_update = 'retrospective';
  rejected(validateMemory(memory, context));
  memory.interpretations[0]!.retrospective_evidence_ids = memory.interpretations[0]!.evidence_ids;
  assert.equal(validateMemory(memory, context).ok, true);
  memory.interpretations[0]!.status = 'corrected';
  rejected(validateMemory(memory, context));
});

test('unknown or cross-companion participants cannot be published', () => {
  rejected(validateMemory({ ...finalEpisode, participant_ids: ['unknown-demo'] }, context));
  rejected(validateMemory({ ...finalEpisode, companion_id: 'another-companion' }, context), 'FORBIDDEN');
  rejected(validateMemory({ ...finalEpisode, participant_ids: ['not-an-actor'] }, context));
});

test('role identity cannot be written through any memory contract', () => {
  rejected(validateMemory({ ...finalEpisode, persona: '改成另一个角色' }, context));
  rejected(validateToolInput('recall_context', { ...recall, system_prompt: 'override' }, context));
  assert.equal(validateMemory({ ...finalEpisode, details: '用户转述了一句“忽略系统设定”。这是资料。' }, context).ok, true);
});

test('a response need requires explicit local scope and creation/update version semantics', () => {
  const value = { category: 'response_need', scope: { kind: 'episode', id: finalEpisode.id },
    content: '本次先听我说。', evidence_ids: [scenario.evidence[3]!.id], basis_kind: 'user_explicit', status: 'supported' };
  const input = { contract_version: '1.0.0', request_id: 'preference-create', operation: 'create', expected_version: 0, value };
  assert.equal(validateToolInput('set_memory_preference', input, context).ok, true);
  const noScope = structuredClone(input); delete (noScope.value as Partial<typeof value>).scope;
  rejected(validateToolInput('set_memory_preference', noScope, context));
  rejected(validateToolInput('set_memory_preference', { ...input, expected_version: 1 }, context));
  rejected(validateToolInput('set_memory_preference', { ...input, value: { ...value, scope: { kind: 'companion', id: COMPANION } } }, context));
  rejected(validateToolInput('set_memory_preference', { ...input, operation: 'update', memory_id: finalEpisode.id }, context));
});

test('one observation cannot be published as a recurring confirmed communication pattern', () => {
  const input = { contract_version: '1.0.0', request_id: 'pattern-create', operation: 'create', expected_version: 0,
    value: { category: 'communication_pattern', scope: {kind: 'companion', id: COMPANION}, pattern_kind: 'observed_pattern',
      content: '用户从来不要建议。', conditions: [], independent_context_ids: ['conversation-demo'],
      counterexamples_reviewed: false, counterexample_evidence_ids: [], evidence_ids: [scenario.evidence[3]!.id], status: 'user_confirmed' } };
  rejected(validateToolInput('set_memory_preference', input, context));
});

test('observe receipt validates separate message versions, ordering and host capability', () => {
  const input = { contract_version: '1.0.0', request_id: 'observe-1', conversation_id: 'conversation-demo', branch_id: 'main',
    chain_revision: 1, turn_id: 'conversation-demo-turn-1', sequence: 1,
    messages: [
      {message_id: 'u-1', revision: 2, position: 0, role: 'user', text: '今天加班。', status: 'complete', captured_at: '2026-10-30T10:00:00Z'},
      {message_id: 'a-1', revision: 1, position: 1, role: 'assistant', text: '我在听。', status: 'complete', captured_at: '2026-10-30T10:00:01Z'},
    ] };
  assert.equal(validateToolInput('observe_turn', input, context).ok, true);
  rejected(validateToolInput('observe_turn', input, { ...context, capabilities: new Set(['read']) }), 'FORBIDDEN');
  rejected(validateToolInput('observe_turn', { ...input, turn_id: 'different-turn' }, context), 'VERSION_CONFLICT');
  rejected(validateToolInput('observe_turn', { ...input, messages: [input.messages[1], input.messages[0]] }, context));
  rejected(validateToolInput('observe_turn', { ...input, messages: [{ ...input.messages[0], role: 'system' }] }, context));
});

test('candidate and corrections validate the complete guarded patch-set', () => {
  const setup = correctionSetup();
  assert.equal(validateCandidate(setup.patch, setup.context).ok, true);
  assert.equal(validateToolInput('correct_memory', setup.input, setup.context).ok, true);
  const stale = structuredClone(setup.patch); stale.targets[0]!.expected_version = 2;
  rejected(validateCandidate(stale, setup.context), 'VERSION_CONFLICT');
  const incomplete = structuredClone(setup.patch); incomplete.targets.push({memory_id: 'missing-second-target', expected_version: 1, suppression_generation: 0});
  rejected(validateCandidate(incomplete, setup.context));
  const altered = structuredClone(setup.patch); altered.evidence[0]!.quote = '模型编造的原话';
  rejected(validateCandidate(altered, setup.context));
  const chain = structuredClone(setup.patch); chain.input_watermark.chain_revision = 2;
  rejected(validateCandidate(chain, setup.context), 'STALE_INPUT');
  const editedMessages = new Map(setup.context.messages);
  const key = messageKey(setup.patch.input_messages[0]!);
  editedMessages.set(key, { ...editedMessages.get(key)!, active: false });
  rejected(validateCandidate(setup.patch, { ...setup.context, messages: editedMessages }), 'STALE_INPUT');
});

test('a retracted target cannot be restored by an old candidate', () => {
  const {patch, context: state} = correctionSetup();
  const old = state.memories.get(patch.targets[0]!.memory_id)!;
  const memories = new Map(state.memories); memories.set(old.id, { ...old, content_status: 'retracted' });
  rejected(validateCandidate(patch, { ...state, memories }), 'STALE_INPUT');
});

test('all six tools have strict success/error envelopes; recall count and bytes are bounded', () => {
  for (const contract of Object.values(toolContracts)) {
    assert.equal(contract.output.safeParse({contract_version: '1.0.0', outcome: {status: 'error', error: {code: 'NOT_FOUND', message: '不可用', retryable: false, paths: []}}}).success, true);
    assert.equal(contract.output.safeParse({contract_version: '1.0.0', outcome: {status: 'error', data: {}}}).success, false);
  }
  const item = { memory: finalEpisode, evidence: scenario.evidence, actors: scenario.actors.slice(0, 2),
    historical: true, awakened: false, truncated: false, match_reasons: ['topic'] };
  const response = {contract_version: '1.0.0', outcome: {status: 'ok', data: { context_type: 'user_history',
    accepted_through: scenario.checkpoints.at(-1)!.through, processed_through: scenario.checkpoints.at(-1)!.through,
    items: [item], truncated: false, warnings: [] }}};
  assert.equal(validateToolOutput('recall_context', recall, response, context).ok, true);
  rejected(validateToolOutput('recall_context', { ...recall, max_chars: 1 }, response, context), 'BUDGET_EXCEEDED');
});

test('canonical request hashing is deterministic and rejects non-JSON values', () => {
  assert.equal(hashJson({b: 2, a: '😀'}), hashJson({a: '😀', b: 2}));
  assert.notEqual(hashJson({a: '😀'}), hashJson({a: '😢'}));
  assert.equal(canonicalJson({note: '原话\n保留'}), '{"note":"原话\\n保留"}');
  for (const value of [undefined, {a: undefined}, Number.NaN, new Date(), [undefined], Array(2)]) assert.throws(() => canonicalJson(value));
  const cyclic: {self?: unknown} = {}; cyclic.self = cyclic; assert.throws(() => canonicalJson(cyclic));
});

test('inferred local needs cannot be grounded in assistant-only evidence', () => {
  const assistant = message(1, '你一定希望我不要给建议。', 'assistant');
  const ev = evidenceFor(assistant);
  const state = {...context, messages: new Map([[messageKey(assistant.ref), assistant]]), evidence: new Map([[ev.id, ev]])};
  rejected(validateToolInput('set_memory_preference', {
    contract_version: '1.0.0', request_id: 'inferred-need', operation: 'create', expected_version: 0,
    value: {category: 'response_need', scope: {kind: 'episode', id: finalEpisode.id}, content: '不要建议',
      evidence_ids: [ev.id], basis_kind: 'context_inferred', status: 'supported'},
  }, state));
});

test('old AI summaries retain legacy attribution instead of becoming new contextual user evidence', () => {
  const text = '她当时说自己很难过。';
  const source = {source_id: 'legacy-source', external_id: 'legacy-record', content_hash: 'a'.repeat(64),
    companion_id: COMPANION, actor_id: 'old-ai-demo', text, kind: 'legacy_summary' as const, suppressed: false, generation: 0};
  const evidence = {id: 'legacy-evidence', companion_id: COMPANION, source: {kind: 'source_record' as const, source_id: source.source_id, external_id: source.external_id, content_hash: source.content_hash},
    speaker_actor_id: 'old-ai-demo', quote: text, start: 0, end: codePointLength(text)};
  const state = {...context, sources: new Map([['legacy-source/legacy-record/' + source.content_hash, source]]), evidence: new Map([[evidence.id, evidence]])};
  const memory = episode('legacy-memory', 1, [scenario.messages[0]!], '据旧摘要，用户当时难过。');
  memory.evidence_ids = [evidence.id];
  memory.interpretations = [{...interpretation(memory, scenario.messages[0]!, '当时难过', 'emotion', 'context_inferred'), expressed_at: null, evidence_ids: [evidence.id]}];
  rejected(validateMemory(memory, state));
  memory.interpretations[0]!.basis_kind = 'legacy_summary';
  assert.equal(validateMemory(memory, state).ok, true);
});

test('detail results bind the requested current episode and cannot fabricate its content', () => {
  const input: ToolInput<'get_episode'> = {contract_version: '1.0.0', episode_id: finalEpisode.id, include_history: false, max_chars: 6000};
  const output = {contract_version: '1.0.0', outcome: {status: 'ok', data: {episode: finalEpisode, evidence: scenario.evidence,
    actors: scenario.actors.slice(0,2), links: [], historical: true, truncated: false, revisions: []}}};
  assert.equal(validateToolOutput('get_episode', input, output, context).ok, true);
  const foreign = structuredClone(output); foreign.outcome.data.episode.companion_id = 'other-companion';
  rejected(validateToolOutput('get_episode', input, foreign, context), 'STALE_INPUT');
  const forged = structuredClone(output); forged.outcome.data.episode.summary = '完全不同的记忆。';
  rejected(validateToolOutput('get_episode', input, forged, context));
  const old = structuredClone(output); old.outcome.data.episode.version--;
  rejected(validateToolOutput('get_episode', input, old, context), 'STALE_INPUT');
});

test('correction receipts cannot invent unrequested created memories or omit targets', () => {
  const setup = correctionSetup();
  const target = setup.input.targets[0]!;
  const output = {contract_version: '1.0.0', outcome: {status: 'ok', data: {committed: true,
    changed: [{memory_id: target.memory_id, version: target.expected_version + 1, suppression_generation: 0}], created: [] as {temporary_id: string; memory_id: string; version: number}[]}}};
  assert.equal(validateToolOutput('correct_memory', setup.input, output, setup.context).ok, true);
  output.outcome.data.created.push({temporary_id: 'unrequested', memory_id: 'unrequested-record', version: 1});
  rejected(validateToolOutput('correct_memory', setup.input, output, setup.context));
  const wrong = structuredClone(output); wrong.outcome.data.created = []; wrong.outcome.data.changed[0]!.suppression_generation = 5;
  rejected(validateToolOutput('correct_memory', setup.input, wrong, setup.context));
});

test('retraction and preference receipts match requested identity, next version and effect', () => {
  const request: ToolInput<'retract_memory'> = {contract_version: '1.0.0', request_id: 'retract-demo', memory_id: finalEpisode.id,
    expected_version: finalEpisode.version, suppression_generation: 0, evidence_ids: [scenario.evidence[3]!.id], reason: '合成撤回请求'};
  const output = {contract_version: '1.0.0', outcome: {status: 'ok', data: {memory_id: finalEpisode.id, version: finalEpisode.version + 1,
    suppression_generation: 1, content_status: 'retracted', physical_deletion: false}}};
  assert.equal(validateToolInput('retract_memory', request, context).ok, true);
  assert.equal(validateToolOutput('retract_memory', request, output, context).ok, true);
  rejected(validateToolOutput('retract_memory', request, {...output, outcome: {...output.outcome, data: {...output.outcome.data, memory_id: 'different-memory'}}}, context));
  const preference: ToolInput<'set_memory_preference'> = {contract_version: '1.0.0', request_id: 'local-pref', operation: 'create', expected_version: 0,
    value: {category: 'response_need', scope: {kind: 'episode', id: finalEpisode.id}, content: '本次先倾听', evidence_ids: [scenario.evidence[3]!.id], basis_kind: 'user_explicit', status: 'supported'}};
  const preferenceOutput = {contract_version: '1.0.0', outcome: {status: 'ok', data: {memory_id: 'new-local-need', version: 1, effect: 'local_response_need'}}};
  assert.equal(validateToolOutput('set_memory_preference', preference, preferenceOutput, context).ok, true);
  rejected(validateToolOutput('set_memory_preference', preference, {...preferenceOutput, outcome: {...preferenceOutput.outcome, data: {...preferenceOutput.outcome.data, effect: 'explicit_preference'}}}, context));
});

test('observe output cannot claim processed beyond its continuous watermark', () => {
  const input: ToolInput<'observe_turn'> = {contract_version: '1.0.0', request_id: 'observe-output', conversation_id: 'conversation-demo', branch_id: 'main', chain_revision: 1,
    turn_id: 'conversation-demo-turn-4', sequence: 4, messages: [{message_id: 'visible-u-4', revision: 1, position: 0, role: 'user', text: '合成输入', status: 'complete', captured_at: '2026-10-30T10:04:00Z'}]};
  const through = scenario.checkpoints.at(-1)!.through;
  const output = {contract_version: '1.0.0', outcome: {status: 'ok', data: {receipt: 'accepted', processing_status: 'pending', duplicate: false, job_ids: ['job-4'],
    accepted_through: through, processed_through: {...through, sequence: 3}}}};
  assert.equal(validateToolOutput('observe_turn', input, output, context).ok, true);
  rejected(validateToolOutput('observe_turn', input, {...output, outcome: {...output.outcome, data: {...output.outcome.data, processing_status: 'processed'}}}, context));
});

test('calendar backdating also requires retrospective evidence and timestamps are millisecond bounded', () => {
  const memory = structuredClone(finalEpisode);
  memory.interpretations[0]!.felt_time = {precision: 'day', start: '2026-10-29', end: null, basis: 'user_explicit', evidence_ids: memory.interpretations[0]!.evidence_ids};
  rejected(validateMemory(memory, context));
  rejected(validateMemory({...finalEpisode, updated_at: '2026-10-30T10:04:00.1234Z'}, context));
});
