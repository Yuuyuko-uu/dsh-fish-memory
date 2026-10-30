import * as z from 'zod';
import { ContractVersionSchema, GenerationSchema, HashSchema, IdSchema, InstantSchema, VersionSchema } from '../domain/common.ts';

// v1 draft: independent zstd frames plus a canonical UTF-8 JSON manifest.
export const ARCHIVE_LIMITS = Object.freeze({
  max_members: 256, max_member_bytes: 4 * 1024 * 1024,
  max_total_bytes: 32 * 1024 * 1024, max_compressed_bytes: 40 * 1024 * 1024,
  max_manifest_bytes: 1024 * 1024,
});
export const ArchiveMemberSchema = z.strictObject({
  member_id: IdSchema, kind: z.enum(['turn_version', 'source_record', 'memory_revision', 'original_file']),
  record_id: IdSchema, record_version: VersionSchema,
  memory_id: IdSchema.nullable(), memory_version: VersionSchema.nullable(),
  suppression_generation: GenerationSchema,
  offset_bytes: GenerationSchema, compressed_bytes: z.int().min(1).max(ARCHIVE_LIMITS.max_compressed_bytes),
  uncompressed_bytes: z.int().min(1).max(ARCHIVE_LIMITS.max_member_bytes),
  compressed_sha256: HashSchema, content_sha256: HashSchema,
});
export const ArchiveManifestSchema = z.strictObject({
  contract_version: ContractVersionSchema, archive_format: z.literal('fish-archive-v1'),
  companion_id: IdSchema, archive_id: IdSchema, codec: z.literal('zstd'),
  created_at: InstantSchema,
  payload_file: z.literal('payload.zst'), manifest_encoding: z.literal('UTF-8'),
  manifest_canonicalization: z.literal('sorted-keys-json-v1'),
  payload_sha256: HashSchema,
  compressed_bytes: z.int().min(1).max(ARCHIVE_LIMITS.max_compressed_bytes),
  uncompressed_bytes: z.int().min(1).max(ARCHIVE_LIMITS.max_total_bytes),
  members: z.array(ArchiveMemberSchema).min(1).max(ARCHIVE_LIMITS.max_members),
});
export type ArchiveManifest = z.infer<typeof ArchiveManifestSchema>;
