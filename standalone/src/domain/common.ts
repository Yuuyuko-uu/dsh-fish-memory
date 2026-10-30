import * as z from 'zod';

export const CONTRACT_VERSION = '1.0.0' as const;
export const ContractVersionSchema = z.literal(CONTRACT_VERSION);
export const IdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
export const HashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const VersionSchema = z.int().min(1).max(Number.MAX_SAFE_INTEGER);
export const GenerationSchema = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
export const InstantSchema = z.iso.datetime({ offset: true }).max(29)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/);
export const TextSchema = z.string().min(1).max(12000);
export const SummarySchema = z.string().min(1).max(1200);
export const IdsSchema = z.array(IdSchema).max(128);

// Count and evidence offsets use Unicode code points, not UTF-16 units or tokens.
export const codePointLength = (text: string): number => [...text].length;
export const sliceCodePoints = (text: string, start: number, end: number): string =>
  [...text].slice(start, end).join('');

const timeBase = {
  basis: z.enum(['user_explicit', 'context_inferred', 'legacy_summary']),
  evidence_ids: z.array(IdSchema).min(1).max(128),
};
export const TimeRangeSchema = z.discriminatedUnion('precision', [
  z.strictObject({ precision: z.literal('unknown'), start: z.null(), end: z.null(),
    basis: z.literal('unknown'), evidence_ids: z.array(IdSchema).length(0) }),
  z.strictObject({ ...timeBase, precision: z.literal('year'),
    start: z.string().regex(/^[0-9]{4}$/), end: z.string().regex(/^[0-9]{4}$/).nullable() }),
  z.strictObject({ ...timeBase, precision: z.literal('month'),
    start: z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/),
    end: z.string().regex(/^[0-9]{4}-(0[1-9]|1[0-2])$/).nullable() }),
  z.strictObject({ ...timeBase, precision: z.literal('day'), start: z.iso.date(), end: z.iso.date().nullable() }),
  z.strictObject({ ...timeBase, precision: z.literal('instant'), start: InstantSchema, end: InstantSchema.nullable() }),
]);

export const EpisodeScopeSchema = z.strictObject({ kind: z.literal('episode'), id: IdSchema });
export const ConversationScopeSchema = z.strictObject({ kind: z.literal('conversation'), id: IdSchema });
export const CompanionScopeSchema = z.strictObject({ kind: z.literal('companion'), id: IdSchema });
export const LocalScopeSchema = z.discriminatedUnion('kind', [EpisodeScopeSchema, ConversationScopeSchema]);
export const ScopeSchema = z.discriminatedUnion('kind', [EpisodeScopeSchema, ConversationScopeSchema, CompanionScopeSchema]);

export const WatermarkSchema = z.strictObject({
  conversation_id: IdSchema, branch_id: IdSchema, chain_revision: VersionSchema,
  sequence: GenerationSchema,
});
export const MessageRefSchema = z.strictObject({
  conversation_id: IdSchema, branch_id: IdSchema, turn_id: IdSchema,
  sequence: VersionSchema, message_id: IdSchema, revision: VersionSchema,
});
export const ContentStatusSchema = z.enum(['active', 'disputed', 'retracted']);
export const UnderstandingStatusSchema = z.enum(['tentative', 'supported', 'user_confirmed', 'corrected']);
export const StorageTierSchema = z.enum(['hot', 'warm', 'cold']);
export const PublicationStatusSchema = z.enum(['staged', 'published']);
export const TopicStatusSchema = z.enum(['ongoing', 'paused', 'closed']);
export const BasisKindSchema = z.enum(['user_explicit', 'context_inferred', 'legacy_summary', 'assistant_suggested', 'unknown']);

export type TimeRange = z.infer<typeof TimeRangeSchema>;
export type Scope = z.infer<typeof ScopeSchema>;
export type Watermark = z.infer<typeof WatermarkSchema>;
export type MessageRef = z.infer<typeof MessageRefSchema>;
