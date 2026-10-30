import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { runtime,track } from './runtime-helpers.ts';
import { RuntimeStore } from '../src/runtime/store.ts';
import { startServer } from '../src/server.ts';

test('local management refuses browser and incorrect Host requests and releases ownership after damaged metadata',async t=>{
  const env=runtime(t);env.store.config.server.port=0;
  const service=await startServer(env.store);track(t,()=>service.close());
  const base=`http://127.0.0.1:${service.metadata.port}`,headers={authorization:`Bearer ${env.credential.token}`};
  assert.equal((await fetch(base+'/health')).status,200);
  const incorrectHost=await new Promise<number|undefined>((resolve,reject)=>{
    const req=request(base+'/status',{headers:{...headers,host:'attacker.invalid'}},response=>{
      response.resume();response.on('end',()=>resolve(response.statusCode));
    });req.on('error',reject);req.end();
  });
  assert.equal(incorrectHost,403);
  assert.equal((await fetch(base+'/status',{headers:{...headers,origin:'null'}})).status,403);
  const bad=await fetch(base+'/observe',{method:'POST',headers:{...headers,'content-type':'application/json'},body:'{'});
  assert.equal(bad.status,400);assert.equal((await bad.json() as {error:{code:string}}).error.code,'VALIDATION_ERROR');
  const reader=env.store.issueCredential('read');
  assert.equal((await fetch(base+'/observe',{method:'POST',headers:{authorization:`Bearer ${reader.token}`,'content-type':'application/json'},body:'{}'})).status,403);
  writeFileSync(join(env.home,'service.json'),'damaged metadata');await service.close();
  const reopened=RuntimeStore.open(env.home,{clock:env.clock});track(t,()=>reopened.close());
  assert.equal(reopened.status().messages,0);
});
