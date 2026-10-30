import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod';
import { writeExclusive } from './config.ts';
import { createBackup } from './runtime/backup.ts';
import { RuntimeStore, type Capability } from './runtime/store.ts';
import { RuntimeError, requireState } from './runtime/errors.ts';

export const ServiceFileSchema=z.strictObject({format:z.literal('fish-runtime-v1'),instance_id:z.uuid(),pid:z.int().positive(),host:z.literal('127.0.0.1'),port:z.int().min(1).max(65535)});
export type ServiceFile=z.infer<typeof ServiceFileSchema>;
async function body(request:IncomingMessage):Promise<unknown> {
  requireState(request.headers['content-type']?.split(';')[0]?.trim()==='application/json','VALIDATION_ERROR','Expected application/json');
  let size=0; const chunks:Buffer[]=[];
  for await(const chunk of request) {
    size+=chunk.length; requireState(size<=1_048_576,'BODY_TOO_LARGE','Request body limit is 1 MiB'); chunks.push(Buffer.from(chunk));
  }
  try {return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));}
  catch {throw new RuntimeError('VALIDATION_ERROR','Expected valid UTF-8 JSON');}
}
function send(response:ServerResponse,status:number,value:unknown):void {
  response.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  response.end(JSON.stringify(value));
}
export async function startServer(store:RuntimeStore) {
  const instance_id=randomUUID(); let metadata:ServiceFile;
  let closing:Promise<void>|undefined; let resolveClosed:()=>void;
  const closed=new Promise<void>(resolve=>{resolveClosed=resolve;});
  const file=join(store.home,'service.json');
  const server=createServer((request,response)=>{
    request.setTimeout(store.config.server.request_timeout_ms,()=>request.destroy());
    void handle(request,response).catch(error=>{
      if(response.destroyed || response.headersSent) return;
      const code=error instanceof RuntimeError?error.code:error instanceof z.ZodError?'VALIDATION_ERROR':'INTERNAL_ERROR';
      const status=code==='FORBIDDEN'?403:code==='NOT_FOUND'?404:code==='SERVICE_BUSY'?503:code==='BODY_TOO_LARGE'?413:
        ['IDEMPOTENCY_CONFLICT','VERSION_CONFLICT','STALE_INPUT','STALE_LEASE','DESTINATION_EXISTS'].includes(code)?409:code==='INTERNAL_ERROR'?500:400;
      send(response,status,{ok:false,error:{code,message:error instanceof RuntimeError?error.message:code==='VALIDATION_ERROR'?'Invalid request':'Operation failed; no success receipt was issued'}});
    });
  });
  server.requestTimeout=store.config.server.request_timeout_ms;
  server.headersTimeout=store.config.server.request_timeout_ms;
  server.maxHeadersCount=32;
  async function handle(request:IncomingMessage,response:ServerResponse):Promise<void> {
    requireState(request.headers.host===`127.0.0.1:${metadata.port}` && request.headers.origin===undefined,'FORBIDDEN','Only direct local clients are accepted');
    const route=request.url??'';
    if(request.method==='GET' && route==='/health') {send(response,200,{ok:true,phase:2,instance_id});return;}
    const auth=(capability:Capability)=>{
      const match=/^Bearer (fmc_[A-Za-z0-9_-]{43})$/.exec(request.headers.authorization??'');
      requireState(match,'FORBIDDEN','Bearer credential required'); return store.authenticate(match[1]!,capability).id;
    };
    if(request.method==='GET' && route==='/status') {auth('read');send(response,200,{ok:true,instance_id,...store.status()});return;}
    if(request.method==='POST' && route==='/observe') {const principal=auth('observe');send(response,200,{ok:true,...store.observe(principal,await body(request))});return;}
    if(request.method==='GET' && /^\/memory\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(route)) {
      const principal=auth('read');send(response,200,{ok:true,value:store.readMemory(principal,route.slice('/memory/'.length))});return;
    }
    if(request.method==='POST' && route==='/admin/backup') {
      auth('admin'); const input=z.strictObject({destination:z.string().min(1).optional()}).parse(await body(request));
      const destination=input.destination??join(store.home,'backups',`backup-${Date.now()}-${randomUUID()}`);
      send(response,200,{ok:true,directory:await createBackup(store,destination)});return;
    }
    if(request.method==='POST' && route==='/admin/shutdown') {
      auth('admin'); z.strictObject({}).parse(await body(request));send(response,200,{ok:true,stopping:true});void close();return;
    }
    throw new RuntimeError('NOT_FOUND','Unknown phase 2 management route');
  }
  function close():Promise<void> {
    if(closing) return closing;
    closing=new Promise<void>((resolve,reject)=>{
      server.close(error=>{
        let failure:unknown=error;
        try {
          if(existsSync(file) && JSON.parse(readFileSync(file,'utf8')).instance_id===instance_id) unlinkSync(file);
        } catch {process.stderr.write(JSON.stringify({event:'shutdown_warning',code:'METADATA_CLEANUP_FAILED'})+'\n');}
        try {store.close();} catch(closeError) {failure=closeError;}
        resolveClosed();
        if(failure) reject(failure); else resolve();
      });
    });
    return closing;
  }
  try {
    await new Promise<void>((resolve,reject)=>{
      server.once('error',reject);server.listen(store.config.server.port,'127.0.0.1',()=>{server.off('error',reject);resolve();});
    });
    const address=server.address();requireState(address && typeof address==='object','INTERNAL_ERROR','Service did not bind');
    metadata={format:'fish-runtime-v1',instance_id,pid:process.pid,host:'127.0.0.1',port:address.port};
    const staging=join(store.home,`service-${instance_id}.tmp`);writeExclusive(staging,JSON.stringify(metadata)+'\n');renameSync(staging,file);
  } catch(error) {if(server.listening) await close();else store.close();throw error;}
  return {metadata,closed,close};
}
