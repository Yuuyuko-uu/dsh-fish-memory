import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { initializeConfig, prepareHome, readConfig, writeExclusive, type RuntimeConfig } from '../config.ts';
import { canonicalJson, hashJson, sha256Bytes } from '../contracts/canonical.ts';
import { CandidatePatchSchema, type CandidatePatch, type Memory } from '../domain/memory.ts';
import { ObserveInputSchema, type ObserveData } from '../contracts/tools.ts';
import { validateCandidate, validateToolInput, type ValidationContext, type ContractResult } from '../contracts/validation.ts';
import { acquireOwner, openDatabase, transaction } from '../db/connection.ts';
import { currentMemory, loadContext, storedId } from '../db/context.ts';
import { JobQueue, type JobLease } from '../db/jobs.ts';
import { Observations } from '../db/observations.ts';
import { persistPatch, type CommitResult } from '../db/memory-writer.ts';
import { putJson, readJson } from '../db/objects.ts';
import { RuntimeError, requireState } from './errors.ts';

export type Capability = 'read' | 'observe' | 'user_edit' | 'admin';
export interface Principal { id: string; companion_id: string; capability: Capability; }
export interface StoreOptions {
  initialize?: boolean;
  init?: {user_name?: string; character_name?: string; port?: number};
  clock?: () => Date;
  fault?: (point:string) => void;
}
export class RuntimeStore {
  readonly home: string; readonly config: RuntimeConfig; readonly jobs: JobQueue;
  readonly #db: DatabaseSync; readonly #releaseOwner: () => void; readonly #clock: () => Date;
  readonly #observations: Observations; readonly #fault: (point:string)=>void;
  #closed=false; #maintenance=false;
  private constructor(home:string,config:RuntimeConfig,db:DatabaseSync,release:()=>void,options:StoreOptions) {
    this.home=home; this.config=config; this.#db=db; this.#releaseOwner=release;
    this.#clock=options.clock??(()=>new Date()); this.#fault=options.fault??(()=>{});
    this.jobs=new JobQueue(db,config.companion.id,this.#clock,config.jobs.max_attempts,config.jobs.lease_ms,()=>this.assertWritable());
    this.#observations=new Observations(db,config,this.jobs);
  }
  static open(home:string,options:StoreOptions={}): RuntimeStore {
    if (!options.initialize) readConfig(home);
    const canonical=prepareHome(home);
    requireState(!existsSync(join(canonical,'restore.incomplete')),'INCOMPLETE_RESTORE','Restore has not completed; use a fresh restore destination');
    const release=acquireOwner(canonical); let db: DatabaseSync | undefined;
    try {
      const config=options.initialize?initializeConfig(canonical,options.init):readConfig(canonical);
      db=openDatabase(join(canonical,'memory.sqlite'),config.database.busy_timeout_ms);
      const store=new RuntimeStore(canonical,config,db,release,options);
      store.seed();
      transaction(db,()=>{
        store.jobs.recoverInTransaction();
        for (const row of db!.prepare('SELECT external_id FROM conversations WHERE companion_id=?').all(config.companion.id)) store.#observations.refresh(row.external_id as string);
      });
      return store;
    } catch(error) { db?.close(); release(); throw error; }
  }
  get companion(): string { return this.config.companion.id; }
  private assertWritable(): void { requireState(!this.#closed && !this.#maintenance,'SERVICE_BUSY','Store is closed or temporarily paused for backup'); }
  private seed(): void {
    transaction(this.#db,()=>{
      const owners=this.#db.prepare('SELECT * FROM companions').all();
      if (owners.length===0) {
        const c=this.config.companion;
        this.#db.prepare('INSERT INTO companions VALUES(?,?,?,?)').run(c.id,c.timezone,c.character.persona_reference,c.character.persona_sha256);
        this.#db.prepare('INSERT INTO actors VALUES(?,?,?,?)').run(c.user.id,c.id,'user',c.user.name);
        this.#db.prepare('INSERT INTO actors VALUES(?,?,?,?)').run(c.character.id,c.id,'character',c.character.name);
        this.#db.prepare('INSERT INTO sources VALUES(?,?,?,?,?)').run(storedId('source',[c.id]),c.id,'live_conversation','standalone-live','{}');
        this.#db.prepare('INSERT INTO index_state VALUES(?,1,?,?)').run(c.id,'structure-v1','{}');
      } else {
        const c=this.config.companion; const owner=owners[0]!;
        requireState(owners.length===1 && owner.id===c.id && owner.timezone===c.timezone && owner.persona_reference===c.character.persona_reference && owner.persona_sha256===c.character.persona_sha256,
          'CONFIG_MISMATCH','Configuration is bound to another companion or persona reference');
        for (const [id,kind] of [[c.user.id,'user'],[c.character.id,'character']] as const) {
          requireState(this.#db.prepare('SELECT id FROM actors WHERE companion_id=? AND id=? AND kind=?').get(c.id,id,kind), 'CONFIG_MISMATCH','Configured user or character identity differs from the database');
        }
      }
    });
  }
  close(): void {
    if (this.#closed) return;
    requireState(!this.#maintenance,'SERVICE_BUSY','Wait for backup before closing');
    this.#closed=true;
    try { this.#db.close(); } finally { this.#releaseOwner(); }
  }
  authenticate(token:string,required:Capability='read'): Principal {
    requireState(/^fmc_[A-Za-z0-9_-]{43}$/.test(token),'FORBIDDEN','Invalid credential');
    const digest=sha256Bytes(Buffer.from(token));
    const row=this.#db.prepare('SELECT id,companion_id,capability FROM credentials WHERE token_sha256=? AND companion_id=? AND enabled=1').get(digest,this.companion);
    requireState(row && (row.capability===required || row.capability==='admin'),'FORBIDDEN','Credential lacks the required capability');
    return {id:row.id as string,companion_id:row.companion_id as string,capability:row.capability as Capability};
  }
  private requirePrincipal(id:string,required:Capability): Principal {
    const row=this.#db.prepare('SELECT id,capability FROM credentials WHERE companion_id=? AND id=? AND enabled=1').get(this.companion,id);
    requireState(row && (row.capability===required || row.capability==='admin'),'FORBIDDEN','Credential is disabled or lacks the required capability');
    return {id,companion_id:this.companion,capability:row.capability as Capability};
  }
  issueCredential(capability:Capability): {id:string;token:string} {
    this.assertWritable();
    requireState(['read','observe','user_edit','admin'].includes(capability),'VALIDATION_ERROR','Unknown credential capability');
    const token=`fmc_${randomBytes(32).toString('base64url')}`; const id=`credential-${randomUUID()}`;
    transaction(this.#db,()=>this.#db.prepare('INSERT INTO credentials VALUES(?,?,?,?,1)').run(id,this.companion,sha256Bytes(Buffer.from(token)),capability));
    return {id,token};
  }
  disableCredential(id:string): void { this.assertWritable(); transaction(this.#db,()=>this.#db.prepare('UPDATE credentials SET enabled=0 WHERE companion_id=? AND id=?').run(this.companion,id)); }
  ensureBootstrapToken(): string {
    const path=join(this.home,'admin-token');
    if (existsSync(path)) {
      const token=readFileSync(path,'utf8').trim(); this.authenticate(token,'admin'); return path;
    }
    requireState(Number(this.#db.prepare('SELECT count(*) AS n FROM credentials').get()!.n)===0,'TOKEN_REQUIRED','Use token issue to create a new credential file; existing credentials are not reset');
    const created=this.issueCredential('admin');
    try { writeExclusive(path,created.token+'\n'); } catch(error) { this.disableCredential(created.id); throw error; }
    return path;
  }
  private capabilities(principal:Principal,internal=false): ValidationContext['capabilities'] {
    const result=new Set<'read'|'observe'|'user_edit'|'candidate'>();
    if (principal.capability==='admin') { result.add('read');result.add('observe');result.add('user_edit'); }
    else result.add(principal.capability);
    if (internal) result.add('candidate');
    return result;
  }
  private checked<T>(result:ContractResult<T>): T {
    if (!result.ok) { const first=result.issues[0]!; throw new RuntimeError(first.code,`${first.path}: ${first.message}`); }
    return result.value;
  }
  private idempotent<T>(principal:string,capability:Capability,tool:string,request:string,payload:unknown,work:(principal:Principal)=>T): {value:T;replayed:boolean} {
    this.assertWritable();
    return transaction(this.#db,()=>{
      const identity=this.requirePrincipal(principal,capability); const hash=hashJson(payload);
      const prior=this.#db.prepare('SELECT payload_sha256,result_json FROM write_requests WHERE companion_id=? AND credential_id=? AND tool_name=? AND request_id=?').get(this.companion,principal,tool,request);
      if (prior) { requireState(prior.payload_sha256===hash,'IDEMPOTENCY_CONFLICT','Request ID was already used for another payload'); return {value:JSON.parse(prior.result_json as string) as T,replayed:true}; }
      const value=work(identity);
      this.#fault('beforeReceipt');
      this.#db.prepare('INSERT INTO write_requests VALUES(?,?,?,?,?,?)').run(this.companion,principal,tool,request,hash,canonicalJson(value));
      this.#fault('beforeCommit');
      return {value,replayed:false};
    });
  }
  observe(principal:string,raw:unknown): {value:ObserveData;replayed:boolean} {
    const parsed=ObserveInputSchema.safeParse(raw);
    requireState(parsed.success,'VALIDATION_ERROR','Observation does not match the phase 1 contract');
    const input=parsed.data;
    return this.idempotent(principal,'observe','observe_turn',input.request_id,input,identity=>{
      this.#observations.ensureConversation(input);
      this.checked(validateToolInput('observe_turn',input,loadContext(this.#db,this.companion,this.capabilities(identity))));
      return this.#observations.receive(input,this.#fault).data;
    });
  }
  readMemory(principal:string,id:string): Memory {
    this.requirePrincipal(principal,'read');
    const value=currentMemory(this.#db,this.companion,id);
    const valid=this.#db.prepare('SELECT status,version FROM memory_validity WHERE companion_id=? AND memory_id=?').get(this.companion,id);
    requireState(value && value.content_status==='active' && value.publication_status==='published','NOT_FOUND','Memory is not available');
    requireState(valid?.status==='valid' && valid.version===value.version,'STALE_INPUT','Memory depends on edited input and is awaiting reprocessing');
    return value;
  }
  saveCandidate(lease:JobLease,raw:unknown): void {
    this.assertWritable();
    transaction(this.#db,()=>{
      this.jobs.assertLease(lease); const input=this.#observations.assertJobInputCurrent(lease.input);
      const context=loadContext(this.#db,this.companion,new Set(['candidate']));
      const patch=this.checked(validateCandidate(raw,context));
      requireState(patch.job_id===lease.job_id && patch.input_watermark.conversation_id===input.conversation_id
        && patch.input_watermark.branch_id===input.branch_id && patch.input_watermark.chain_revision===input.chain_revision
        && patch.input_watermark.sequence===input.sequence,'STALE_INPUT','Candidate belongs to another job input');
      for (const mutation of patch.mutations) if (mutation.record.kind==='episode') {
        const previous=context.memories.get(mutation.record.id);
        requireState(mutation.record.storage_tier===(previous?.kind==='episode'?previous.storage_tier:'hot'),'VALIDATION_ERROR','Model candidates cannot change physical storage tiers');
      }
      const existing=this.#db.prepare('SELECT content_object_id FROM job_candidates WHERE companion_id=? AND job_id=? AND lease_generation=?').get(this.companion,lease.job_id,lease.generation);
      if (existing) requireState(hashJson(readJson(this.#db,this.companion,existing.content_object_id as string))===hashJson(patch),'IDEMPOTENCY_CONFLICT','Candidate for this lease was already staged');
      else this.#db.prepare(`INSERT INTO job_candidates VALUES(?,?,?,?,'staged')`).run(this.companion,lease.job_id,lease.generation,putJson(this.#db,this.companion,patch));
    });
  }
  commitCandidate(lease:JobLease): CommitResult {
    this.assertWritable();
    return transaction(this.#db,()=>{
      this.jobs.assertLease(lease); const input=this.#observations.assertJobInputCurrent(lease.input);
      const staged=this.#db.prepare(`SELECT content_object_id FROM job_candidates WHERE companion_id=? AND job_id=? AND lease_generation=? AND status='staged'`).get(this.companion,lease.job_id,lease.generation);
      requireState(staged,'NOT_FOUND','No staged candidate exists for this worker lease');
      const raw=CandidatePatchSchema.parse(readJson(this.#db,this.companion,staged.content_object_id as string));
      const patch=this.checked(validateCandidate(raw,loadContext(this.#db,this.companion,new Set(['candidate']))));
      const result=persistPatch(this.#db,this.companion,patch,this.#clock().toISOString(),this.#fault);
      this.jobs.finishInTransaction(lease,result);
      this.#db.prepare(`UPDATE job_candidates SET status='committed' WHERE companion_id=? AND job_id=? AND lease_generation=?`).run(this.companion,lease.job_id,lease.generation);
      this.#observations.refresh(input.conversation_id);
      this.#fault('beforeCommit');
      return result;
    });
  }
  completeNoChange(lease:JobLease): void {
    this.assertWritable();
    transaction(this.#db,()=>{
      this.jobs.assertLease(lease);
      const input=this.#observations.assertJobInputCurrent(lease.input);
      requireState(!this.#db.prepare(`SELECT 1 FROM job_candidates WHERE companion_id=? AND job_id=? AND lease_generation=? AND status='staged'`).get(this.companion,lease.job_id,lease.generation),
        'CANDIDATE_EXISTS','A staged patch must be committed or the job explicitly failed; it cannot be silently discarded as no-change');
      this.jobs.finishInTransaction(lease,{no_change:true});
      this.#observations.refresh(input.conversation_id);
    });
  }
  status(): Record<string,unknown> {
    const count=(table:string)=>Number(this.#db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n);
    return {phase:2,mcp_connected:false,model_worker_enabled:false,companion_id:this.companion,
      schema_version:this.#db.prepare('SELECT max(version) AS n FROM schema_migrations').get()!.n,
      journal_mode:this.#db.prepare('PRAGMA journal_mode').get()!.journal_mode,
      messages:count('turn_versions'),memories:count('memory_records'),receipts:count('write_requests'),
      jobs:this.#db.prepare('SELECT status,count(*) AS count FROM jobs GROUP BY status').all(),
      branches:this.#db.prepare('SELECT c.external_id AS conversation_id,b.id AS branch_id,b.chain_revision,b.accepted_through,b.processed_through FROM branches b JOIN conversations c ON c.id=b.conversation_id').all()};
  }
  // Used by the backup module, not exposed as arbitrary SQL over HTTP.
  async withBackup<T>(work:(db:DatabaseSync)=>Promise<T>):Promise<T> {
    this.assertWritable(); this.#maintenance=true;
    try { return await work(this.#db); } finally { this.#maintenance=false; }
  }
}
