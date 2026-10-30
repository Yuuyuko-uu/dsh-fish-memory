import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { runtime,temporary,observation,candidate,track } from './runtime-helpers.ts';
import { RuntimeStore } from '../src/runtime/store.ts';
import { migrate,openDatabase,migrations } from '../src/db/connection.ts';
import { RuntimeError } from '../src/runtime/errors.ts';
import type { Episode } from '../src/domain/memory.ts';

const code=(expected:string)=>(error:unknown)=>error instanceof RuntimeError && error.code===expected;

test('stage 1 migration remains unchanged while runtime migration is transactional and repeatable',t=>{
  const path=join(temporary(t),'migration.sqlite');
  const db=openDatabase(path); track(t,()=>db.close());
  assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()!.n,2);
  migrate(db);
  assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get()!.n,2);
  const version3={version:3,name:'deliberate-failure',sql:'CREATE TABLE interrupted(id TEXT); INSERT INTO table_does_not_exist VALUES(1);'};
  assert.throws(()=>migrate(db,[...migrations(),version3]));
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='interrupted'").get()!.n,0);
  assert.equal(db.prepare('SELECT max(version) AS n FROM schema_migrations').get()!.n,2);
  assert.throws(()=>migrate(db,[{...migrations()[0]!,sql:migrations()[0]!.sql+'\n-- changed'},migrations()[1]!]),code('MIGRATION_MISMATCH'));
});

test('file database uses WAL and a directory has exactly one cooperating writer',t=>{
  const env=runtime(t);
  assert.equal(env.store.status().journal_mode,'wal');
  assert.throws(()=>RuntimeStore.open(env.home),code('ALREADY_RUNNING'));
  const reader=new DatabaseSync(join(env.home,'memory.sqlite'),{readOnly:true});
  try { assert.equal(reader.prepare('SELECT count(*) AS n FROM companions').get()!.n,1); }
  finally {reader.close();}
});

test('observations, jobs and idempotent receipts survive reopen without duplicate side effects',t=>{
  const env=runtime(t); const input=observation(1);
  const first=env.store.observe(env.principal,input);
  assert.equal(first.replayed,false); assert.equal(first.value.processing_status,'pending');
  assert.equal(env.store.status().messages,2);
  env.store.close();
  const reopened=RuntimeStore.open(env.home,{clock:env.clock}); track(t,()=>reopened.close());
  const replay=reopened.observe(env.principal,input);
  assert.equal(replay.replayed,true); assert.deepEqual(replay.value,first.value);
  assert.equal(reopened.status().messages,2); assert.equal(reopened.status().receipts,1);
  assert.throws(()=>reopened.observe(env.principal,{...input,messages:[{...input.messages[0]!,text:'不同载荷'},input.messages[1]!]}),code('IDEMPOTENCY_CONFLICT'));
  const duplicate=reopened.observe(env.principal,{...input,request_id:'another-request'});
  assert.equal(duplicate.value.duplicate,true); assert.equal(reopened.status().messages,2);
});

test('message or receipt write failures roll back the entire accepted operation',t=>{
  let failing=true;
  const env=runtime(t,{fault:point=>{if(failing && point==='beforeReceipt') throw new Error('synthetic disk failure');}});
  assert.throws(()=>env.store.observe(env.principal,observation(1)),/synthetic disk failure/);
  assert.equal(env.store.status().messages,0); assert.equal(env.store.status().receipts,0);
  failing=false;
  assert.equal(env.store.observe(env.principal,observation(1)).value.accepted_through.sequence,1);
});

test('out-of-order turns and successful no-change jobs advance only contiguous watermarks',t=>{
  const env=runtime(t);
  const third=env.store.observe(env.principal,observation(3)); assert.equal(third.value.accepted_through.sequence,0);
  const lease3=env.store.jobs.claim()!; env.store.completeNoChange(lease3);
  env.store.observe(env.principal,observation(1)); const lease1=env.store.jobs.claim()!; env.store.completeNoChange(lease1);
  const second=env.store.observe(env.principal,observation(2)); assert.equal(second.value.accepted_through.sequence,3);
  assert.equal(second.value.processed_through.sequence,1);
  const lease2=env.store.jobs.claim()!; env.store.completeNoChange(lease2);
  const branches=env.store.status().branches as {processed_through:number}[];
  assert.equal(branches[0]!.processed_through,3);
});

test('candidate staging and atomic publication persist authoritative full memory revisions',t=>{
  const env=runtime(t); const first=observation(1,'今天加班修改方案。');
  env.store.observe(env.principal,first); const lease=env.store.jobs.claim()!;
  env.store.saveCandidate(lease,candidate(env.store,lease,first));
  const result=env.store.commitCandidate(lease); const id=result.created[0]!.memory_id;
  assert.notEqual(id,'temporary-episode');
  const memory=env.store.readMemory(env.principal,id) as Episode; assert.equal(memory.summary,first.messages[0]!.text); assert.equal(memory.version,1);
  const second=observation(2,'方案又改了一次。'); env.advance(1000); env.store.observe(env.principal,second);
  const next=env.store.jobs.claim()!; env.store.saveCandidate(next,candidate(env.store,next,second,memory,[first]));
  env.store.commitCandidate(next);
  assert.equal(env.store.readMemory(env.principal,id).version,2);
  env.store.close(); const reopened=RuntimeStore.open(env.home,{clock:env.clock}); track(t,()=>reopened.close());
  assert.equal((reopened.readMemory(env.principal,id) as Episode).summary,second.messages[0]!.text);
});

test('an edited source invalidates published dependent memories and fences the old worker',t=>{
  const env=runtime(t); const first=observation(1);
  env.store.observe(env.principal,first); const lease=env.store.jobs.claim()!;
  env.store.saveCandidate(lease,candidate(env.store,lease,first)); const id=env.store.commitCandidate(lease).created[0]!.memory_id;
  const second=observation(2); env.store.observe(env.principal,second); const staleLease=env.store.jobs.claim()!;
  const edited={...first,request_id:'edit-source',chain_revision:2,messages:[{...first.messages[0]!,revision:2,text:'更正：那天没有加班。'},first.messages[1]!]};
  env.store.observe(env.principal,edited);
  assert.throws(()=>env.store.readMemory(env.principal,id),code('STALE_INPUT'));
  assert.throws(()=>env.store.completeNoChange(staleLease),error=>error instanceof RuntimeError && ['STALE_INPUT','STALE_LEASE'].includes(error.code));
});

test('expired leases recover with fencing and cannot be renewed or committed by an old worker',t=>{
  const env=runtime(t); const input=observation(1); env.store.observe(env.principal,input);
  const old=env.store.jobs.claim()!; env.advance(31000); assert.equal(env.store.jobs.recover(),1);
  const fresh=env.store.jobs.claim()!; assert.notEqual(fresh.token,old.token); assert.ok(fresh.generation>old.generation);
  assert.throws(()=>env.store.jobs.renew(old),code('STALE_LEASE'));
  assert.throws(()=>env.store.completeNoChange(old),code('STALE_LEASE'));
  assert.throws(()=>env.store.completeNoChange({...fresh,input:{...input,sequence:2}}),code('STALE_LEASE'));
  env.store.completeNoChange(fresh);
});

test('tokens are bound to capabilities and revocation is checked before writes',t=>{
  const env=runtime(t); const reader=env.store.issueCredential('read');
  assert.throws(()=>env.store.authenticate(reader.token,'observe'),code('FORBIDDEN'));
  assert.throws(()=>env.store.observe(reader.id,observation(1)),code('FORBIDDEN'));
  const observer=env.store.issueCredential('observe'); env.store.disableCredential(observer.id);
  assert.throws(()=>env.store.observe(observer.id,observation(1)),code('FORBIDDEN'));
  assert.equal(env.store.status().messages,0);
});

test('source-local external message and turn IDs do not collide across conversations',t=>{
  const env=runtime(t); const a=observation(1); const b={...a,request_id:'other-conversation',conversation_id:'other-conversation'};
  env.store.observe(env.principal,a); env.store.observe(env.principal,b);
  assert.equal(env.store.status().messages,4);
});
