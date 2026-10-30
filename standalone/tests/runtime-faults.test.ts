import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runtime,observation,candidate,temporary } from './runtime-helpers.ts';
import { RuntimeStore } from '../src/runtime/store.ts';
import { RuntimeError } from '../src/runtime/errors.ts';
import type { Episode } from '../src/domain/memory.ts';

const code=(expected:string)=>(error:unknown)=>error instanceof RuntimeError && error.code===expected;
test('a commit failure leaves no partial revision and the same staged patch can be retried',t=>{
  let failing=true;
  const env=runtime(t,{fault:point=>{if(failing && point==='afterRevision') throw new Error('commit interrupted');}});
  const input=observation(1);env.store.observe(env.principal,input);const lease=env.store.jobs.claim()!;
  env.store.saveCandidate(lease,candidate(env.store,lease,input));
  assert.throws(()=>env.store.commitCandidate(lease),/commit interrupted/);assert.equal(env.store.status().memories,0);
  const db=new DatabaseSync(join(env.home,'memory.sqlite'),{readOnly:true});
  try {assert.equal(db.prepare('SELECT count(*) AS n FROM memory_revisions').get()!.n,0);assert.equal(db.prepare("SELECT status FROM jobs").get()!.status,'running');}
  finally {db.close();}
  failing=false;assert.equal(env.store.commitCandidate(lease).created.length,1);
});
test('a late candidate cannot replace a memory revised by another completed job',t=>{
  const env=runtime(t),a=observation(1);env.store.observe(env.principal,a);const first=env.store.jobs.claim()!;
  env.store.saveCandidate(first,candidate(env.store,first,a));const id=env.store.commitCandidate(first).created[0]!.memory_id;
  const before=env.store.readMemory(env.principal,id) as Episode;
  const b=observation(2,'后来发现有点委屈。'),c=observation(3,'其实我只是想有人听。');
  env.store.observe(env.principal,b);env.store.observe(env.principal,c);
  const early=env.store.jobs.claim()!,late=env.store.jobs.claim()!;
  env.store.saveCandidate(early,candidate(env.store,early,b,before,[a]));env.store.saveCandidate(late,candidate(env.store,late,c,before,[a]));
  env.store.commitCandidate(late);assert.throws(()=>env.store.commitCandidate(early),code('VERSION_CONFLICT'));
  assert.equal((env.store.readMemory(env.principal,id) as Episode).summary,c.messages[0]!.text);
});
test('editing evidence reused by a later revision invalidates the current memory',t=>{
  const env=runtime(t),a=observation(1);env.store.observe(env.principal,a);const first=env.store.jobs.claim()!;
  env.store.saveCandidate(first,candidate(env.store,first,a));const id=env.store.commitCandidate(first).created[0]!.memory_id;
  const before=env.store.readMemory(env.principal,id) as Episode,b=observation(2);env.store.observe(env.principal,b);
  const second=env.store.jobs.claim()!;
  // Existing evidence from turn 1 is reused without listing turn 1 as this job's fresh input.
  env.store.saveCandidate(second,candidate(env.store,second,b,before));env.store.commitCandidate(second);
  env.store.observe(env.principal,{...a,request_id:'edited-old-evidence',chain_revision:2,messages:[{...a.messages[0]!,revision:2,text:'前面说错了。'},a.messages[1]!]});
  assert.throws(()=>env.store.readMemory(env.principal,id),code('STALE_INPUT'));
});
test('receipt scope is enforced in SQLite and an accepted receipt is immutable',t=>{
  const env=runtime(t),a=observation(1);env.store.observe(env.principal,a);
  env.store.observe(env.principal,{...a,request_id:'other',conversation_id:'other'});
  const db=new DatabaseSync(join(env.home,'memory.sqlite'));db.exec('PRAGMA foreign_keys=ON');
  try {
    const rows=db.prepare('SELECT * FROM turn_receipts ORDER BY conversation_id').all(),x=rows[0]!,y=rows[1]!;
    assert.throws(()=>db.prepare('INSERT INTO turn_receipts VALUES(?,?,?,?,?,?,?)').run(x.companion_id as string,x.conversation_id as string,x.branch_id as string,y.turn_id as string,2,x.payload_sha256 as string,x.job_id as string),/FOREIGN KEY/);
    assert.throws(()=>db.prepare('UPDATE turn_receipts SET turn_id=? WHERE conversation_id=?').run(y.turn_id as string,x.conversation_id as string),/immutable/);
  } finally {db.close();}
});
test('transient job failures use a bounded retry policy and terminal failure stops claiming',t=>{
  const env=runtime(t);env.store.observe(env.principal,observation(1));
  for(let attempt=1;attempt<=3;attempt++) {
    const lease=env.store.jobs.claim()!;assert.ok(lease);env.store.jobs.fail(lease,true,'SYNTHETIC_ERROR');
    assert.equal(env.store.jobs.claim(),null);env.advance(100000);
  }
  assert.equal(env.store.jobs.claim(),null);
  assert.deepEqual((env.store.status().jobs as Record<string,unknown>[]).map(row=>({...row})),[{status:'failed',count:1}]);
});
test('a corrupt owner-lock database is not misreported as another running process',t=>{
  const home=temporary(t);writeFileSync(join(home,'writer.lock.sqlite'),'not a database');
  assert.throws(()=>RuntimeStore.open(home,{initialize:true}),code('LOCK_UNAVAILABLE'));
});
test('staged candidates cannot be silently completed as no-change and clocks cannot backdate revisions',t=>{
  const env=runtime(t),a=observation(1);env.store.observe(env.principal,a);const first=env.store.jobs.claim()!;
  env.store.saveCandidate(first,candidate(env.store,first,a));assert.throws(()=>env.store.completeNoChange(first),code('CANDIDATE_EXISTS'));
  const id=env.store.commitCandidate(first).created[0]!.memory_id,before=env.store.readMemory(env.principal,id) as Episode;
  const b=observation(2);env.store.observe(env.principal,b);const next=env.store.jobs.claim()!;
  env.store.saveCandidate(next,candidate(env.store,next,b,before));env.advance(-1);
  assert.throws(()=>env.store.commitCandidate(next),code('CLOCK_SKEW'));assert.equal(env.store.readMemory(env.principal,id).version,1);
});
