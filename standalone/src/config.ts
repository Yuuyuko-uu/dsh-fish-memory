import * as z from 'zod';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { HashSchema, IdSchema } from './domain/common.ts';
import { RuntimeError } from './runtime/errors.ts';

export const ConfigSchema = z.strictObject({
  config_version: z.literal(1),
  companion: z.strictObject({
    id: IdSchema, timezone: z.string().min(1).max(128),
    user: z.strictObject({ id: IdSchema, name: z.string().min(1).max(128) }),
    character: z.strictObject({ id: IdSchema, name: z.string().min(1).max(128),
      persona_reference: z.string().min(1).max(1024), persona_sha256: HashSchema.nullable() }),
  }),
  server: z.strictObject({ host: z.literal('127.0.0.1'), port: z.int().min(0).max(65535), request_timeout_ms: z.int().min(1000).max(60000) }),
  database: z.strictObject({ busy_timeout_ms: z.int().min(0).max(10000) }),
  jobs: z.strictObject({ lease_ms: z.int().min(1000).max(300000), max_attempts: z.int().min(1).max(10) }),
});
export type RuntimeConfig = z.infer<typeof ConfigSchema>;
export function resolveHome(explicit?: string): string {
  return resolve(explicit ?? process.env.FISH_MEMORY_HOME ?? join(homedir(), '.fish-companion'));
}
export function prepareHome(home: string): string {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const canonical = realpathSync(home);
  for (const relative of ['archives/objects', 'archives/staging', 'imports', 'backups', 'logs']) mkdirSync(join(canonical, relative), { recursive: true, mode: 0o700 });
  return canonical;
}
export function parseConfig(value: unknown): RuntimeConfig {
  const result = ConfigSchema.safeParse(value);
  if (!result.success) throw new RuntimeError('INVALID_CONFIG', 'Configuration does not match config version 1');
  try { new Intl.DateTimeFormat('en', { timeZone: result.data.companion.timezone }); }
  catch { throw new RuntimeError('INVALID_CONFIG', 'Invalid companion timezone'); }
  if (result.data.companion.user.id === result.data.companion.character.id) throw new RuntimeError('INVALID_CONFIG', 'User and character IDs must be different');
  return result.data;
}
export function readConfig(home: string): RuntimeConfig {
  const path = join(home, 'config.json');
  if (!existsSync(path)) throw new RuntimeError('NOT_INITIALIZED', 'Run init with this home directory first');
  try { return parseConfig(JSON.parse(readFileSync(path, 'utf8'))); }
  catch (error) { if (error instanceof RuntimeError) throw error; throw new RuntimeError('INVALID_CONFIG', 'Cannot read valid UTF-8 JSON configuration'); }
}
export function writeExclusive(path: string, bytes: string | Uint8Array): void {
  const fd = openSync(path, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
export function initializeConfig(home: string, options: { user_name?: string; character_name?: string; port?: number } = {}): RuntimeConfig {
  const path = join(home, 'config.json');
  if (existsSync(path)) return readConfig(home);
  const config = parseConfig({config_version: 1,
    companion: {id: `companion-${randomUUID()}`, timezone: 'Asia/Shanghai',
      user: {id: `user-${randomUUID()}`, name: options.user_name ?? '用户'},
      character: {id: `character-${randomUUID()}`, name: options.character_name ?? '角色', persona_reference: 'unconfigured', persona_sha256: null}},
    server: {host: '127.0.0.1', port: options.port ?? 43117, request_timeout_ms: 10000},
    database: {busy_timeout_ms: 5000}, jobs: {lease_ms: 30000, max_attempts: 3},
  });
  writeExclusive(path, JSON.stringify(config, null, 2) + '\n');
  return config;
}
