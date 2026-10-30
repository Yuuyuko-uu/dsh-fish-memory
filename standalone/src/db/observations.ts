import type { DatabaseSync } from 'node:sqlite';
import type { RuntimeConfig } from '../config.ts';
import { ObserveInputSchema, type ToolInput, type ObserveData } from '../contracts/tools.ts';
import { hashJson } from '../contracts/canonical.ts';
import { type Watermark } from '../domain/common.ts';
import { VisibleMessageSchema, type VisibleMessage } from '../domain/memory.ts';
import { contiguousWatermark, type JobStatus } from '../domain/transitions.ts';
import { requireState } from '../runtime/errors.ts';
import { conversationId, storedId } from './context.ts';
import { putJson, readJson } from './objects.ts';
import type { JobQueue } from './jobs.ts';

export function observationHash(input: ToolInput<'observe_turn'>): string {
  const {request_id: _request, ...content} = input;
  return hashJson(content);
}
export class Observations {
  readonly db: DatabaseSync; readonly config: RuntimeConfig; readonly queue: JobQueue;
  constructor(db: DatabaseSync, config: RuntimeConfig, queue: JobQueue) { this.db=db; this.config=config; this.queue=queue; }
  get companion(): string { return this.config.companion.id; }
  ensureConversation(input: ToolInput<'observe_turn'>): string {
    requireState(input.branch_id==='main','UNSUPPORTED_BRANCH','Phase 2 accepts the main branch; host branch adapters belong to phase 3');
    const id=conversationId(this.companion,input.conversation_id);
    const existing=this.db.prepare('SELECT id FROM conversations WHERE companion_id=? AND id=?').get(this.companion,id);
    if (!existing) {
      requireState(input.chain_revision===1,'STALE_INPUT','A new conversation starts at chain revision 1');
      this.db.prepare('INSERT INTO conversations VALUES(?,?,?,?)').run(id,this.companion,storedId('source',[this.companion]),input.conversation_id);
      this.db.prepare('INSERT INTO branches VALUES(?,?,?,NULL,NULL,1,0,0)').run('main',this.companion,id);
    }
    return id;
  }
  messages(turn: string, conversation: string): VisibleMessage[] {
    return this.db.prepare(`SELECT v.content_object_id FROM branch_messages b JOIN messages m ON m.id=b.message_id
      JOIN turn_versions v ON v.id=b.turn_version_id WHERE b.companion_id=? AND b.conversation_id=? AND b.branch_id='main'
      AND m.turn_id=? AND b.active=1 ORDER BY m.position`).all(this.companion,conversation,turn)
      .map(row=>VisibleMessageSchema.parse(readJson(this.db,this.companion,row.content_object_id as string)));
  }
  receive(input: ToolInput<'observe_turn'>, hook: (point:string)=>void): {data: ObserveData; edited: boolean} {
    requireState(this.db.isTransaction,'TRANSACTION_REQUIRED','Observation must be transactional');
    const conversation=this.ensureConversation(input);
    const branch=this.db.prepare(`SELECT * FROM branches WHERE companion_id=? AND conversation_id=? AND id='main'`).get(this.companion,conversation)!;
    const turn=storedId('turn',[this.companion,input.conversation_id,input.branch_id,input.turn_id]);
    const bySequence=this.db.prepare('SELECT id FROM turns WHERE companion_id=? AND conversation_id=? AND branch_id=? AND sequence=?').get(this.companion,conversation,input.branch_id,input.sequence);
    requireState(!bySequence || bySequence.id===turn,'VERSION_CONFLICT','Sequence identifies another turn');
    const existing=this.db.prepare('SELECT sequence FROM turns WHERE companion_id=? AND id=?').get(this.companion,turn);
    requireState(!existing || existing.sequence===input.sequence,'VERSION_CONFLICT','Turn position is immutable');
    const oldMessages=existing ? this.messages(turn,conversation) : [];
    const changed=!!existing && hashJson(oldMessages)!==hashJson(input.messages);
    const oldRevision=Number(branch.chain_revision);
    requireState(input.chain_revision===(changed?oldRevision+1:oldRevision),'STALE_INPUT','Edits advance the chain once; appends keep its revision');
    if (changed) {
      for (const old of oldMessages) {
        const next=input.messages.find(item=>item.message_id===old.message_id);
        requireState(next && next.position===old.position && next.role===old.role,'VERSION_CONFLICT','Phase 2 edits keep logical message identity and position');
        requireState(next.revision>=old.revision && (hashJson(next)===hashJson(old) || next.revision>old.revision),'VERSION_CONFLICT','Changed messages require a newer message revision');
      }
      this.db.prepare(`UPDATE memory_validity SET status='stale',reason='MESSAGE_EDITED' WHERE companion_id=? AND memory_id IN
        (SELECT r.memory_id FROM memory_revisions r JOIN revision_inputs i ON i.memory_revision_id=r.id
         JOIN memory_records m ON m.id=r.memory_id AND m.version=r.version
         JOIN turn_versions v ON v.id=i.turn_version_id JOIN messages msg ON msg.id=v.message_id WHERE msg.turn_id=?)`).run(this.companion,turn);
      this.db.prepare(`DELETE FROM search_terms WHERE companion_id=? AND document_id IN
        (SELECT d.id FROM search_documents d JOIN memory_validity v ON v.memory_id=d.memory_id WHERE v.status='stale')`).run(this.companion);
      this.db.prepare(`DELETE FROM search_documents WHERE companion_id=? AND memory_id IN (SELECT memory_id FROM memory_validity WHERE companion_id=? AND status='stale')`).run(this.companion,this.companion);
      this.db.prepare(`UPDATE job_candidates SET status='stale' WHERE companion_id=? AND status='staged' AND job_id IN
        (SELECT job_id FROM turn_receipts WHERE companion_id=? AND conversation_id=? AND branch_id='main')`).run(this.companion,this.companion,conversation);
      this.db.prepare(`UPDATE jobs SET status='stale',lease_generation=lease_generation+1,lease_token=NULL,lease_until=NULL,error_code='CHAIN_EDITED'
        WHERE companion_id=? AND status IN ('queued','running','retry_wait') AND id IN
        (SELECT job_id FROM turn_receipts WHERE companion_id=? AND conversation_id=? AND branch_id='main')`).run(this.companion,this.companion,conversation);
      this.db.prepare(`UPDATE branches SET chain_revision=?,accepted_through=0,processed_through=0 WHERE companion_id=? AND conversation_id=? AND id='main'`).run(input.chain_revision,this.companion,conversation);
    }
    if (!existing) this.db.prepare('INSERT INTO turns(id,companion_id,conversation_id,branch_id,sequence,external_id) VALUES(?,?,?,?,?,?)')
      .run(turn,this.companion,conversation,input.branch_id,input.sequence,input.turn_id);
    for (const message of input.messages) {
      const id=storedId('message',[turn,message.message_id]);
      const prior=this.db.prepare('SELECT id,position,role FROM messages WHERE companion_id=? AND id=?').get(this.companion,id);
      if (prior) requireState(prior.position===message.position && prior.role===message.role,'VERSION_CONFLICT','Logical message identity cannot change');
      else this.db.prepare('INSERT INTO messages(id,companion_id,turn_id,actor_id,position,role,external_id) VALUES(?,?,?,?,?,?,?)')
        .run(id,this.companion,turn,message.role==='user'?this.config.companion.user.id:this.config.companion.character.id,message.position,message.role,message.message_id);
      const version=storedId('message-version',[id,String(message.revision)]);
      const old=this.db.prepare('SELECT content_object_id FROM turn_versions WHERE companion_id=? AND id=?').get(this.companion,version);
      if (old) requireState(hashJson(readJson(this.db,this.companion,old.content_object_id as string))===hashJson(message),'VERSION_CONFLICT','An existing message revision has different bytes');
      else this.db.prepare('INSERT INTO turn_versions VALUES(?,?,?,?,?,?,?)').run(version,this.companion,id,message.revision,putJson(this.db,this.companion,message),message.status,message.captured_at);
      this.db.prepare(`INSERT INTO branch_messages VALUES(?,?,?, ?,?,1) ON CONFLICT(companion_id,conversation_id,branch_id,message_id)
        DO UPDATE SET turn_version_id=excluded.turn_version_id,active=1`).run(this.companion,conversation,input.branch_id,id,version);
    }
    hook('afterMessages');
    const logical=observationHash(input);
    let duplicate=false;
    if (changed) {
      for (const row of this.db.prepare('SELECT id,external_id,sequence FROM turns WHERE companion_id=? AND conversation_id=? ORDER BY sequence').all(this.companion,conversation)) {
        this.schedule({...input,turn_id:(row.external_id??row.id) as string,sequence:Number(row.sequence),messages:this.messages(row.id as string,conversation)},conversation,row.id as string);
      }
    } else {
      const receipt=this.db.prepare('SELECT payload_sha256 FROM turn_receipts WHERE companion_id=? AND conversation_id=? AND branch_id=? AND turn_id=? AND chain_revision=?')
        .get(this.companion,conversation,input.branch_id,turn,input.chain_revision);
      if (receipt) { requireState(receipt.payload_sha256===logical,'VERSION_CONFLICT','Turn receipt differs from current content'); duplicate=true; }
      else this.schedule(input,conversation,turn);
    }
    const marks=this.refresh(input.conversation_id);
    const receipt=this.db.prepare('SELECT j.id,j.status FROM turn_receipts r JOIN jobs j ON j.id=r.job_id WHERE r.companion_id=? AND r.conversation_id=? AND r.branch_id=? AND r.turn_id=? AND r.chain_revision=?')
      .get(this.companion,conversation,input.branch_id,turn,input.chain_revision)!;
    return {edited:changed,data:{receipt:'accepted',processing_status:marks.processed_through.sequence>=input.sequence?'processed':receipt.status==='failed'?'failed':'pending',
      duplicate,job_ids:[receipt.id as string],...marks}};
  }
  private schedule(input: ToolInput<'observe_turn'>, conversation: string, turn: string): void {
    const hash=observationHash(input);
    const normalized={...input,request_id:`observation-${hash}`};
    const job=this.queue.enqueueInTransaction('extract',hash,normalized);
    this.db.prepare('INSERT INTO turn_receipts VALUES(?,?,?,?,?,?,?)').run(this.companion,conversation,input.branch_id,turn,input.chain_revision,hash,job);
  }
  refresh(external: string): {accepted_through: Watermark; processed_through: Watermark} {
    requireState(this.db.isTransaction,'TRANSACTION_REQUIRED','Watermark updates require a transaction');
    const conversation=conversationId(this.companion,external);
    const branch=this.db.prepare(`SELECT chain_revision FROM branches WHERE companion_id=? AND conversation_id=? AND id='main'`).get(this.companion,conversation);
    requireState(branch,'NOT_FOUND','Conversation does not exist');
    const revision=Number(branch.chain_revision);
    const rows=this.db.prepare(`SELECT t.sequence,j.status FROM turn_receipts r JOIN turns t ON t.id=r.turn_id JOIN jobs j ON j.id=r.job_id
      WHERE r.companion_id=? AND r.conversation_id=? AND r.branch_id='main' AND r.chain_revision=?`).all(this.companion,conversation,revision)
      .map(row=>({sequence:Number(row.sequence),received:true,status:row.status as JobStatus}));
    const accepted=contiguousWatermark(rows,'accepted'); const processed=contiguousWatermark(rows,'processed');
    this.db.prepare(`UPDATE branches SET accepted_through=?,processed_through=? WHERE companion_id=? AND conversation_id=? AND id='main' AND chain_revision=?`)
      .run(accepted,processed,this.companion,conversation,revision);
    const mark={conversation_id:external,branch_id:'main',chain_revision:revision};
    return {accepted_through:{...mark,sequence:accepted},processed_through:{...mark,sequence:processed}};
  }
  assertJobInputCurrent(raw: unknown): ToolInput<'observe_turn'> {
    // Queued input was structurally validated on receipt, but reload it defensively.
    const input=ObserveInputSchema.parse(raw);
    const conversation=conversationId(this.companion,input.conversation_id);
    const row=this.db.prepare(`SELECT r.payload_sha256 FROM turn_receipts r JOIN branches b ON b.companion_id=r.companion_id AND b.conversation_id=r.conversation_id AND b.id=r.branch_id
      JOIN turns t ON t.id=r.turn_id WHERE r.companion_id=? AND r.conversation_id=? AND r.branch_id=? AND r.chain_revision=b.chain_revision
      AND r.chain_revision=? AND COALESCE(t.external_id,t.id)=?`).get(this.companion,conversation,input.branch_id,input.chain_revision,input.turn_id);
    requireState(row && row.payload_sha256===observationHash(input),'STALE_INPUT','Job input is no longer the current observed turn');
    return input;
  }
}
