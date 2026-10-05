import { defaultStates, envelope, refusal, validationState } from '@loom/core';
import type { FederationInput, ResultEnvelope, Model } from '@loom/core';
import { applyFederation, checkFederation, inspectFederation, planFederation, publishFederation, openSession, stampSession } from '@loom/workspace';
import { handlesOf } from './tools.js';
import type { ToolContext } from './tools.js';

interface FederationCall { args:Record<string,unknown>; context:ToolContext; model:Model|null; stamp(env:ResultEnvelope):ResultEnvelope }
/** Per-session handles select authority; every action uses the same filesystem adapter as the CLI. */
export async function federationCall(c:FederationCall):Promise<ResultEnvelope>{
  const input=c.args as unknown as FederationInput,registry=handlesOf(c.context),workspace=registry.resolve(input.workspaceId);
  if(!workspace)return envelope('loom.federation',{model:null,findings:[],refusal:refusal('unresolved-context','open this workspace in this session before using federation')});
  if((input.action==='apply'&&!registry.can(input.workspaceId,'edit'))||(input.action==='publish'&&!registry.can(input.workspaceId,'publish')))return envelope('loom.federation',{model:workspace.model,findings:[],refusal:refusal('access-denied',`the workspace handle does not grant ${input.action==='publish'?'publish':'edit'} access`)});
  const finish=(data:unknown,findings:ReturnType<typeof inspectFederation>['findings'],ready?:boolean):ResultEnvelope=>{
    const state=defaultStates(validationState(findings));if(ready!==undefined)state.readiness={state:ready?'ready':'blocked',reasons:findings.filter(f=>f.severity==='error').map(f=>({code:f.code,message:f.message,refs:f.refs??[]}))};
    const session=openSession(workspace.root);return stampSession(envelope('loom.federation',{model:session.model,findings,states:state,data}),session);
  };
  try{switch(input.action){
    case 'inspect':{const r=inspectFederation(workspace.root);return finish(r.data,r.findings);}
    case 'plan':{const r=planFederation(workspace.root,input.changes!,input.expectedVector!);return r.data?finish(r.data,r.findings):envelope('loom.federation',{model:workspace.model,findings:r.findings,refusal:refusal(r.findings.some(f=>f.message.includes('stale'))?'stale-base':'policy-failure','the proposal could not be planned against these inputs')});}
    case 'apply':{const r=await applyFederation(workspace.root,input.proposalId!);const checked=checkFederation(workspace.root);if(r.data.state!=='complete')return envelope('loom.federation',{model:workspace.model,findings:r.findings,refusal:refusal('recovery-required','the federation journal requires recovery'),data:{proposalId:input.proposalId,journal:r.data,revisionVector:checked.data?.snapshotDigest??r.data.inputDigest}});return finish({proposalId:input.proposalId,journal:r.data,revisionVector:checked.data!.snapshotDigest},r.findings);}
    case 'check':{const r=checkFederation(workspace.root,input.snapshotDigest);if(!r.data)return envelope('loom.federation',{model:workspace.model,findings:r.findings,refusal:refusal('unresolved-context','composition inputs could not be loaded')});return finish(r.data,r.findings,r.ready);}
    case 'publish':{const r=await publishFederation(workspace.root,{purpose:input.purpose!,contract:input.export!.contract,version:input.export!.version,records:input.export!.records,kind:workspace.config.modelKind==='composition'?'agreement':'export'});return r.data?finish(r.data,r.findings):envelope('loom.federation',{model:workspace.model,findings:r.findings,refusal:refusal('policy-failure','publication requires immutable complete qualified inputs')});}
  }}catch(error){const message=error instanceof Error?error.message:String(error);return envelope('loom.federation',{model:workspace.model,findings:[],refusal:refusal(message.includes('stale')?'stale-base':message.includes('external edit')?'recovery-required':'invalid-input',message)});}
}
