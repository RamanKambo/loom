import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildExportBundle, canonicalHash, exactExport } from '@loom/core';
import { applyFederation, checkFederation, inspectFederation, planFederation, recoverFederation, sourceSnapshot } from '../composition.js';
import { scaffoldConfig, scaffoldModel, scaffoldState } from '../init.js';
import { commitAll, gitInit, scratch, writeJson } from '../testing/helpers.js';

function fixture() {
  const root=gitInit(scratch()),child=gitInit(join(root,'child'));
  const cm=scaffoldModel(),cc=scaffoldConfig('child','implementation');
  cc.scope={workspace:['src']};mkdirSync(join(child,'src'));
  writeJson(join(child,'.loom','loom.json'),cc);writeJson(join(child,'.loom','model.json'),cm);writeJson(join(child,'.loom','state.json'),scaffoldState());
  const commit=commitAll(child,'child source');
  const bundle=buildExportBundle(cm,{modelId:'child',publisher:'child',contract:'public',version:1,sourceCommit:commit});
  const config=scaffoldConfig('parent','composition');config.scope={};config.composition={members:[{memberId:'child',modelId:'child',repositoryPath:'child',relationship:'implementation',exports:[{publisher:'child',contract:'public',version:1,digest:bundle.digest,schemaVersion:1,sourceCommit:commit}]}],delegatedRoots:[{memberId:'child',roots:['child/src']}],outputClaims:[]};
  writeJson(join(root,'.loom','loom.json'),config);writeJson(join(root,'.loom','model.json'),scaffoldModel());writeJson(join(root,'.loom','state.json'),scaffoldState());
  writeJson(join(root,'.loom','contracts','child','public@1.json'),bundle);
  return{root,child,config,bundle};
}
test('nested real repositories resolve exact exports; incorrect digest remains stale',()=>{
  const f=fixture();assert.equal(inspectFederation(f.root).data.members[0]?.status,'resolved');
  const pin=f.config.composition!.members[0]!.exports[0]!;assert.ok(exactExport(pin,[f.bundle]));
  pin.digest=canonicalHash('wrong');writeJson(join(f.root,'.loom','loom.json'),f.config);
  assert.equal(inspectFederation(f.root).data.members[0]?.status,'stale');assert.equal(checkFederation(f.root).ready,false);
});
test('missing checkout blocks composed readiness',()=>{
  const f=fixture();f.config.composition!.members[0]!.repositoryPath='missing';writeJson(join(f.root,'.loom','loom.json'),f.config);
  assert.equal(checkFederation(f.root).ready,false);assert.equal(inspectFederation(f.root).data.members[0]?.status,'missing');
});
test('planning is read-only; applying journals the write and is idempotent',async()=>{
  const f=fixture(),before=readFileSync(join(f.root,'.loom','loom.json'),'utf8'),check=checkFederation(f.root);
  assert.ok(check.data);const planned=planFederation(f.root,[{change:'claimOutput',path:'artifacts'}],check.data.snapshotDigest);assert.ok(planned.data);
  assert.equal(readFileSync(join(f.root,'.loom','loom.json'),'utf8'),before);assert.equal(existsSync(join(f.root,'.loom','federation')),false);
  const result=await applyFederation(f.root,planned.data.proposalId);assert.equal(result.data.state,'complete');assert.equal(result.findings.length,0);
  assert.equal((await applyFederation(f.root,planned.data.proposalId)).data.state,'complete');
});
test('interrupted journal blocks readiness and recovery preserves external edits',async()=>{
  const f=fixture(),check=checkFederation(f.root);assert.ok(check.data);
  const p=planFederation(f.root,[{change:'claimOutput',path:'artifacts'}],check.data.snapshotDigest);assert.ok(p.data);await applyFederation(f.root,p.data.proposalId);
  const jp=join(f.root,'.loom','federation',`${p.data.proposalId}.journal.json`),journal=JSON.parse(readFileSync(jp,'utf8'));journal.state='recovery-required';writeJson(jp,journal);
  const configPath=join(f.root,'.loom','loom.json');writeFileSync(configPath,'external edit\n');
  assert.equal(checkFederation(f.root).ready,false);
  const result=await recoverFederation(f.root,p.data.proposalId,'restore');assert.equal(result.data.state,'recovery-required');assert.equal(readFileSync(configPath,'utf8'),'external edit\n');
});
test('parent unrestricted source ownership and output collisions stay refused',()=>{
  const f=fixture();f.config.scope={workspace:['.']};f.config.composition!.outputClaims=['child/artifacts'];writeJson(join(f.root,'.loom','loom.json'),f.config);
  const cc=scaffoldConfig('child','implementation');cc.scope={workspace:['src']};cc.composition={members:[],delegatedRoots:[],outputClaims:['artifacts']};writeJson(join(f.child,'.loom','loom.json'),cc);
  assert.ok(inspectFederation(f.root).findings.filter(f=>f.code==='SCOPE_OVERLAP').length>=2);
});
test('source snapshots hash byte inputs and report untracked owned source as dirty',()=>{
  const f=fixture(),clean=sourceSnapshot(f.child);assert.equal(clean.dirty,false);assert.equal(clean.repositoryIdentity,'child');assert.ok(clean.inputFiles.every(i=>!i.path.includes(':')&&!i.path.startsWith('/')));
  writeFileSync(join(f.child,'src','new.bin'),new Uint8Array([0,255,128]));const dirty=sourceSnapshot(f.child);assert.equal(dirty.dirty,true);assert.notEqual(dirty.contentDigest,clean.contentDigest);assert.ok(dirty.inputFiles.some(i=>i.path==='src/new.bin'));
});
