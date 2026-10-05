import { readFileSync,writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultStates,envelope,refusal,validationState } from '@loom/core';
import type { FederationChange,RecordRef } from '@loom/core';
import { applyFederation,checkFederation,exportFederationProposal,importFederationProposal,inspectFederation,planFederation,publishFederation,openSession,stampSession,recoverFederation } from '@loom/workspace';
import { flag,required,UsageError } from './args.js';
import type { Context,CommandResult } from './commands.js';

export async function cmdFederation(ctx:Context):Promise<CommandResult>{
  const session=openSession(ctx.cwd),workspace=session.workspace;
  if(!workspace)return{env:envelope('loom.federation',{model:null,findings:session.findings,refusal:refusal('unresolved-context','run federation inside its owning workspace')})};
  const action=ctx.args.positionals[0]??'inspect';
  const read=(name:string):unknown=>JSON.parse(readFileSync(resolve(ctx.cwd,required(ctx.args,name)),'utf8'));
  const finish=(data:unknown,findings:ReturnType<typeof inspectFederation>['findings'],ready?:boolean):CommandResult=>{const state=defaultStates(validationState(findings));if(ready!==undefined)state.readiness={state:ready?'ready':'blocked',reasons:findings.filter(f=>f.severity==='error').map(f=>({code:f.code,message:f.message,refs:f.refs??[]}))};return{env:stampSession(envelope('loom.federation',{model:workspace.model,findings,states:state,data}),openSession(workspace.root))};};
  switch(action){
    case'inspect':{const r=inspectFederation(workspace.root);return finish(r.data,r.findings);}
    case'check':{const r=checkFederation(workspace.root,flag(ctx.args,'snapshot-digest'));return finish(r.data,r.findings,r.ready);}
    case'plan':{const r=planFederation(workspace.root,read('changes') as FederationChange[],required(ctx.args,'expected-vector'));const out=flag(ctx.args,'proposal-out');if(r.data&&out)writeFileSync(resolve(ctx.cwd,out),JSON.stringify(exportFederationProposal(workspace.root,r.data.proposalId),null,2)+'\n');return finish(r.data,r.findings);}
    case'apply':{const proposalFile=flag(ctx.args,'proposal');let id=flag(ctx.args,'proposal-id');if(proposalFile)id=importFederationProposal(workspace.root,read('proposal')).proposalId;if(!id)throw new UsageError('federation apply requires --proposal FILE or --proposal-id ID');const r=await applyFederation(workspace.root,id),checked=checkFederation(workspace.root);return finish({proposalId:id,journal:r.data,revisionVector:checked.data?.snapshotDigest??r.data.inputDigest},r.findings);}
    case'recover':{const mode=flag(ctx.args,'mode')??'resume';if(mode!=='resume'&&mode!=='restore')throw new UsageError('--mode must be resume or restore');const r=await recoverFederation(workspace.root,required(ctx.args,'proposal-id'),mode);return finish(r.data,r.findings);}
    case'publish':{const purpose=required(ctx.args,'purpose');if(purpose!=='draft'&&purpose!=='release')throw new UsageError('--purpose must be draft or release');const version=Number(required(ctx.args,'version'));if(!Number.isSafeInteger(version)||version<1)throw new UsageError('--version must be a positive integer');const records=flag(ctx.args,'records')?read('records') as RecordRef[]:undefined;const r=await publishFederation(workspace.root,{purpose,contract:required(ctx.args,'contract'),version,kind:workspace.config.modelKind==='composition'?'agreement':'export',...(records?{records}:{})});return finish(r.data,r.findings);}
    default:throw new UsageError(`unknown federation action ${action}`);
  }
}
