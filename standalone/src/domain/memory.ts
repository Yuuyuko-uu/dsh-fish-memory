import * as z from 'zod';
import {
  BasisKindSchema, CompanionScopeSchema, ContentStatusSchema, ContractVersionSchema,
  GenerationSchema, HashSchema, IdSchema, IdsSchema, InstantSchema, LocalScopeSchema,
  MessageRefSchema, PublicationStatusSchema, ScopeSchema, StorageTierSchema,
  SummarySchema, TextSchema, TimeRangeSchema, TopicStatusSchema,
  UnderstandingStatusSchema, VersionSchema, WatermarkSchema,
} from './common.ts';

export const ActorSchema = z.strictObject({
  id: IdSchema, companion_id: IdSchema,
  kind: z.enum(['user', 'character', 'historical_ai', 'third_party', 'unknown']),
  display_name: z.string().min(1).max(128),
});

export const VisibleMessageSchema = z.strictObject({
  message_id: IdSchema, revision: VersionSchema, position: GenerationSchema,
  role: z.enum(['user', 'assistant']), text: z.string().max(32000),
  status: z.enum(['complete', 'interrupted']), captured_at: InstantSchema,
});

export const EvidenceSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('message'), ref: MessageRefSchema }),
  z.strictObject({ kind: z.literal('source_record'), source_id: IdSchema, external_id: IdSchema, content_hash: HashSchema }),
]);
export const EvidenceSchema = z.strictObject({
  id: IdSchema, companion_id: IdSchema, source: EvidenceSourceSchema,
  speaker_actor_id: IdSchema, quote: z.string().min(1).max(8000),
  start: GenerationSchema, end: VersionSchema,
});

export const InterpretationSchema = z.strictObject({
  id: IdSchema, kind: z.enum(['emotion', 'intent', 'response_need']),
  actor_id: IdSchema, label: z.string().min(1).max(256),
  basis_kind: BasisKindSchema, status: UnderstandingStatusSchema,
  scope: ScopeSchema, felt_time: TimeRangeSchema,
  expressed_at: MessageRefSchema.nullable(),
  evidence_ids: z.array(IdSchema).min(1).max(128),
  temporal_update: z.enum(['as_expressed', 'retrospective']),
  retrospective_evidence_ids: IdsSchema,
  superseded_by: IdSchema.nullable(),
});

const recordBase = {
  contract_version: ContractVersionSchema, id: IdSchema, companion_id: IdSchema,
  version: VersionSchema, suppression_generation: GenerationSchema,
  content_status: ContentStatusSchema, publication_status: PublicationStatusSchema,
  created_at: InstantSchema, updated_at: InstantSchema,
  evidence_ids: z.array(IdSchema).min(1).max(128),
};

export const EpisodeSchema = z.strictObject({
  ...recordBase, kind: z.literal('episode'), summary: SummarySchema,
  details: z.string().max(12000), participant_ids: z.array(IdSchema).min(1).max(32),
  occurred: TimeRangeSchema, topic_status: TopicStatusSchema, storage_tier: StorageTierSchema,
  last_effective_mention_at: InstantSchema.nullable(),
  interpretations: z.array(InterpretationSchema).max(64),
});

export const CommunicationPatternSchema = z.strictObject({
  ...recordBase, kind: z.literal('communication_pattern'),
  pattern_kind: z.enum(['explicit_preference', 'observed_pattern']),
  scope: CompanionScopeSchema, content: SummarySchema,
  conditions: z.array(z.string().min(1).max(512)).max(16),
  counterexample_evidence_ids: IdsSchema, independent_context_ids: IdsSchema,
  counterexamples_reviewed: z.boolean(), status: UnderstandingStatusSchema,
});
export const ResponseNeedRecordSchema = z.strictObject({
  ...recordBase, kind: z.literal('response_need'), scope: LocalScopeSchema,
  content: SummarySchema, basis_kind: z.enum(['user_explicit', 'context_inferred']),
  status: z.enum(['tentative', 'supported', 'user_confirmed']),
});
export const MemorySchema = z.discriminatedUnion('kind', [EpisodeSchema, CommunicationPatternSchema, ResponseNeedRecordSchema]);

export const ResponseNeedSchema = z.strictObject({
  category: z.literal('response_need'), scope: LocalScopeSchema,
  content: SummarySchema, evidence_ids: z.array(IdSchema).min(1).max(128),
  basis_kind: z.enum(['user_explicit', 'context_inferred']),
  status: z.enum(['tentative', 'supported', 'user_confirmed']),
});
export const PatternValueSchema = z.strictObject({
  category: z.literal('communication_pattern'), scope: CompanionScopeSchema,
  content: SummarySchema, pattern_kind: z.enum(['explicit_preference', 'observed_pattern']),
  evidence_ids: z.array(IdSchema).min(1).max(128),
  conditions: z.array(z.string().min(1).max(512)).max(16),
  independent_context_ids: IdsSchema, counterexample_evidence_ids: IdsSchema,
  counterexamples_reviewed: z.boolean(),
  status: z.enum(['tentative', 'supported', 'user_confirmed']),
});
export const PreferenceValueSchema = z.discriminatedUnion('category', [ResponseNeedSchema, PatternValueSchema]);

export const VersionTargetSchema = z.strictObject({
  memory_id: IdSchema, expected_version: VersionSchema, suppression_generation: GenerationSchema,
});
export const SourceSuppressionSchema = z.strictObject({
  source_id: IdSchema, external_id: IdSchema, generation: GenerationSchema,
});
export const LinkSchema = z.strictObject({
  from: IdSchema, to: IdSchema,
  relation: z.enum(['followup', 'supplement', 'correction', 'contradiction', 'alias']),
});
export const MutationSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('create'), temporary_id: IdSchema, record: MemorySchema }),
  z.strictObject({ operation: z.literal('revise'), memory_id: IdSchema, record: MemorySchema }),
]);
export const CandidatePatchSchema = z.strictObject({
  contract_version: ContractVersionSchema, job_id: IdSchema, request_id: IdSchema,
  companion_id: IdSchema, input_watermark: WatermarkSchema,
  input_messages: z.array(MessageRefSchema).min(1).max(128),
  targets: z.array(VersionTargetSchema).max(32),
  source_guards: z.array(SourceSuppressionSchema).max(128),
  mutations: z.array(MutationSchema).min(1).max(32),
  evidence: z.array(EvidenceSchema).min(1).max(128),
  links: z.array(LinkSchema).max(64), reason: TextSchema,
});

export type Actor = z.infer<typeof ActorSchema>;
export type VisibleMessage = z.infer<typeof VisibleMessageSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
export type Interpretation = z.infer<typeof InterpretationSchema>;
export type Episode = z.infer<typeof EpisodeSchema>;
export type CommunicationPattern = z.infer<typeof CommunicationPatternSchema>;
export type ResponseNeedRecord = z.infer<typeof ResponseNeedRecordSchema>;
export type Memory = z.infer<typeof MemorySchema>;
export type PreferenceValue = z.infer<typeof PreferenceValueSchema>;
export type CandidatePatch = z.infer<typeof CandidatePatchSchema>;
