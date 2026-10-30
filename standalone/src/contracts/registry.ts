import * as z from 'zod';
import { CONTRACT_VERSION, TimeRangeSchema, WatermarkSchema } from '../domain/common.ts';
import {
  ActorSchema, CandidatePatchSchema, CommunicationPatternSchema, EpisodeSchema,
  EvidenceSchema, InterpretationSchema, MemorySchema, ResponseNeedRecordSchema,
} from '../domain/memory.ts';
import { ArchiveManifestSchema } from './archive.ts';
import { toolContracts } from './tools.ts';

export const domainSchemas = {
  actor: ActorSchema, time_range: TimeRangeSchema, watermark: WatermarkSchema,
  evidence: EvidenceSchema, interpretation: InterpretationSchema, episode: EpisodeSchema,
  communication_pattern: CommunicationPatternSchema, response_need: ResponseNeedRecordSchema,
  memory: MemorySchema, candidate_patch: CandidatePatchSchema, archive_manifest: ArchiveManifestSchema,
} as const;

export function exportContractBundle(): Record<string, unknown> {
  const definitions: Record<string, unknown> = {};
  function add(name: string, schema: z.ZodType): void {
    const converted = z.toJSONSchema(schema, { target: 'draft-2020-12', reused: 'inline', cycles: 'throw', unrepresentable: 'throw', io: 'input' });
    delete converted.$schema;
    definitions[name] = converted;
  }
  for (const [name, schema] of Object.entries(domainSchemas)) add(name, schema);
  for (const [name, contract] of Object.entries(toolContracts)) {
    add(`${name}_input`, contract.input); add(`${name}_output`, contract.output);
  }
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `urn:fish-companion:contracts:${CONTRACT_VERSION}`,
    $defs: definitions,
    'x-contract-version': CONTRACT_VERSION,
    'x-validation': 'JSON Schema validates structure only; semantic validation and trusted snapshot checks are required.',
    'x-tools': Object.entries(toolContracts).map(([name, contract]) => ({
      name, input_ref: `#/$defs/${name}_input`, output_ref: `#/$defs/${name}_output`,
      capability: contract.capability, audience: contract.audience,
      annotations: { readOnlyHint: contract.readOnlyHint, destructiveHint: name === 'retract_memory' },
    })),
  };
}
