import * as z from 'zod';
import {
  ContractVersionSchema, GenerationSchema, IdSchema, IdsSchema, InstantSchema,
  SummarySchema, TimeRangeSchema, VersionSchema, WatermarkSchema, MessageRefSchema,
} from '../domain/common.ts';
import {
  ActorSchema, EpisodeSchema, EvidenceSchema, LinkSchema, MemorySchema,
  MutationSchema, PreferenceValueSchema, VersionTargetSchema, VisibleMessageSchema,
} from '../domain/memory.ts';

const request = { contract_version: ContractVersionSchema, request_id: IdSchema };
const context = { conversation_id: IdSchema, branch_id: IdSchema, chain_revision: VersionSchema };
export const RecallInputSchema = z.strictObject({
  contract_version: ContractVersionSchema, ...context,
  query: z.string().min(1).max(8000),
  recent_context: z.array(z.strictObject({ ref: MessageRefSchema, role: z.enum(['user', 'assistant']), text: z.string().max(8000) })).max(6),
  time_range: TimeRangeSchema.nullable(),
  max_items: z.int().min(1).max(12), max_chars: z.int().min(1).max(6000),
});
export const ObserveInputSchema = z.strictObject({
  ...request, ...context, turn_id: IdSchema, sequence: VersionSchema,
  messages: z.array(VisibleMessageSchema).min(1).max(16),
});
export const GetEpisodeInputSchema = z.strictObject({
  contract_version: ContractVersionSchema, episode_id: IdSchema,
  include_history: z.boolean(), max_chars: z.int().min(1).max(6000),
});
export const CorrectInputSchema = z.strictObject({
  ...request, correction_kind: z.enum(['reinterpret', 'fact', 'time', 'split', 'merge']),
  targets: z.array(VersionTargetSchema).min(1).max(32),
  mutations: z.array(MutationSchema).min(1).max(32), links: z.array(LinkSchema).max(64),
  evidence_ids: z.array(IdSchema).min(1).max(128), reason: SummarySchema,
});
export const PreferenceInputSchema = z.discriminatedUnion('operation', [
  z.strictObject({ ...request, operation: z.literal('create'), expected_version: z.literal(0), value: PreferenceValueSchema }),
  z.strictObject({ ...request, operation: z.literal('update'), memory_id: IdSchema,
    expected_version: VersionSchema, suppression_generation: GenerationSchema, value: PreferenceValueSchema }),
]);
export const RetractInputSchema = z.strictObject({
  ...request, memory_id: IdSchema, expected_version: VersionSchema,
  suppression_generation: GenerationSchema, reason: SummarySchema,
  evidence_ids: z.array(IdSchema).min(1).max(128),
});

export const ErrorCodeSchema = z.enum([
  'VALIDATION_ERROR', 'FORBIDDEN', 'NOT_FOUND', 'VERSION_CONFLICT', 'IDEMPOTENCY_CONFLICT',
  'STALE_INPUT', 'ARCHIVE_UNAVAILABLE', 'MODEL_UNAVAILABLE', 'BUDGET_EXCEEDED',
]);
export const BusinessErrorSchema = z.strictObject({
  code: ErrorCodeSchema, message: z.string().min(1).max(512), retryable: z.boolean(),
  paths: z.array(z.string().max(256)).max(32),
});
const result = <T extends z.ZodType>(data: T) => z.strictObject({
  contract_version: ContractVersionSchema,
  outcome: z.discriminatedUnion('status', [
    z.strictObject({ status: z.literal('ok'), data }),
    z.strictObject({ status: z.literal('error'), error: BusinessErrorSchema }),
  ]),
});
export const RecallItemSchema = z.strictObject({
  memory: MemorySchema, evidence: z.array(EvidenceSchema).min(1).max(128),
  actors: z.array(ActorSchema).min(1).max(32),
  historical: z.literal(true), awakened: z.boolean(), truncated: z.boolean(),
  match_reasons: z.array(z.enum(['topic', 'person', 'time', 'related_event', 'communication_preference'])).min(1).max(5),
});
export const RecallDataSchema = z.strictObject({
  context_type: z.literal('user_history'),
  accepted_through: WatermarkSchema.nullable(), processed_through: WatermarkSchema.nullable(),
  items: z.array(RecallItemSchema).max(12), truncated: z.boolean(),
  warnings: z.array(z.enum(['archive_unavailable', 'processing_pending', 'ambiguous_match', 'budget_truncated'])).max(4),
});
export const ObserveDataSchema = z.strictObject({
  receipt: z.literal('accepted'), processing_status: z.enum(['pending', 'processed', 'failed']),
  duplicate: z.boolean(), job_ids: IdsSchema,
  accepted_through: WatermarkSchema, processed_through: WatermarkSchema,
});
export type ObserveData = z.infer<typeof ObserveDataSchema>;
export const GetEpisodeDataSchema = z.strictObject({
  episode: EpisodeSchema, evidence: z.array(EvidenceSchema).min(1).max(128),
  actors: z.array(ActorSchema).min(1).max(32), links: z.array(LinkSchema).max(64),
  historical: z.literal(true), truncated: z.boolean(),
  revisions: z.array(z.strictObject({ version: VersionSchema, reason: SummarySchema, created_at: InstantSchema })).max(128),
});
export const ChangedVersionSchema = z.strictObject({ memory_id: IdSchema, version: VersionSchema, suppression_generation: GenerationSchema });
export const CorrectionDataSchema = z.strictObject({
  committed: z.literal(true), changed: z.array(ChangedVersionSchema).min(1).max(32),
  created: z.array(z.strictObject({ temporary_id: IdSchema, memory_id: IdSchema, version: z.literal(1) })).max(32),
});
export const PreferenceDataSchema = z.strictObject({
  memory_id: IdSchema, version: VersionSchema,
  effect: z.enum(['local_response_need', 'explicit_preference', 'observed_pattern']),
});
export const RetractDataSchema = z.strictObject({
  memory_id: IdSchema, version: VersionSchema, suppression_generation: VersionSchema,
  content_status: z.literal('retracted'), physical_deletion: z.literal(false),
});

export const toolContracts = {
  recall_context: { input: RecallInputSchema, output: result(RecallDataSchema), capability: 'read', audience: 'model', readOnlyHint: true },
  observe_turn: { input: ObserveInputSchema, output: result(ObserveDataSchema), capability: 'observe', audience: 'host', readOnlyHint: false },
  get_episode: { input: GetEpisodeInputSchema, output: result(GetEpisodeDataSchema), capability: 'read', audience: 'model', readOnlyHint: true },
  correct_memory: { input: CorrectInputSchema, output: result(CorrectionDataSchema), capability: 'user_edit', audience: 'host', readOnlyHint: false },
  set_memory_preference: { input: PreferenceInputSchema, output: result(PreferenceDataSchema), capability: 'user_edit', audience: 'host', readOnlyHint: false },
  retract_memory: { input: RetractInputSchema, output: result(RetractDataSchema), capability: 'user_edit', audience: 'host', readOnlyHint: false },
} as const;

export type ToolName = keyof typeof toolContracts;
export type ToolInput<N extends ToolName> = z.infer<(typeof toolContracts)[N]['input']>;
export type ToolOutput<N extends ToolName> = z.infer<(typeof toolContracts)[N]['output']>;
