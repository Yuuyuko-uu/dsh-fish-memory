import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { runtime,temporary,observation,candidate,track } from './runtime-helpers.ts';
import { createBackup,restoreBackup,validateBackup } from '../src/runtime/backup.ts';
import { RuntimeStore } from '../src/runtime/store.ts';
import { RuntimeError } from '../src/runtime/errors.ts';

const code=(expected:string)=>(error:unknown)=>error instanceof RuntimeError && error.code===expected;
test('online backup includes committed WAL data, blocks writes, and restores to a new independent home',async t=>{
  const env=runtime(t),input=observation(1,'今天终于把方案做完了。');
  env.store.observe(env.principal,input); const lease=env.store.jobs.claim()!;
  env.store.saveCandidate(lease,candidate(env.store,lease,input));const id=env.store.commitCandidate(lease).created[0]!.memory_id;
  const backup=join(temporary(t),'snapshot');const pending=createBackup(env.store,backup);
  assert.throws(()=>env.store.observe(env.principal,observation(2)),code('SERVICE_BUSY'));
  assert.throws(()=>env.store.jobs.claim(),code('SERVICE_BUSY'));await pending;
  assert.ok(existsSync(join(backup,'manifest.json')));assert.equal(existsSync(join(backup,'admin-token')),false);
  await assert.rejects(()=>createBackup(env.store,backup),code('DESTINATION_EXISTS'));
  const home=join(temporary(t),'restored');const restored=restoreBackup(backup,home);
  assert.throws(()=>restoreBackup(backup,home),code('DESTINATION_EXISTS'));
  const store=RuntimeStore.open(home);track(t,()=>store.close());
  assert.throws(()=>store.authenticate(env.credential.token),code('FORBIDDEN'));
  const principal=store.authenticate(readFileSync(restored.token_file,'utf8').trim(),'admin');
  assert.equal(store.readMemory(principal.id,id).version,1);assert.equal(store.status().messages,2);
  assert.equal(existsSync(join(home,'restore.incomplete')),false);
  assert.equal(env.store.observe(env.principal,observation(2)).replayed,false);
});
test('missing or modified backup members are rejected before creating the destination',async t=>{
  const env=runtime(t),backup=join(temporary(t),'snapshot');await createBackup(env.store,backup);
  const path=join(backup,'config.json'),original=readFileSync(path);writeFileSync(path,'{}');
  const home=join(temporary(t),'bad-restore');assert.throws(()=>restoreBackup(backup,home),code('INVALID_BACKUP'));
  assert.equal(existsSync(home),false);writeFileSync(path,original);validateBackup(backup);
  unlinkSync(path);assert.throws(()=>validateBackup(backup));
});
test('restoring a running job fences the original lease and preserves accepted work',async t=>{
  const env=runtime(t),input=observation(1);env.store.observe(env.principal,input);const old=env.store.jobs.claim()!;
  const backup=join(temporary(t),'snapshot');await createBackup(env.store,backup);
  const restored=restoreBackup(backup,join(temporary(t),'restored'));
  const store=RuntimeStore.open(restored.home);track(t,()=>store.close());
  assert.throws(()=>store.completeNoChange(old),code('STALE_LEASE'));
  assert.ok(store.jobs.claim());
});
test('inline backup refuses database references to unimplemented archives',async t=>{
  const env=runtime(t);
  // Even a prepared archive must prevent a deceptively incomplete backup.
  const db=new DatabaseSync(join(env.home,'memory.sqlite'));db.exec('PRAGMA foreign_keys=OFF');
  db.prepare("INSERT INTO archives VALUES(?,?,'fish-archive-v1',?,?,?,1,1,'prepared')").run('archive-test',env.store.companion,'missing-manifest','a'.repeat(64),'objects/test');db.close();
  await assert.rejects(()=>createBackup(env.store,join(temporary(t),'snapshot')));
});
