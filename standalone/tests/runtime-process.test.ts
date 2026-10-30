import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporary,track,observation } from './runtime-helpers.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
async function finish(child:ChildProcess):Promise<void> {if(child.exitCode===null && child.signalCode===null) {const exited=once(child,'exit');child.kill('SIGKILL');await exited;}}
function child(t:TestContext,args:string[],extra:Record<string,string>={}):ChildProcess {
  const p=spawn(process.execPath,args,{cwd:root,windowsHide:true,env:{...process.env,...extra},stdio:['ignore','pipe','pipe']});track(t,()=>finish(p));return p;
}
async function command(t:TestContext,args:string[],extra:Record<string,string>={}):Promise<{code:number|null;out:string;err:string}> {
  const p=child(t,['src/cli.ts',...args],extra);let out='',err='';p.stdout!.on('data',d=>{out+=d;});p.stderr!.on('data',d=>{err+=d;});
  const [code]=await once(p,'exit') as [number|null];return {code,out,err};
}
async function serve(t:TestContext,home:string) {
  const p=child(t,['src/cli.ts','serve','--home',home]);let output='';
  const metadata=await new Promise<{port:number;instance_id:string}>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('Service startup timeout')),10000);
    p.once('error',error=>{clearTimeout(timer);reject(error);});
    p.once('exit',code=>{clearTimeout(timer);reject(new Error(`Service exited before startup: ${code}`));});
    p.stdout!.on('data',chunk=>{output+=chunk;const line=output.split('\n').find(x=>x.includes('"event":"listening"'));if(line){clearTimeout(timer);resolve(JSON.parse(line));}});
  });
  return {p,metadata,base:`http://127.0.0.1:${metadata.port}`};
}
test('CLI initializes, serves, persists authenticated observations and shuts down without DSH',{timeout:30000},async t=>{
  const parent=temporary(t),home=join(parent,'memory'),dsh=join(parent,'dsh-sentinel.txt');writeFileSync(dsh,'unchanged');
  const initialized=await command(t,['init','--home',home,'--port','0'],{DSH_HOME:dsh});assert.equal(initialized.code,0,initialized.err);
  const token=readFileSync(join(home,'admin-token'),'utf8').trim();assert.equal(initialized.out.includes(token),false);
  const first=await serve(t,home);
  const headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
  assert.equal((await fetch(first.base+'/status')).status,403);
  assert.equal((await fetch(first.base+'/status',{headers:{...headers,origin:'https://example.com'}})).status,403);
  const input=observation(1),response=await fetch(first.base+'/observe',{method:'POST',headers,body:JSON.stringify(input)});
  assert.equal(response.status,200);const accepted=await response.json();
  const status=await command(t,['status','--home',home]);assert.equal(status.code,0,status.err);assert.equal(JSON.parse(status.out).messages,2);
  const duplicate=await command(t,['serve','--home',home]);assert.equal(duplicate.code,1);assert.match(duplicate.err,/ALREADY_RUNNING/);
  const backup=join(parent,'online-backup');const backed=await command(t,['backup','--home',home,'--out',backup]);assert.equal(backed.code,0,backed.err);
  const stopped=await command(t,['stop','--home',home]);assert.equal(stopped.code,0,stopped.err);
  if(first.p.exitCode===null && first.p.signalCode===null) await once(first.p,'exit');
  assert.equal(existsSync(join(home,'service.json')),false);
  const second=await serve(t,home);const replay=await fetch(second.base+'/observe',{method:'POST',headers,body:JSON.stringify(input)});
  const replayed=await replay.json() as {value:unknown;replayed:boolean};assert.equal(replayed.replayed,true);assert.deepEqual(replayed.value,(accepted as {value:unknown}).value);
  assert.equal((await command(t,['stop','--home',home])).code,0);assert.equal(readFileSync(dsh,'utf8'),'unchanged');
});
test('process death releases the owner lock and the restarted service keeps durable receipts',{timeout:30000},async t=>{
  const home=join(temporary(t),'crashed');assert.equal((await command(t,['init','--home',home,'--port','0'])).code,0);
  const first=await serve(t,home),token=readFileSync(join(home,'admin-token'),'utf8').trim();
  const headers={authorization:`Bearer ${token}`,'content-type':'application/json'},input=observation(1);
  assert.equal((await fetch(first.base+'/observe',{method:'POST',headers,body:JSON.stringify(input)})).status,200);
  await finish(first.p);assert.ok(existsSync(join(home,'service.json')));
  const backup=await command(t,['backup','--home',home,'--out',join(temporary(t),'after-crash')]);assert.equal(backup.code,0,backup.err);
  const next=await serve(t,home);const response=await fetch(next.base+'/observe',{method:'POST',headers,body:JSON.stringify(input)});
  assert.equal((await response.json() as {replayed:boolean}).replayed,true);
  assert.equal((await command(t,['stop','--home',home])).code,0);
});
