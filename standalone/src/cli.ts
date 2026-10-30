import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveHome, writeExclusive } from './config.ts';
import { createBackup, restoreBackup } from './runtime/backup.ts';
import { RuntimeStore, type Capability } from './runtime/store.ts';
import { RuntimeError, requireState } from './runtime/errors.ts';
import { ServiceFileSchema, startServer } from './server.ts';

function parse(args:string[]):{command:string;options:Map<string,string>} {
  const command=args[0]??'help'; const options=new Map<string,string>();
  for(let i=1;i<args.length;i+=2) {
    const key=args[i]!,value=args[i+1];
    requireState(key.startsWith('--') && value!==undefined && !value.startsWith('--') && !options.has(key),'VALIDATION_ERROR','Options require one value and cannot repeat');
    options.set(key,value);
  }
  const allowed:Record<string,string[]>={help:[],init:['--home','--user-name','--character-name','--port'],serve:['--home'],status:['--home','--token-file'],stop:['--home','--token-file'],
    backup:['--home','--token-file','--out'],restore:['--from','--home'],'token-issue':['--home','--capability','--out']};
  requireState(command in allowed && [...options.keys()].every(key=>allowed[command]!.includes(key)),'VALIDATION_ERROR','Unknown command or option');
  return {command,options};
}
const print=(value:unknown)=>process.stdout.write(JSON.stringify(value)+'\n');
async function request(home:string,tokenFile:string,route:string,value?:unknown):Promise<Record<string,unknown>> {
  requireState(existsSync(join(home,'service.json')),'NOT_RUNNING','No service endpoint exists for this directory');
  const endpoint=ServiceFileSchema.parse(JSON.parse(readFileSync(join(home,'service.json'),'utf8')));
  const base=`http://127.0.0.1:${endpoint.port}`;
  const health=await fetch(base+'/health',{signal:AbortSignal.timeout(3000)}).catch(()=>{throw new RuntimeError('NOT_RUNNING','Stored endpoint is unreachable; serve can replace stale metadata after acquiring the owner lock');});
  const state=await health.json() as {instance_id?:unknown};
  requireState(health.ok && state.instance_id===endpoint.instance_id,'NOT_RUNNING','The stored endpoint belongs to another service');
  const token=readFileSync(tokenFile,'utf8').trim();
  requireState(/^fmc_[A-Za-z0-9_-]{43}$/.test(token),'FORBIDDEN','Token file is invalid');
  const response=await fetch(base+route,{method:value===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},
    ...(value===undefined?{}:{body:JSON.stringify(value)}),signal:AbortSignal.timeout(route==='/admin/backup'?300000:10000)});
  const result=await response.json() as Record<string,unknown> & {error?:{code:string;message:string}};
  if(!response.ok) throw new RuntimeError(result.error?.code??'REQUEST_FAILED',result.error?.message??'Service request failed');
  return result;
}
export async function main(args=process.argv.slice(2)):Promise<void> {
  const {command,options}=parse(args),home=resolveHome(options.get('--home'));
  const token=resolve(options.get('--token-file')??join(home,'admin-token'));
  if(command==='help') {print({commands:['init','serve','status','stop','backup --out <new-directory>','restore --from <backup> --home <new-directory>','token-issue --capability <read|observe|user_edit|admin> --out <new-file>'],home_option:'--home <directory>',phase:2,mcp:false,model_worker:false});return;}
  if(command==='restore') {const from=options.get('--from');requireState(from && options.has('--home'),'VALIDATION_ERROR','Restore requires --from and an explicit new --home');print({ok:true,...restoreBackup(from,home)});return;}
  if(command==='status' || command==='stop') {
    const result=await request(home,token,command==='status'?'/status':'/admin/shutdown',command==='stop'?{}:undefined);
    if(command==='stop') {
      const deadline=Date.now()+10000;
      while(existsSync(join(home,'service.json')) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,50));
      requireState(!existsSync(join(home,'service.json')),'STOP_TIMEOUT','Shutdown accepted but is still waiting for active work');
    }
    print(result);return;
  }
  if(command==='backup' && existsSync(join(home,'service.json'))) {
    try {print(await request(home,token,'/admin/backup',options.has('--out')?{destination:resolve(options.get('--out')!)}:{}));return;}
    catch(error) {if(!(error instanceof RuntimeError && error.code==='NOT_RUNNING')) throw error;}
  }
  if(command==='init') {
    const raw=options.get('--port');const port=raw===undefined?43117:Number(raw);
    requireState(raw===undefined || /^\d+$/.test(raw),'VALIDATION_ERROR','Port must be an integer');
    const store=RuntimeStore.open(home,{initialize:true,init:{...(options.has('--user-name')?{user_name:options.get('--user-name')!}:{}),
      ...(options.has('--character-name')?{character_name:options.get('--character-name')!}:{}),port}});
    try {print({ok:true,home:store.home,token_file:store.ensureBootstrapToken(),phase:2});} finally {store.close();}return;
  }
  const store=RuntimeStore.open(home);
  if(command==='serve') {
    const service=await startServer(store);
    const shutdown=()=>{void service.close().catch(()=>{process.exitCode=1;});};
    process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
    print({event:'listening',...service.metadata});
    await service.closed;process.off('SIGINT',shutdown);process.off('SIGTERM',shutdown);return;
  }
  try {
    if(command==='backup') {print({ok:true,directory:await createBackup(store,resolve(options.get('--out')??join(home,'backups',`backup-${Date.now()}`)))});return;}
    if(command==='token-issue') {
      const capability=options.get('--capability'),out=options.get('--out');
      requireState(capability && ['read','observe','user_edit','admin'].includes(capability) && out,'VALIDATION_ERROR','Token issue requires a capability and --out');
      requireState(!existsSync(resolve(out)),'DESTINATION_EXISTS','Credential output file must be new');
      const credential=store.issueCredential(capability as Capability);
      try {writeExclusive(resolve(out),credential.token+'\n');} catch(error) {store.disableCredential(credential.id);throw error;}
      print({ok:true,credential_id:credential.id,token_file:resolve(out),capability});return;
    }
  } finally {store.close();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error=>{
    process.stderr.write(JSON.stringify({ok:false,error:{code:error instanceof RuntimeError?error.code:'COMMAND_FAILED',
      message:error instanceof RuntimeError?error.message:'Command failed; check the home directory, service state and input files'}})+'\n');process.exitCode=1;
  });
}
