import * as z from 'zod';
import { randomBytes, randomUUID } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, unlinkSync, lstatSync, closeSync, openSync, fsyncSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseConfig, prepareHome, writeExclusive } from '../config.ts';
import { sha256Bytes } from '../contracts/canonical.ts';
import { HashSchema } from '../domain/common.ts';
import { migrations, openDatabase, transaction } from '../db/connection.ts';
import { readBytes } from '../db/objects.ts';
import { RuntimeStore } from './store.ts';
import { requireState } from './errors.ts';

const FileSchema=z.strictObject({sha256:HashSchema,bytes:z.int().nonnegative()});
const ManifestSchema=z.strictObject({format:z.literal('fish-backup-v1'),storage:z.literal('inline-only'),created_at:z.iso.datetime(),
  files:z.strictObject({'memory.sqlite':FileSchema,'config.json':FileSchema})});
function digest(bytes:Uint8Array) { return {sha256:sha256Bytes(bytes),bytes:bytes.length}; }
function verifyDatabase(db:DatabaseSync):void {
  requireState(db.prepare('PRAGMA integrity_check').all().every(row=>row.integrity_check==='ok'),'DATABASE_CORRUPT','SQLite integrity check failed');
  requireState(db.prepare('PRAGMA foreign_key_check').all().length===0,'DATABASE_CORRUPT','Foreign key check failed');
  const planned=migrations(); const applied=db.prepare('SELECT version,name,sha256 FROM schema_migrations ORDER BY version').all();
  requireState(applied.length===planned.length && applied.every((row,i)=>row.version===planned[i]!.version && row.name===planned[i]!.name
    && row.sha256===sha256Bytes(Buffer.from(planned[i]!.sql))),'MIGRATION_MISMATCH','Backup needs exactly the supported database migrations');
  // Fail closed until phase 7 can validate and copy the complete referenced archive set.
  requireState(Number(db.prepare('SELECT count(*) AS n FROM object_locations WHERE inline_bytes IS NULL').get()!.n)===0
    && Number(db.prepare('SELECT count(*) AS n FROM archives').get()!.n)===0,'ARCHIVE_UNSUPPORTED','This backup version supports inline storage only; archive files must never be silently omitted');
  for(const row of db.prepare('SELECT companion_id,id FROM content_objects').iterate()) readBytes(db,row.companion_id as string,row.id as string);
}
function durableFile(path:string):void { const fd=openSync(path,'r+'); try {fsyncSync(fd);} finally {closeSync(fd);} }
export async function createBackup(store:RuntimeStore,destination:string):Promise<string> {
  const target=resolve(destination);
  return store.withBackup(async db=>{
    verifyDatabase(db);
    // mkdir without recursive provides exclusive creation; partial failures remain unpublishable.
    requireState(!existsSync(target),'DESTINATION_EXISTS','Backup destination must be new');
    mkdirSync(target,{mode:0o700});
    const database=join(target,'memory.sqlite');
    await backup(db,database);
    durableFile(database);
    const snapshot=new DatabaseSync(database,{readOnly:true});
    try {verifyDatabase(snapshot);} finally {snapshot.close();}
    const config=Buffer.from(JSON.stringify(store.config,null,2)+'\n');
    writeExclusive(join(target,'config.json'),config);
    writeExclusive(join(target,'manifest.json'),JSON.stringify({format:'fish-backup-v1',storage:'inline-only',created_at:new Date().toISOString(),
      files:{'memory.sqlite':digest(readFileSync(database)),'config.json':digest(config)}},null,2)+'\n');
    return target;
  });
}
export function validateBackup(directory:string):{database:Buffer;config:Buffer} {
  const root=resolve(directory);
  const manifest=ManifestSchema.parse(JSON.parse(readFileSync(join(root,'manifest.json'),'utf8')));
  const read=(name:'memory.sqlite'|'config.json')=>{
    const path=join(root,name);
    requireState(lstatSync(path).isFile(),'INVALID_BACKUP','Backup members must be regular files');
    const bytes=readFileSync(path); const expected=manifest.files[name];
    requireState(bytes.length===expected.bytes && sha256Bytes(bytes)===expected.sha256,'INVALID_BACKUP','Backup member hash or size differs from the manifest');
    return bytes;
  };
  const database=read('memory.sqlite'),config=read('config.json');
  const parsed=parseConfig(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(config)));
  const db=new DatabaseSync(join(root,'memory.sqlite'),{readOnly:true});
  try {
    verifyDatabase(db);
    const c=parsed.companion,owners=db.prepare('SELECT * FROM companions').all(),owner=owners[0];
    requireState(owners.length===1 && owner?.id===c.id && owner.timezone===c.timezone
      && owner.persona_reference===c.character.persona_reference && owner.persona_sha256===c.character.persona_sha256,
      'INVALID_BACKUP','Backup configuration does not match its database');
    for(const [id,kind] of [[c.user.id,'user'],[c.character.id,'character']] as const)
      requireState(db.prepare('SELECT id FROM actors WHERE companion_id=? AND id=? AND kind=?').get(c.id,id,kind),'INVALID_BACKUP','Backup actor binding differs from configuration');
  } finally {db.close();}
  return {database,config};
}
export function restoreBackup(directory:string,destination:string):{home:string;token_file:string} {
  const target=resolve(destination);
  requireState(!existsSync(target),'DESTINATION_EXISTS','Restore requires a new directory; existing memory is never overwritten');
  const files=validateBackup(directory);
  // Exclusive creation also guards a competing restore between validation and publication.
  mkdirSync(target,{mode:0o700});
  const marker=join(target,'restore.incomplete'); writeExclusive(marker,'Restore is incomplete. Do not start this directory.\n');
  prepareHome(target); writeExclusive(join(target,'config.json'),files.config); writeExclusive(join(target,'memory.sqlite'),files.database);
  const db=openDatabase(join(target,'memory.sqlite'));
  const token_file=join(target,'admin-token');
  try {
    verifyDatabase(db);
    transaction(db,()=>{
      db.exec('UPDATE credentials SET enabled=0');
      db.exec(`UPDATE job_candidates SET status='stale' WHERE status='staged'`);
      db.prepare(`UPDATE jobs SET status=CASE WHEN attempts>=? THEN 'failed' ELSE 'queued' END,
        lease_token=NULL,lease_until=NULL,lease_generation=lease_generation+1,available_at=?,error_code='RESTORED'
        WHERE status IN ('running','retry_wait','queued')`).run(parseConfig(JSON.parse(files.config.toString('utf8'))).jobs.max_attempts,new Date().toISOString());
      const token=`fmc_${randomBytes(32).toString('base64url')}`;
      db.prepare('INSERT INTO credentials VALUES(?,?,?,?,1)').run(`credential-${randomUUID()}`,
        parseConfig(JSON.parse(files.config.toString('utf8'))).companion.id,sha256Bytes(Buffer.from(token)),'admin');
      writeExclusive(token_file,token+'\n');
    });
  } finally {db.close();}
  // The marker is removed last. A crash at any earlier point leaves a non-startable destination.
  unlinkSync(marker);
  return {home:target,token_file};
}
