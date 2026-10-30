import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { runtime,track,observation } from './runtime-helpers.ts';
import { RuntimeStore } from '../src/runtime/store.ts';

test('killing a process rolls back its open transaction and expired durable jobs recover',{timeout:15000},async t=>{
  const env=runtime(t);env.store.observe(env.principal,observation(1));env.store.close();
  const child=spawn(process.execPath,['tests/helpers/crash-worker.ts',env.home,env.clock().toISOString()],{
    cwd:fileURLToPath(new URL('../',import.meta.url)),windowsHide:true,stdio:['ignore','pipe','pipe']});
  track(t,async()=>{if(child.exitCode===null && child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}});
  await new Promise<void>((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Crash worker did not reach its transaction')),5000);
    child.once('error',error=>{clearTimeout(timeout);reject(error);});child.once('exit',()=>{clearTimeout(timeout);reject(new Error('Worker exited early'));});
    child.stdout!.once('data',()=>{clearTimeout(timeout);resolve();});
  });
  const exited=once(child,'exit');child.kill('SIGKILL');await exited;env.advance(60000);
  const reopened=RuntimeStore.open(env.home,{clock:env.clock});track(t,()=>reopened.close());
  const db=new DatabaseSync(join(env.home,'memory.sqlite'),{readOnly:true});
  try {
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='crash_probe'").get()!.n,0);
    assert.equal(db.prepare('SELECT status FROM jobs').get()!.status,'queued');
    assert.equal(db.prepare('PRAGMA integrity_check').get()!.integrity_check,'ok');
  } finally {db.close();}
  const lease=reopened.jobs.claim()!;assert.ok(lease.generation>=3);reopened.completeNoChange(lease);
  assert.equal((reopened.status().branches as {processed_through:number}[])[0]!.processed_through,1);
});
