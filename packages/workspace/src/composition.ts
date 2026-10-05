import { existsSync, readFileSync, readdirSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { canonicalHash, textHash, CONTRACT_DIGEST, schemaErrors, diff, changeImpact, invalidatedBy, compareBaseline, makeMaturity, evaluateEvidence, deriveObligations } from '@loom/core';
import type { ChangeProposal, FederationChange, FederationJournal, FederationInspectData, FederationPublishData, CompositionRelease, ContractPin, ExportBundle, AgreementBundle, Finding, RecordRef, SourceSnapshot } from '@loom/core';
import { buildAgreementBundle, buildExportBundle, resolveComposition, exactExport, type CompositionModel } from '@loom/core';
import { openWorkspace, type Workspace } from './config.js';
import { finding, hasErrors } from './findings.js';
import { readJson, writeFileAtomic } from './fsx.js';
import { containsPath, realPathOf, relativePathProblem } from './paths.js';
import { headRevision, isDirty, isRepositoryRoot, trackedPaths, untrackedPaths } from './repo.js';
import { withLock } from './lock.js';
import { gatherEvaluationInputs, policyHash } from './trust.js';

export const FEDERATION_DIR = 'federation';
export function compositionModels(root:string):{models:CompositionModel[];findings:Finding[]}{const loaded=load(root);return{models:loaded.members,findings:loaded.findings};}
/** Byte-addressed source identity, including untracked owned inputs and no absolute checkout paths. */
export function sourceSnapshot(root:string):SourceSnapshot {
  const workspace=openWorkspace(root).value;if(!workspace)throw new Error('cannot snapshot an unreadable workspace');
  const files=new Set<string>(workspace.roots.flatMap(r=>trackedPaths(root,r.rel)));
  for(const source of workspace.roots)for(const file of untrackedPaths(root,source.rel))files.add(file);
  files.add('.loom/loom.json');files.add(relative(root,workspace.modelPath).replaceAll('\\','/'));
  const modelRel=relative(root,workspace.modelPath).replaceAll('\\','/'),isInput=(p:string)=>!p.startsWith('.loom/')||p==='.loom/loom.json'||p===modelRel;
  const inputFiles=[...files].sort().filter(p=>isInput(p)&&!relativePathProblem(p)&&existsSync(join(root,p))&&statSync(join(root,p)).isFile()&&containsPath(realPathOf(root),realPathOf(join(root,p)))).map(path=>({path,hash:`sha256:${createHash('sha256').update(readFileSync(join(root,path))).digest('hex')}`}));
  const tracked=new Set(trackedPaths(root,'.'));
  const snapshot:SourceSnapshot={modelId:workspace.config.modelId,repositoryIdentity:workspace.config.modelId,commit:headRevision(root)??'',contentDigest:canonicalHash(inputFiles),dirty:isDirty(root)||inputFiles.some(f=>!tracked.has(f.path)),inputFiles};
  if(schemaErrors('SourceSnapshot',snapshot).length)throw new Error('source snapshot requires a committed repository and valid input paths');return snapshot;
}
interface Loaded { workspaces: Workspace[]; members: CompositionModel[]; bundles: ExportBundle[]; agreementBundles: AgreementBundle[]; journals: FederationJournal[]; findings: Finding[] }
const fileHash = (path: string): string | null => existsSync(path) ? textHash(readFileSync(path, 'utf8')) : null;
const fail = (message: string, code: Finding['code'] = 'CONFIG_INVALID'): Finding => finding(code, '.loom/composition', message, 'restore the declared composition inputs and retry');
const pinnedPath = (root: string, pin: ContractPin): string => join(root, '.loom', 'contracts', pin.publisher, `${pin.contract}@${pin.version}.json`);
function load(root: string): Loaded {
  const out: Loaded = { workspaces: [], members: [], bundles: [], agreementBundles: [], journals: [], findings: [] };
  const seen = new Set<string>();
  function visit(path: string, stack: string[]): void {
    const real = realPathOf(path);
    if (stack.includes(real)) { out.findings.push(fail(`membership cycle ${[...stack, real].join(' -> ')}`)); return; }
    if (stack.length > 32 || seen.size > 128) { out.findings.push(fail('composition traversal limit exceeded')); return; }
    if (seen.has(real)) return;
    seen.add(real);
    const opened = openWorkspace(path); out.findings.push(...opened.findings);
    if (!opened.value) return;
    const w = opened.value; out.workspaces.push(w);
    const trusted=gatherEvaluationInputs(w.root);
    out.bundles.push(...(trusted.inputs.publishedContracts??[]));
    out.members.push({ modelId: w.config.modelId, config: w.config, model: w.model, policyHash: trusted.inputs.policy?policyHash(trusted.inputs.policy):null });
    const dir = join(w.loomDir, FEDERATION_DIR);
    if (existsSync(dir)) for (const file of readdirSync(dir).filter(f => f.endsWith('.journal.json'))) {
      const r = readJson(join(dir,file));
      if (r.ok && !schemaErrors('FederationJournal',r.value).length) out.journals.push(r.value as FederationJournal);
      else out.findings.push(fail(`invalid federation journal ${file}`));
    }
    for (const member of w.config.composition?.members ?? []) {
      if (relativePathProblem(member.repositoryPath)) { out.findings.push(fail(`invalid member path ${member.repositoryPath}`)); continue; }
      const child = resolve(path, member.repositoryPath);
      if (!containsPath(real, realPathOf(child)) || realPathOf(child) === real) { out.findings.push(fail(`member ${member.memberId} escapes parent or claims itself`)); continue; }
      if (!existsSync(child) || !isRepositoryRoot(child)) { out.findings.push(fail(`member checkout ${member.repositoryPath} is missing`, 'PUBLISHED_CONTRACT_UNRESOLVED')); continue; }
      const co = openWorkspace(child);
      if (co.value && co.value.config.modelId !== member.modelId) out.findings.push(fail(`member ${member.memberId} identity differs from its descriptor`));
      for (const pin of member.exports) {
        const r = readJson(pinnedPath(path,pin));
        if (r.ok && !schemaErrors('PublishedContract',r.value).length) { const b = r.value as ExportBundle; out.bundles.push(b); if (b.agreementBundle) { const a = readJson(pinnedPath(child,b.agreementBundle)); if(a.ok && !schemaErrors('AgreementBundle',a.value).length) out.agreementBundles.push(a.value as AgreementBundle); } }
        else out.findings.push(fail(`missing export ${pin.publisher}/${pin.contract}@${pin.version}`, 'PUBLISHED_CONTRACT_UNRESOLVED'));
      }
      visit(child,[...stack,real]);
    }
  }
  visit(resolve(root),[]);
  const source = out.workspaces.flatMap(w => w.roots.map(r => ({ owner: w.config.modelId, path: r.real })));
  const output = out.workspaces.flatMap(w => (w.config.composition?.outputClaims ?? []).map(p => ({ owner: w.config.modelId, path: realPathOf(resolve(w.root,p)) })));
  for (const claims of [source,output]) for (let i=0;i<claims.length;i++) for(let j=i+1;j<claims.length;j++) if(claims[i]!.owner !== claims[j]!.owner && (containsPath(claims[i]!.path,claims[j]!.path)||containsPath(claims[j]!.path,claims[i]!.path))) out.findings.push(fail(`exclusive ownership overlap between ${claims[i]!.owner} and ${claims[j]!.owner}`, 'SCOPE_OVERLAP'));
  return out;
}

export function inspectFederation(root: string): { data: FederationInspectData; findings: Finding[] } {
  const loaded = load(root), parent = loaded.workspaces[0];
  const declared = parent?.config.composition?.members ?? [];
  const members: FederationInspectData['members'] = declared.map(m => ({ memberId:m.memberId,modelId:m.modelId,relationship:m.relationship,exports:m.exports, status: !loaded.members.some(w=>w.modelId===m.modelId) ? 'missing' : m.exports.some(p=>!exactExport(p,loaded.bundles)) ? 'stale' : 'resolved' }));
  return { data: { members, ownership: loaded.workspaces.map(w=>({modelId:w.config.modelId, sourceRoots:w.roots.map(r=>relative(root,r.real).replaceAll('\\','/')||'.'),delegatedRoots:(w.config.composition?.delegatedRoots??[]).flatMap(d=>d.roots.map(p=>relative(root,resolve(w.root,p)).replaceAll('\\','/'))),outputRoots:(w.config.composition?.outputClaims??[]).map(p=>relative(root,resolve(w.root,p)).replaceAll('\\','/'))})),missing:members.filter(m=>m.status!=='resolved').map(m=>({modelId:m.modelId,input:m.status==='missing'?'checkout':'export',reason:`member is ${m.status}`})),graph:{nodes:loaded.members.map(m=>m.modelId).sort(),edges:loaded.members.flatMap(w=>(w.config.composition?.members??[]).flatMap(m=>m.exports.map(pin=>({from:w.modelId,to:m.modelId,pin}))))}},findings:loaded.findings };
}

export function checkFederation(root: string, snapshotDigest?: string, release?: CompositionRelease) {
  const loaded=load(root), parent=loaded.members[0];
  if(!parent) return { data:null, findings:loaded.findings,ready:false };
  if(!release&&existsSync(join(root,'.loom','composition-release.json'))){const rr=readJson(join(root,'.loom','composition-release.json'));if(rr.ok&&!schemaErrors('CompositionRelease',rr.value).length)release=rr.value as CompositionRelease;else loaded.findings.push(fail('stored composition release is malformed'));}
  const result=resolveComposition({...parent,members:loaded.members.slice(1),bundles:loaded.bundles,agreementBundles:loaded.agreementBundles,journals:loaded.journals,findings:loaded.findings,bindings:release?.agreements??[]});
  if(parent.config.composition?.members.length)for(const workspace of loaded.workspaces){const inputs=gatherEvaluationInputs(workspace.root).inputs;if(workspace!==loaded.workspaces[0]&&workspace.config.modelKind!=='composition'){const maturity=makeMaturity(workspace.model,inputs);for(const component of workspace.model.components)if(maturity({kind:'component',id:component.id})!=='qualified')result.findings.push(fail(`implementation ${workspace.config.modelId}/${component.id} is not qualified`));}if(workspace===loaded.workspaces[0]){const evaluated=evaluateEvidence(workspace.model,deriveObligations(workspace.model,undefined,inputs),inputs);result.findings.push(...evaluated.findings);}}
  if(snapshotDigest && snapshotDigest!==result.snapshotDigest) result.findings.push(fail('composition snapshot digest is stale'));
  if(release) {
    if(release.revisionVectorDigest!==result.snapshotDigest||canonicalHash(release.members)!==canonicalHash(parent.config.composition?.members??[])) result.findings.push(fail('release selection differs from complete composition snapshot'));
    if(!release.evidenceRefs.length||!release.acceptanceRefs.length) result.findings.push(fail('release requires qualified evidence and acceptance'));
    const inputs=loaded.workspaces.flatMap(w=>[gatherEvaluationInputs(w.root).inputs]);
    for(const id of release.evidenceRefs)if(!inputs.some(i=>i.evidence?.some(e=>e.trusted&&e.record.id===id&&e.record.result==='PASS')))result.findings.push(fail(`release evidence ${id} is absent, untrusted or failing`));
    for(const id of release.acceptanceRefs)if(!inputs.some(i=>i.acceptances?.some(a=>a.trusted&&a.record.id===id)))result.findings.push(fail(`release acceptance ${id} is absent or untrusted`));
  }
  return {data:{snapshotDigest:result.snapshotDigest,revisionVector:result.revisionVector,closure:result.closure},findings:result.findings,ready:!hasErrors(result.findings)};
}

interface Staged { proposal: ChangeProposal; contents: {path:string;owner:string;before:string|null;after:string}[] }
const pendingProposals = new Map<string,Staged>();
/** Portable staged payload, explicitly exported by the caller; plan itself writes nothing. */
export function exportFederationProposal(root:string,proposalId:string):Staged {
  const staged=pendingProposals.get(`${realPathOf(root)}/${proposalId}`);if(!staged)throw new Error('proposal is not held by this session');return structuredClone(staged);
}
export function importFederationProposal(root:string,payload:unknown):ChangeProposal {
  const staged=payload as Partial<Staged>;
  if(!staged||!staged.proposal||schemaErrors('ChangeProposal',staged.proposal).length||!Array.isArray(staged.contents))throw new Error('invalid federation proposal payload');
  if(staged.contents.length!==staged.proposal.writes.length)throw new Error('proposal content is incomplete');
  for(const write of staged.proposal.writes){const c=staged.contents.find(c=>c.path===write.path&&c.owner===write.owner);if(!c||typeof c.after!=='string'||(c.before!==null&&typeof c.before!=='string')||textHash(c.after)!==write.expectedNew||(c.before===null?null:textHash(c.before))!==write.expectedOld)throw new Error('proposal content hashes do not match writes');}
  pendingProposals.set(`${realPathOf(root)}/${staged.proposal.proposalId}`,structuredClone(staged as Staged));return staged.proposal;
}
export function planFederation(root: string, changes: FederationChange[], expectedVector: string): { data:ChangeProposal|null;findings:Finding[] } {
  const checked=checkFederation(root), opened=openWorkspace(root);
  if(!checked.data||!opened.value) return {data:null,findings:[...checked.findings,...opened.findings]};
  if(expectedVector!==checked.data.snapshotDigest) return {data:null,findings:[fail('expected revision vector is stale')]};
  const w=opened.value, config=structuredClone(w.config), model=structuredClone(w.model);
  config.composition??={members:[],delegatedRoots:[],outputClaims:[]};
  for(const change of changes) switch(change.change) {
    case 'addMember': config.composition.members.push(change.member); break;
    case 'removeMember': config.composition.members=config.composition.members.filter(m=>m.memberId!==change.memberId);config.composition.delegatedRoots=config.composition.delegatedRoots.filter(m=>m.memberId!==change.memberId);break;
    case 'setAgreement': model.agreements=model.agreements.filter(a=>a.id!==change.agreement.id);model.agreements.push(change.agreement);break;
    case 'removeAgreement': model.agreements=model.agreements.filter(a=>a.id!==change.agreementId);break;
    case 'pinExport': {const m=config.composition.members.find(m=>m.memberId===change.memberId);if(!m)return{data:null,findings:[fail(`unknown member ${change.memberId}`)]};m.exports=m.exports.filter(p=>!(p.publisher===change.pin.publisher&&p.contract===change.pin.contract));m.exports.push(change.pin);break;}
    case 'unpinExport': {const m=config.composition.members.find(m=>m.memberId===change.memberId);if(!m)return{data:null,findings:[fail(`unknown member ${change.memberId}`)]};m.exports=m.exports.filter(p=>canonicalHash(p)!==canonicalHash(change.pin));break;}
    case 'claimOutput': config.composition.outputClaims.push(change.path);break;
    case 'releaseOutput': config.composition.outputClaims=config.composition.outputClaims.filter(p=>p!==change.path);break;
  }
  const errors=[...schemaErrors('LoomConfig',config),...schemaErrors('Model',model)];
  if(errors.length)return{data:null,findings:[fail(errors.map(e=>e.message).join('; '))]};
  const contents=[{path:'.loom/loom.json',owner:config.modelId,before:readFileSync(join(w.loomDir,'loom.json'),'utf8'),after:JSON.stringify(config,null,2)+'\n'},{path:relative(root,w.modelPath).replaceAll('\\','/'),owner:config.modelId,before:readFileSync(w.modelPath,'utf8'),after:JSON.stringify(model,null,2)+'\n'}].filter(c=>c.before!==c.after);
  if(!contents.length)return{data:null,findings:[fail('proposal has no owner-local changes')]};
  const trusted=gatherEvaluationInputs(root).inputs,comparison=compareBaseline(model,trusted),delta=diff(w.model,model);
  const affected=changeImpact(w.model,model,delta.map(c=>({kind:c.elementKind,id:c.element})));
  const proposal:ChangeProposal={proposalId:`change-${canonicalHash({expectedVector,changes}).slice(7,23)}`,inputDigest:canonicalHash({expectedVector,changes}),revisionVector:checked.data.revisionVector,writes:contents.map(c=>({owner:c.owner,repositoryPath:'.',path:c.path,expectedOld:textHash(c.before),expectedNew:textHash(c.after)})),impact:affected.map(a=>({modelId:config.modelId,affected:a})),invalidatedEvidence:invalidatedBy(w.model,model,trusted).map(invalidation=>({modelId:config.modelId,invalidation})),requiredAcceptance:comparison.acceptanceRequired||comparison.findings.some(f=>f.code==='FROZEN_COMPONENT_CHANGED')?[{owner:config.modelId,changeClasses:comparison.changeClasses.length?comparison.changeClasses:['frozen-component']}]:[]};
  const loaded=load(root),affectedOwners=new Set<string>([config.modelId]);
  for(const change of changes){if('memberId'in change){const member=w.config.composition?.members.find(m=>m.memberId===change.memberId);if(member)affectedOwners.add(member.modelId);}if(change.change==='setAgreement')for(const address of [...change.agreement.providers,...change.agreement.consumers])affectedOwners.add(address.modelId);}
  let expanded=true;while(expanded){expanded=false;for(const owner of loaded.members)if((owner.config.composition?.members??[]).some(m=>affectedOwners.has(m.modelId))&&!affectedOwners.has(owner.modelId)){affectedOwners.add(owner.modelId);expanded=true;}}
  for(const owner of loaded.workspaces.filter(w=>affectedOwners.has(w.config.modelId))){const inputs=gatherEvaluationInputs(owner.root).inputs;for(const component of owner.model.components){if(!proposal.impact.some(i=>i.modelId===owner.config.modelId&&i.affected.ref.kind==='component'&&i.affected.ref.id===component.id))proposal.impact.push({modelId:owner.config.modelId,affected:{ref:{kind:'component',id:component.id},reason:'depends-on',path:[config.modelId,component.id]}});if(inputs.baseline?.record.components.some(c=>c.id===component.id&&(c.frozen||inputs.policy?.freeze?.onAcceptance))&&!proposal.requiredAcceptance.some(a=>a.owner===owner.config.modelId))proposal.requiredAcceptance.push({owner:owner.config.modelId,changeClasses:['frozen-component']});}if(canonicalHash(config)!==canonicalHash(w.config))for(const evidence of inputs.evidence??[])if(evidence.trusted&&!proposal.invalidatedEvidence.some(e=>e.modelId===owner.config.modelId&&e.invalidation.evidence===evidence.record.id))proposal.invalidatedEvidence.push({modelId:owner.config.modelId,invalidation:{evidence:evidence.record.id,reason:'composition membership, export pin or output ownership changed',inputs:['composition']}});}
  const staged:Staged={proposal,contents};
  pendingProposals.set(`${realPathOf(root)}/${proposal.proposalId}`,staged);
  return {data:proposal,findings:[]};
}

async function locks<T>(roots:string[], action:()=>T):Promise<T> { if(!roots.length)return action();const held=await withLock(join(roots[0]!,'.loom','cache','model.lock'),()=>locks(roots.slice(1),action));if(!held.ok)throw new Error(`repository lock held by ${held.holder}`);return await held.value; }
export async function applyFederation(root:string,proposalId:string):Promise<{data:FederationJournal;findings:Finding[]}> {
  const staged=pendingProposals.get(`${realPathOf(root)}/${proposalId}`);
  if(staged){ const checked=checkFederation(root);if(!checked.data||canonicalHash(checked.data.revisionVector)!==canonicalHash(staged.proposal.revisionVector))throw new Error('proposal revision vector is stale');writeFileAtomic(join(root,'.loom',FEDERATION_DIR,`${proposalId}.proposal.json`),JSON.stringify(staged,null,2)+'\n'); }
  const result=await recoverFederation(root,proposalId,'resume');if(result.data.state==='complete')pendingProposals.delete(`${realPathOf(root)}/${proposalId}`);return result;
}
export async function recoverFederation(root:string,proposalId:string,mode:'resume'|'restore'='resume'):Promise<{data:FederationJournal;findings:Finding[]}> {
  if(!/^[A-Za-z0-9_.-]+$/.test(proposalId))throw new Error('invalid proposal identifier');
  const dir=join(root,'.loom',FEDERATION_DIR),stage=readJson(join(dir,`${proposalId}.proposal.json`));if(!stage.ok)throw new Error('staged proposal is missing');
  const staged=stage.value as Staged, journalFile=join(dir,`${proposalId}.journal.json`);
  const jr=readJson(journalFile);let journal:FederationJournal=jr.ok?jr.value as FederationJournal:{journalVersion:1,proposalId,inputDigest:staged.proposal.inputDigest,state:'prepared',writes:staged.proposal.writes.map(write=>({write,status:'pending'}))};
  const roots=[...new Set(journal.writes.map(r=>realPathOf(resolve(root,r.write.repositoryPath))))].sort();
  return locks(roots,()=>{
    const findings:Finding[]=[];
    const save=()=>writeFileAtomic(journalFile,JSON.stringify(journal,null,2)+'\n');
    if(journal.state==='complete')return{data:journal,findings};
    if(journal.state==='prepared') {const checked=checkFederation(root);if(!checked.data||canonicalHash(checked.data.revisionVector)!==canonicalHash(staged.proposal.revisionVector))throw new Error('proposal revision vector changed before repository locks were acquired');}
    for(const requirement of staged.proposal.requiredAcceptance){const owner=load(root).workspaces.find(w=>w.config.modelId===requirement.owner);if(!owner)throw new Error('required acceptance owner is missing');const candidate=staged.contents.find(c=>c.owner===requirement.owner&&resolve(owner.root,c.path)===owner.modelPath);const comparison=compareBaseline(candidate?JSON.parse(candidate.after):owner.model,gatherEvaluationInputs(owner.root).inputs);if(comparison.acceptanceRequired||comparison.findings.some(f=>f.code==='FROZEN_COMPONENT_CHANGED'||f.code==='CHANGE_UNACCEPTED'||f.code==='CHANGE_PROHIBITED'))throw new Error(`owner ${requirement.owner} requires trusted acceptance of this proposal`);}
    journal.state='applying';save();
    try {
      for(const item of journal.writes) {
        const write=item.write, repo=realPathOf(resolve(root,write.repositoryPath)), path=resolve(repo,write.path);
        if(relativePathProblem(write.path)||!containsPath(realPathOf(root),repo)||!containsPath(repo,realPathOf(path))||!write.path.startsWith('.loom/'))throw new Error('federation write escapes its owner-local model directory');
        const owner=openWorkspace(repo).value;
        if(!owner||owner.config.modelId!==write.owner||(path!==join(owner.loomDir,'loom.json')&&path!==owner.modelPath))throw new Error('federation write does not name its declared owner model or configuration');
        const content=staged.contents.find(c=>c.path===write.path&&c.owner===write.owner);
        if(!content||textHash(content.after)!==write.expectedNew||(content.before===null?null:textHash(content.before))!==write.expectedOld)throw new Error('staged content differs from journal hashes');
        const actual=fileHash(path);
        if(mode==='restore') { if(actual===write.expectedOld){item.status='restored';save();continue;}if(actual!==write.expectedNew)throw new Error(`external edit at ${write.path}; recovery refused`);if(content.before===null)throw new Error('restoring created files requires explicit deletion recovery');writeFileAtomic(path,content.before);item.status='restored'; }
        else { if(actual===write.expectedNew){item.status='applied';save();continue;}if(actual!==write.expectedOld)throw new Error(`external edit at ${write.path}; recovery refused`);writeFileAtomic(path,content.after);item.status='applied'; }
        save();
      }
      journal.state='complete';save();
    } catch(err){journal.state='recovery-required';save();findings.push(fail(err instanceof Error?err.message:String(err)));}
    return {data:journal,findings};
  });
}

export interface FederationPublishOptions {purpose:'draft'|'release';contract:string;version:number;publisher?:string;kind?:'export'|'agreement';agreementBundle?:ContractPin;records?:RecordRef[]}
export async function publishFederation(root:string,options:FederationPublishOptions):Promise<{data:FederationPublishData|null;findings:Finding[]}>{return locks([realPathOf(root)],()=>publishLocked(root,options));}
function publishLocked(root:string,options:FederationPublishOptions):{data:FederationPublishData|null;findings:Finding[]} {
  const opened=openWorkspace(root);if(!opened.value)return{data:null,findings:opened.findings};const w=opened.value;
  if(options.purpose==='release') {
    if(sourceSnapshot(root).dirty)return{data:null,findings:[fail('dirty source snapshot cannot be published as a release')]};
    const checked=checkFederation(root), trust=gatherEvaluationInputs(root);
    if(!checked.ready||!trust.inputs.acceptances?.some(a=>a.trusted)||!trust.inputs.evidence?.some(e=>e.trusted))return{data:null,findings:[...checked.findings,fail('release requires complete composition, trusted acceptance and evidence')]};
  }
  const identity={modelId:w.config.modelId,publisher:options.publisher??w.config.modelId,contract:options.contract,version:options.version,sourceCommit:headRevision(root)??''};
  const resolved=gatherEvaluationInputs(root).inputs.publishedContracts??[];
  const imports:ContractPin[]=w.model.publishedContracts.flatMap(p=>{const b=resolved.find(b=>b.publisher===p.publisher&&b.contract===p.contract&&b.version===p.version&&b.digest===p.digest&&canonicalHash(b.content)===p.digest);return b?.sourceCommit?[{publisher:p.publisher,contract:p.contract,version:p.version,digest:p.digest,schemaVersion:p.schemaVersion,sourceCommit:b.sourceCommit}]:[];});
  if(options.purpose==='release'&&imports.length!==w.model.publishedContracts.length)return{data:null,findings:[fail('every upstream export requires an exact source commit before release publication')]};
  const bundle=options.kind==='agreement'?buildAgreementBundle(w.model,identity):buildExportBundle(w.model,{...identity,imports,...(options.agreementBundle?{agreementBundle:options.agreementBundle}:{}),...(options.records?{roots:options.records}:{})});
  const errors=schemaErrors(options.kind==='agreement'?'AgreementBundle':'PublishedContract',bundle);if(errors.length)return{data:null,findings:[fail(errors.map(e=>e.message).join('; '))]};
  const path=join(w.loomDir,options.purpose==='draft'?'drafts':'contracts',bundle.publisher,`${bundle.contract}@${bundle.version}.json`);
  if(existsSync(path)&&canonicalHash(JSON.parse(readFileSync(path,'utf8')))!==canonicalHash(bundle))return{data:null,findings:[fail('published bundle is immutable; use a new version')]};
  writeFileAtomic(path,JSON.stringify(bundle,null,2)+'\n');return{data:{purpose:options.purpose,bundle},findings:[]};
}
