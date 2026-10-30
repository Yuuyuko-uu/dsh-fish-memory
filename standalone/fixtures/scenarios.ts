import * as z from 'zod';
import { ContractVersionSchema, WatermarkSchema, type TimeRange } from '../src/domain/common.ts';
import {
  ActorSchema, EvidenceSchema, MemorySchema, type Actor, type Episode,
  type Evidence, type Interpretation, type Memory,
} from '../src/domain/memory.ts';
import { branchKey, messageKey, type MessageSnapshot, type ValidationContext } from '../src/contracts/validation.ts';

export const COMPANION = 'companion-demo';
export const UNKNOWN_TIME: TimeRange = { precision: 'unknown', start: null, end: null, basis: 'unknown', evidence_ids: [] };
export const actors: Actor[] = [
  { id: 'user-demo', companion_id: COMPANION, kind: 'user', display_name: '小禾（合成用户）' },
  { id: 'character-demo', companion_id: COMPANION, kind: 'character', display_name: '澄（合成角色）' },
  { id: 'friend-demo', companion_id: COMPANION, kind: 'third_party', display_name: '林同事（合成人物）' },
  { id: 'old-ai-demo', companion_id: COMPANION, kind: 'historical_ai', display_name: '旧助手（合成历史 AI）' },
  { id: 'unknown-demo', companion_id: COMPANION, kind: 'unknown', display_name: '无法确定的指代' },
];

export function message(sequence: number, text: string, role: 'user' | 'assistant' = 'user', conversation = 'conversation-demo'): MessageSnapshot {
  return {
    ref: { conversation_id: conversation, branch_id: 'main', turn_id: `${conversation}-turn-${sequence}`,
      sequence, message_id: `${conversation}-${role}-${sequence}`, revision: 1 },
    companion_id: COMPANION, actor_id: role === 'user' ? 'user-demo' : 'character-demo',
    role, text, captured_at: `2026-10-30T10:${String(sequence).padStart(2, '0')}:00+08:00`,
    channel: 'visible', active: true,
  };
}
export function evidenceFor(source: MessageSnapshot, quote = source.text): Evidence {
  const utf16Start = source.text.indexOf(quote);
  if (utf16Start < 0) throw new Error('Fixture quote not found');
  const start = [...source.text.slice(0, utf16Start)].length;
  return {
    id: `evidence-${source.ref.message_id}`, companion_id: COMPANION,
    source: { kind: 'message', ref: source.ref }, speaker_actor_id: source.actor_id,
    quote, start, end: start + [...quote].length,
  };
}
export function episode(id: string, version: number, messages: MessageSnapshot[], summary: string): Episode {
  return {
    contract_version: '1.0.0', id, companion_id: COMPANION, kind: 'episode', version,
    suppression_generation: 0, content_status: 'active', publication_status: 'published',
    created_at: messages[0]!.captured_at, updated_at: messages.at(-1)!.captured_at,
    evidence_ids: messages.map(item => evidenceFor(item).id),
    summary, details: '', participant_ids: ['user-demo'], occurred: structuredClone(UNKNOWN_TIME),
    topic_status: 'ongoing', storage_tier: 'hot', last_effective_mention_at: messages.at(-1)!.captured_at,
    interpretations: [],
  };
}
export function interpretation(memory: Episode, source: MessageSnapshot, label: string,
  kind: Interpretation['kind'] = 'emotion', basis: Interpretation['basis_kind'] = 'user_explicit'): Interpretation {
  return {
    id: `${memory.id}-${kind}-v${memory.version}`, kind, actor_id: 'user-demo', label,
    basis_kind: basis, status: basis === 'user_explicit' ? 'supported' : 'tentative',
    scope: { kind: 'episode', id: memory.id }, felt_time: structuredClone(UNKNOWN_TIME),
    expressed_at: source.ref, evidence_ids: [evidenceFor(source).id],
    temporal_update: 'as_expressed', retrospective_evidence_ids: [], superseded_by: null,
  };
}

const SnapshotMessageSchema = z.strictObject({
  ref: EvidenceSchema.shape.source.options[0].shape.ref,
  companion_id: z.string(), actor_id: z.string(), role: z.enum(['user', 'assistant']),
  text: z.string(), captured_at: z.iso.datetime({ offset: true }),
  channel: z.enum(['visible', 'injected']), active: z.boolean(),
});
export const ScenarioSchema = z.strictObject({
  id: z.string(), description: z.string(), acceptance_ids: z.array(z.string()).min(1),
  actors: z.array(ActorSchema), messages: z.array(SnapshotMessageSchema).min(1),
  evidence: z.array(EvidenceSchema).min(1),
  checkpoints: z.array(z.strictObject({ through: WatermarkSchema, expected_records: z.array(MemorySchema).min(1) })).min(1),
});
export const FixtureSetSchema = z.strictObject({
  contract_version: ContractVersionSchema, synthetic: z.literal(true),
  purpose: z.literal('Human-labelled contract oracles; not a trained or implemented extractor.'),
  scenarios: z.array(ScenarioSchema).min(8),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

function scenario(id: string, description: string, acceptance: string[], messages: MessageSnapshot[], snapshots: Memory[][]): Scenario {
  return {
    id, description, acceptance_ids: acceptance, actors, messages, evidence: messages.map(item => evidenceFor(item)),
    checkpoints: snapshots.map((records, index) => ({
      through: { conversation_id: messages[0]!.ref.conversation_id, branch_id: 'main', chain_revision: 1,
        sequence: snapshots.length === messages.length ? index + 1 : Math.max(...messages.map(m => m.ref.sequence)) },
      expected_records: records,
    })),
  };
}

const overtime = [
  message(1, '今天又加班了。'), message(2, '方案已经改第三遍了。'),
  message(3, '怎么做都没人认可，我觉得很委屈。'), message(4, '我只是想说说，先不用给我建议。'),
];
const overtimeSnapshots = overtime.map((_, index) => {
  const value = episode('episode-overtime', index + 1, overtime.slice(0, index + 1), [
    '用户提到今天加班，暂未明确情绪。', '用户加班修改方案，已反复修改三次。',
    '反复修改方案让用户感到努力未被认可，并明确表达委屈。',
    '用户因反复修改方案感到委屈，本次明确希望先被倾听。',
  ][index]!);
  if (index >= 2) value.interpretations.push(interpretation(value, overtime[2]!, '委屈'));
  if (index >= 3) value.interpretations.push(interpretation(value, overtime[3]!, '先倾听，暂不提供建议', 'response_need'));
  return [value];
});

const changing = [message(1, '刚才还挺平静的。'), message(2, '后来看到那封邮件，我才开始难过。')];
const changingFirst = episode('episode-changing', 1, changing.slice(0, 1), '用户明确说刚才较平静。');
changingFirst.interpretations = [interpretation(changingFirst, changing[0]!, '平静')];
const changingLast = episode('episode-changing', 2, changing, '用户先平静，看到邮件后开始难过。');
changingLast.interpretations = [
  { ...interpretation(changingLast, changing[0]!, '平静'), id: 'changing-calm-v2' },
  { ...interpretation(changingLast, changing[1]!, '难过'), id: 'changing-sad-v2' },
];

const correcting = [message(1, '今天一句话也不想说。'), message(2, '刚才不是难过，我只是累了。')];
const correctionFirst = episode('episode-corrected', 1, correcting.slice(0, 1), '用户不想说话，可能难过，尚未确认。');
correctionFirst.interpretations = [interpretation(correctionFirst, correcting[0]!, '可能难过', 'emotion', 'context_inferred')];
const correctionLast = episode('episode-corrected', 2, correcting, '用户纠正了之前的理解，明确表示自己只是疲惫。');
const fatigue = interpretation(correctionLast, correcting[1]!, '疲惫');
correctionLast.interpretations = [
  { ...interpretation(correctionLast, correcting[0]!, '可能难过', 'emotion', 'context_inferred'),
    id: 'corrected-old-reading-v2', status: 'corrected', superseded_by: fatigue.id }, fatigue,
];

const past = [message(1, '2025 年那次面试我很害怕，不过现在已经不怕了。')];
const pastEpisode = episode('episode-past-emotion', 1, past, '用户回忆 2025 年面试时害怕，并明确说现在已不再害怕。');
pastEpisode.occurred = { precision: 'year', start: '2025', end: null, basis: 'user_explicit', evidence_ids: [evidenceFor(past[0]!).id] };
const pastEmotion = interpretation(pastEpisode, past[0]!, '当时害怕');
pastEmotion.felt_time = structuredClone(pastEpisode.occurred);
pastEmotion.temporal_update = 'retrospective'; pastEmotion.retrospective_evidence_ids = pastEmotion.evidence_ids;
pastEpisode.interpretations = [pastEmotion,
  { ...interpretation(pastEpisode, past[0]!, '现在已不再害怕'), id: 'past-now-v1' }];

const quotes = [message(1, '林同事说“我很难过”，我现在只是转述这句话。')];
const quoteEpisode = episode('episode-quoted-friend', 1, quotes, '用户转述林同事的难过，没有表达自己难过。');
quoteEpisode.participant_ids.push('friend-demo');
quoteEpisode.interpretations = [{ ...interpretation(quoteEpisode, quotes[0]!, '据用户转述，当时难过', 'emotion', 'context_inferred'), actor_id: 'friend-demo' }];

const unknown = [message(1, '记不清哪一天了，那个人后来陪我走了一段路。')];
const unknownEpisode = episode('episode-unknown-person', 1, unknown, '用户回忆有人陪自己走路，时间和对方身份不清楚。');
unknownEpisode.participant_ids.push('unknown-demo'); unknownEpisode.publication_status = 'staged';

const style = [message(1, '没事，我现在心情挺好的。', 'user', 'style-one'), message(1, '今天很难受，但先不聊了，没事。', 'user', 'style-two')];
const styleEpisode = episode('episode-style-context', 1, style, '“没事”在不同语境中含义不同，不能形成绝对规则。');

const unicode = [message(1, '今天去了海边😀，我很开心。')];
const unicodeEpisode = episode('episode-unicode', 1, unicode, '用户去海边后明确表达开心，具体事件日期未确定。');
unicodeEpisode.interpretations = [interpretation(unicodeEpisode, unicode[0]!, '开心')];

const explicit = [message(1, '以后我难受的时候，希望你先听完，再给建议。')];
const explicitPattern: Memory = {
  contract_version: '1.0.0', id: 'pattern-listen-first', companion_id: COMPANION,
  kind: 'communication_pattern', version: 1, suppression_generation: 0,
  content_status: 'active', publication_status: 'published',
  created_at: explicit[0]!.captured_at, updated_at: explicit[0]!.captured_at,
  evidence_ids: [evidenceFor(explicit[0]!).id], pattern_kind: 'explicit_preference',
  scope: { kind: 'companion', id: COMPANION }, content: '用户难受时希望先听完，再给建议。',
  conditions: ['用户表达难受时'], counterexample_evidence_ids: [], independent_context_ids: ['conversation-demo'],
  counterexamples_reviewed: false, status: 'user_confirmed',
};

export const fixtureSet = FixtureSetSchema.parse({
  contract_version: '1.0.0', synthetic: true,
  purpose: 'Human-labelled contract oracles; not a trained or implemented extractor.',
  scenarios: [
    scenario('gradual-venting', '平常开场后逐渐表达委屈和倾诉需要。', ['ACC-02','ACC-06','ACC-10'], overtime, overtimeSnapshots),
    scenario('actual-emotion-change', '情绪真实改变，不能把后来的难过倒灌到平静阶段。', ['ACC-03'], changing, [[changingFirst], [changingLast]]),
    scenario('explicit-correction', '用户纠正先前推断，旧理解保留历史但退出默认理解。', ['ACC-04'], correcting, [[correctionFirst], [correctionLast]]),
    scenario('historical-emotion', '历史害怕与现在不害怕必须区分。', ['ACC-03','ACC-08'], past, [[pastEpisode]]),
    scenario('quoted-third-party', '引文中的我指第三方，不是当前用户。', ['ACC-12','ACC-33'], quotes, [[quoteEpisode]]),
    scenario('unknown-time-and-person', '不明日期和人物保留未知，不用入库时间补齐。', ['ACC-14','ACC-33'], unknown, [[unknownEpisode]]),
    scenario('conditional-expression', '多个独立语境提供相反例，不把口头禅固定成情绪判断。', ['ACC-07'], style, [[styleEpisode]]),
    scenario('unicode-evidence', 'Unicode 码点定位证据，表情不导致截断或错位。', ['ACC-08'], unicode, [[unicodeEpisode]]),
    scenario('explicit-long-term-preference', '用户明确说明长期适用的回应偏好。', ['ACC-06','ACC-27'], explicit, [[explicitPattern]]),
  ],
});

export function contextFor(scenario: Scenario, checkpointIndex = scenario.checkpoints.length - 1): ValidationContext {
  const checkpoint = scenario.checkpoints[checkpointIndex]!;
  const messages = scenario.messages.filter(item => item.ref.conversation_id !== checkpoint.through.conversation_id || item.ref.sequence <= checkpoint.through.sequence);
  const branches = new Map<string, {conversation_id: string; branch_id: string; chain_revision: number; turns: Map<number, string>}>();
  for (const item of messages) {
    const key = branchKey(item.ref.conversation_id, item.ref.branch_id);
    if (!branches.has(key)) branches.set(key, { conversation_id: item.ref.conversation_id, branch_id: item.ref.branch_id,
      chain_revision: 1, turns: new Map() });
    branches.get(key)!.turns.set(item.ref.sequence, item.ref.turn_id);
  }
  const keys = new Set(messages.map(item => messageKey(item.ref)));
  const evidence = scenario.evidence.filter(item => item.source.kind === 'message' && keys.has(messageKey(item.source.ref)));
  return {
    companion_id: COMPANION, timezone: 'Asia/Shanghai', actors: new Map(scenario.actors.map(actor => [actor.id, actor])),
    messages: new Map(messages.map(item => [messageKey(item.ref), item])), sources: new Map(),
    memories: new Map(checkpoint.expected_records.map(memory => [memory.id, memory])),
    evidence: new Map(evidence.map(item => [item.id, item])), branches,
    conversations: new Set(messages.map(item => item.ref.conversation_id)),
    capabilities: new Set(['read', 'observe', 'user_edit', 'candidate']),
  };
}

export const legacyFixture = {
  synthetic: true,
  source_id: 'legacy-dsh-demo',
  identity_mapping: { user: 'user-demo', original_ai: 'old-ai-demo', uncertain_pronouns: ['她'] },
  raw_record: {
    id: 'legacy-001', text: '我答应在她面试后听她说说。', textBefore: '我答应听她说说。',
    at: null, createdAt: '2026-10-01T00:00:00Z', category: 'stable_profile',
    custom_extension: { keep_exactly: true, note: '未知字段保留' },
    已被取代: { 被谁: 'legacy-002', 为什么: '历史来源标记', 作废于: '2026-10-02T00:00:00Z' },
  },
  expected: { publication_status: 'staged', narrator_actor_id: 'old-ai-demo', copy_persona: false,
    original_category_is_authoritative: false, raw_snapshot_required: true, reimport_cannot_restore: true },
};
