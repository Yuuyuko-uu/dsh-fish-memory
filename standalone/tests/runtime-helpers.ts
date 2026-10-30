import type { TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { RuntimeStore } from '../src/runtime/store.ts';
import type { ToolInput } from '../src/contracts/tools.ts';
import type { CandidatePatch, Episode, Evidence } from '../src/domain/memory.ts';
import type { JobLease } from '../src/db/jobs.ts';
import type { MessageRef } from '../src/domain/common.ts';

const cleanup=new WeakMap<TestContext,{closers:(()=>void|Promise<void>)[];roots:string[]}>();
function resources(t:TestContext) {
  let state=cleanup.get(t);
  if(!state) {
    state={closers:[],roots:[]}; cleanup.set(t,state);
    const owned=state;
    t.after(async()=>{
      for(const close of owned.closers.toReversed()) await close();
      for(const root of owned.roots) {
        if(dirname(resolve(root))!==resolve(tmpdir())) throw new Error('Unexpected cleanup target');
        rmSync(root,{recursive:true,force:true});
      }
    });
  }
  return state;
}
export function track(t:TestContext,close:()=>void|Promise<void>):void { resources(t).closers.push(close); }
export function temporary(t:TestContext):string {
  const root=mkdtempSync(join(tmpdir(),'fish-stage2-'));
  resources(t).roots.push(root);
  return root;
}
export function runtime(t:TestContext,extra: {fault?:(point:string)=>void}={}) {
  const home=join(temporary(t),'runtime'); let now=Date.parse('2026-10-30T12:00:00Z');
  const store=RuntimeStore.open(home,{initialize:true,clock:()=>new Date(now),...extra});
  track(t,()=>store.close());
  const credential=store.issueCredential('admin');
  return {home,store,credential,principal:store.authenticate(credential.token,'admin').id,
    clock:()=>new Date(now),advance:(milliseconds:number)=>{now+=milliseconds;}};
}
export function observation(sequence:number, text='今天在修改方案。'):ToolInput<'observe_turn'> {
  return {contract_version:'1.0.0',request_id:`request-${sequence}`,conversation_id:'conversation-test',branch_id:'main',chain_revision:1,
    turn_id:`turn-${sequence}`,sequence,messages:[
      {message_id:`user-${sequence}`,revision:1,position:0,role:'user',text,status:'complete',captured_at:`2026-10-30T09:${String(sequence).padStart(2,'0')}:00Z`},
      {message_id:`assistant-${sequence}`,revision:1,position:1,role:'assistant',text:'我在听。',status:'complete',captured_at:`2026-10-30T09:${String(sequence).padStart(2,'0')}:01Z`},
    ]};
}
export function ref(input:ToolInput<'observe_turn'>):MessageRef {
  const user=input.messages[0]!;
  return {conversation_id:input.conversation_id,branch_id:input.branch_id,turn_id:input.turn_id,sequence:input.sequence,message_id:user.message_id,revision:user.revision};
}
export function evidence(store:RuntimeStore,input:ToolInput<'observe_turn'>):Evidence {
  const user=input.messages[0]!;
  return {id:`evidence-${input.conversation_id}-${input.sequence}-${user.revision}`,companion_id:store.companion,
    source:{kind:'message',ref:ref(input)},speaker_actor_id:store.config.companion.user.id,quote:user.text,start:0,end:[...user.text].length};
}
export function candidate(store:RuntimeStore,lease:JobLease,input:ToolInput<'observe_turn'>, previous?:Episode, earlier:ToolInput<'observe_turn'>[]=[]):CandidatePatch {
  const e=evidence(store,input); const id=previous?.id??'temporary-episode';
  const record:Episode=previous?{...structuredClone(previous),version:previous.version+1,summary:input.messages[0]!.text,
    evidence_ids:[...previous.evidence_ids,e.id]}:{contract_version:'1.0.0',id,companion_id:store.companion,kind:'episode',version:1,suppression_generation:0,
    content_status:'active',publication_status:'published',created_at:'2026-10-30T12:00:00Z',updated_at:'2026-10-30T12:00:00Z',evidence_ids:[e.id],
    summary:input.messages[0]!.text,details:'',participant_ids:[store.config.companion.user.id],
    occurred:{precision:'unknown',start:null,end:null,basis:'unknown',evidence_ids:[]},topic_status:'ongoing',storage_tier:'hot',last_effective_mention_at:input.messages[0]!.captured_at,interpretations:[]};
  return {contract_version:'1.0.0',job_id:lease.job_id,request_id:`candidate-${input.sequence}`,companion_id:store.companion,
    input_watermark:{conversation_id:input.conversation_id,branch_id:input.branch_id,chain_revision:input.chain_revision,sequence:input.sequence},
    input_messages:[...earlier,input].map(ref),targets:previous?[{memory_id:previous.id,expected_version:previous.version,suppression_generation:previous.suppression_generation}]:[],
    source_guards:[],mutations:previous?[{operation:'revise',memory_id:id,record}]:[{operation:'create',temporary_id:id,record}],
    evidence:[e],links:[],reason:'合成工作进度与明确用户陈述。'};
}
