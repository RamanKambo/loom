import type { AgreementBinding, AgreementBundle, ContractPin, ExportBundle, FederationJournal, Finding, LoomConfig, Model, RecordAddress, RecordRef, ResolvedReference, RevisionVector } from './generated/types.js';
import { canonicalHash, modelRevision } from './hash.js';
import { deepClone } from './canonical.js';
import { CONTRACT_DIGEST } from './generated/digest.js';
import { COLLECTION_OF_KIND, findRecord, indexModel, resolveProperty } from './records.js';
import { collectReferences, resolveReference } from './refs.js';
import { importPinsOf, revisionVectorOf } from './imports.js';
import { validate } from './validate.js';
import { deriveObligations } from './evidence.js';

export interface BundleIdentity { modelId: string; publisher: string; contract: string; version: number; sourceCommit: string }
export interface ExportOptions extends BundleIdentity { agreementBundle?: ContractPin; roots?: RecordRef[]; imports?:ContractPin[] }
export interface CompositionModel { modelId: string; model: Model; config: LoomConfig; policyHash?: string | null; findings?: Finding[] }
export interface CompositionInput extends CompositionModel { members: CompositionModel[]; bundles: ExportBundle[]; agreementBundles?: AgreementBundle[]; bindings?: AgreementBinding[]; journals?: FederationJournal[]; maxDepth?: number; maxRecords?: number }
export interface CompositionResult { revisionVector: RevisionVector; snapshotDigest: string; closure: (RecordAddress | ResolvedReference)[]; findings: Finding[]; ready: boolean }
const addressKey = (a: RecordAddress): string => `${a.modelId}/${a.kind}/${a.id}`;
const failure = (path: string, message: string, code: Finding['code'] = 'PUBLISHED_CONTRACT_INCOMPATIBLE'): Finding => ({ code, severity: 'error', path, message, fix: 'restore the exact owner-published input and check the composition again' });

/** Agreement publication is downward and contains no member snapshots. */
export function buildAgreementBundle(model: Model, identity: BundleIdentity): AgreementBundle {
  const content = { bundleVersion: 1 as const, ...identity, schemaVersion: 1 as const, agreements: deepClone(model.agreements) };
  return { ...content, digest: canonicalHash(content) };
}

/** Export the transitive record dependencies of the requested public roots. */
export function buildExportBundle(model: Model, options: ExportOptions): ExportBundle {
  const index = indexModel(model), references = collectReferences(model);
  const selected = new Set<string>();
  const pending = options.roots ? [...options.roots] : [...model.types.map(r => ({ kind: 'type' as const, id: r.id })), ...model.operations.map(r => ({ kind: 'operation' as const, id: r.id })), ...model.routines.map(r => ({ kind: 'routine' as const, id: r.id }))];
  while (pending.length) {
    const ref = pending.pop()!;
    const key = `${ref.kind}/${ref.id}`;
    if (selected.has(key)) continue;
    if (findRecord(index, ref) === undefined) throw new Error(`export root or dependency ${key} is unresolved`);
    selected.add(key);
    for (const r of references.filter(r => r.holder.kind === ref.kind && r.holder.id === ref.id)) {
      const resolved = resolveReference(index, r);
      if (resolved.status === 'resolved' && resolved.ref.kind !== 'property') pending.push(resolved.ref);
      else if(resolved.status==='resolved'&&resolved.ref.kind==='property'){const property=resolveProperty(index,resolved.ref.id);if(property)pending.push({kind:'type',id:property.type.id});}
      else if(resolved.status==='external') pending.push({kind:'publishedContract',id:resolved.publishedContract});
      else if (resolved.status === 'dangling' || resolved.status === 'wrong-kind') throw new Error(`export dependency ${r.path} is unresolved`);
    }
  }
  // Behavioral and deployment records must accompany structural contracts.
  const content: ExportBundle['content'] = {
    types: model.types.filter(r => selected.has(`type/${r.id}`)), operations: model.operations.filter(r => selected.has(`operation/${r.id}`)), routines: model.routines.filter(r => selected.has(`routine/${r.id}`)),
    securitySchemes: deepClone(model.securitySchemes), mutations: deepClone(model.mutations), deploymentUnits: deepClone(model.deploymentUnits), hosts: deepClone(model.hosts), evidenceObligations: deriveObligations(model, undefined),
  };
  content.records = [...selected].sort().map(key => { const slash=key.indexOf('/'); const ref={kind:key.slice(0,slash) as RecordRef['kind'],id:key.slice(slash+1)};return {ref,record:deepClone(findRecord(index,ref)) as Record<string,unknown>}; });
  const { roots: _roots, agreementBundle, imports, ...identity } = options;
  return { bundleVersion: 1, ...identity, schemaVersion: 1, profiles: [], digest: canonicalHash(content), content: deepClone(content), ...(agreementBundle ? { agreementBundle } : {}),...(imports?.length?{imports:[...imports].sort((a,b)=>`${a.publisher}/${a.contract}/${a.version}`.localeCompare(`${b.publisher}/${b.contract}/${b.version}`))}:{}) };
}

export function exactExport(pin: ContractPin, bundles: readonly ExportBundle[]): ExportBundle | undefined {
  return bundles.find(b => b.publisher === pin.publisher && b.contract === pin.contract && b.version === pin.version && b.schemaVersion === pin.schemaVersion && b.sourceCommit === pin.sourceCommit && b.digest === pin.digest && canonicalHash(b.content) === pin.digest);
}

/** Pure composed validation: no checkout, clock, mutation or journal IO. */
export function resolveComposition(input: CompositionInput): CompositionResult {
  const models = [input, ...input.members], findings: Finding[] = [], closure: (RecordAddress | ResolvedReference)[] = [];
  const byId = new Map(models.map(m => [m.modelId, m]));
  if (byId.size !== models.length) findings.push(failure('composition', 'duplicate model identity in composition'));
  const revisionVector = revisionVectorOf(models.map(m => ({ modelId: m.modelId, model: modelRevision(m.model), config: canonicalHash(m.config), policy: m.policyHash ?? null, contract: CONTRACT_DIGEST, generator: CONTRACT_DIGEST, imports: importPinsOf(m.config) })));
  const visited = new Set<string>();
  const artifactSeen=new Set<string>();
  const importedClosure=(bundle:ExportBundle,path:string[]):void=>{
    if(path.includes(bundle.digest)){findings.push(failure('composition/closure',`artifact-reference cycle: ${[...path,bundle.digest].join(' -> ')}`));return;}
    if(path.length>(input.maxDepth??32)){findings.push(failure('composition/closure','artifact-reference depth limit exceeded'));return;}
    if(artifactSeen.has(bundle.digest))return;artifactSeen.add(bundle.digest);
    for(const pin of bundle.imports??[]){const imported=exactExport(pin,input.bundles);if(!imported)findings.push(failure('composition/closure',`exact upstream export ${pin.publisher}/${pin.contract}@${pin.version} is unavailable`,'PUBLISHED_CONTRACT_UNRESOLVED'));else importedClosure(imported,[...path,bundle.digest]);}
    for(const entry of bundle.content.records??[]){closure.push({modelId:bundle.modelId??bundle.publisher,...entry.ref,bundleDigest:bundle.digest});if(entry.ref.kind!=='publishedContract')continue;
      const pin=entry.record as {publisher:string;contract:string;version:number;schemaVersion:number;digest:string};
      const imported=input.bundles.find(b=>b.publisher===pin.publisher&&b.contract===pin.contract&&b.version===pin.version&&b.schemaVersion===pin.schemaVersion&&b.digest===pin.digest&&canonicalHash(b.content)===pin.digest);
      if(!imported){findings.push(failure('composition/closure',`required imported export ${pin.publisher}/${pin.contract}@${pin.version} is unavailable`,'PUBLISHED_CONTRACT_UNRESOLVED'));continue;}
      importedClosure(imported,[...path,bundle.digest]);
    }
  };
  const walk = (id: string, path: string[]): void => {
    if (path.includes(id)) { findings.push(failure('composition/members', `ownership cycle: ${[...path, id].join(' -> ')}`)); return; }
    if (path.length > (input.maxDepth ?? 32)) { findings.push(failure('composition/members', 'composition depth limit exceeded')); return; }
    if (visited.has(id)) return;
    visited.add(id);
    const entry = byId.get(id);
    if (!entry) { findings.push(failure('composition/members', `member ${id} is missing`, 'PUBLISHED_CONTRACT_UNRESOLVED')); return; }
    findings.push(...validate(entry.model), ...(entry.findings ?? []));
    for (const member of entry.config.composition?.members ?? []) {
      if (!member.exports.length) findings.push(failure(`composition/${member.memberId}/exports`, `member ${member.modelId} has no exact export`, 'PUBLISHED_CONTRACT_UNRESOLVED'));
      for (const pin of member.exports) {
        const bundle = exactExport(pin, input.bundles);
        if (!bundle || bundle.modelId !== member.modelId) { findings.push(failure(`composition/${member.memberId}/exports`, `exact export ${pin.publisher}/${pin.contract}@${pin.version} is missing or stale`, 'PUBLISHED_CONTRACT_DIGEST_MISMATCH')); continue; }
        importedClosure(bundle,[]);
        const owner = byId.get(member.modelId);
        if (owner) {
          try {
            const roots: RecordRef[] = [...bundle.content.types.map(r=>({kind:'type' as const,id:r.id})),...bundle.content.operations.map(r=>({kind:'operation' as const,id:r.id})),...bundle.content.routines.map(r=>({kind:'routine' as const,id:r.id}))];
            const expected = buildExportBundle(owner.model,{modelId:member.modelId,publisher:bundle.publisher,contract:bundle.contract,version:bundle.version,sourceCommit:pin.sourceCommit,roots,...(bundle.agreementBundle?{agreementBundle:bundle.agreementBundle}:{})});
            if(canonicalHash(expected.content)!==canonicalHash(bundle.content))findings.push(failure(`composition/${member.memberId}/closure`,'export omits required behavior or differs from the owning model record closure'));
          } catch(error) {findings.push(failure(`composition/${member.memberId}/closure`,String(error)));}
        }
        for (const [collection, records] of Object.entries(bundle.content)) {
          if (!Array.isArray(records)) continue;
          const kind = Object.entries(COLLECTION_OF_KIND).find(([, c]) => c === collection)?.[0] as RecordAddress['kind'] | undefined;
          if (kind) for (const record of records) if ('id' in record) closure.push({ modelId: member.modelId, kind, id: String(record.id), bundleDigest: bundle.digest });
        }
        for (const entry of (bundle.content as ExportBundle['content'] & {records?: {ref:RecordRef;record:unknown}[]}).records ?? []) closure.push({modelId:member.modelId,...entry.ref,bundleDigest:bundle.digest});
        if (bundle.agreementBundle) {
          const p = bundle.agreementBundle;
          const ab = input.agreementBundles?.find(b => b.publisher === p.publisher && b.contract === p.contract && b.version === p.version && b.sourceCommit === p.sourceCommit && b.digest === p.digest);
          if (!ab) findings.push(failure(`composition/${member.memberId}/agreementBundle`, 'exact agreement bundle is missing'));
          else {const {digest:_digest,signature:_signature,...body}=ab;if(canonicalHash(body)!==ab.digest)findings.push(failure(`composition/${member.memberId}/agreementBundle`,'agreement bundle content digest is invalid'));}
        }
      }
      walk(member.modelId, [...path, id]);
    }
  };
  walk(input.modelId, []);
  const resolved = new Map(closure.map(a => [addressKey(a), a]));
  for (const agreement of input.model.agreements) {
    for (const provider of agreement.providers) {
      const binding = input.bindings?.find(b => b.agreementRef.modelId === input.modelId && b.agreementRef.id === agreement.id && addressKey(b.providerRef) === addressKey(provider));
      if (!binding) { findings.push(failure(`agreements/${agreement.id}`, `provider ${addressKey(provider)} has no exact agreement binding`)); continue; }
      const record = resolved.get(addressKey(binding.providerRef));
      if (!record || !('bundleDigest' in record) || record.bundleDigest !== binding.providerRef.bundleDigest) findings.push(failure(`agreements/${agreement.id}`, 'provider binding does not resolve against its exact export'));
      const agreementBundle = input.agreementBundles?.find(b => b.digest === binding.agreementDigest && b.modelId === input.modelId && b.agreements.some(a => a.id === agreement.id && canonicalHash(a) === canonicalHash(agreement)));
      if (!agreementBundle) findings.push(failure(`agreements/${agreement.id}`, 'binding agreement digest does not identify the current agreement'));
      for (const consumer of agreement.consumers) if (!binding.consumerRefs.some(a => addressKey(a) === addressKey(consumer))) findings.push(failure(`agreements/${agreement.id}`, `consumer ${addressKey(consumer)} has no binding`));
      for (const a of [...binding.consumerRefs, ...binding.mappingRefs]) if (!byId.has(a.modelId) || findRecord(indexModel(byId.get(a.modelId)!.model), a) === undefined) findings.push(failure(`agreements/${agreement.id}`, `${addressKey(a)} is unresolved`));
    }
  }
  if (closure.length > (input.maxRecords ?? 10000)) findings.push(failure('composition/closure', 'composition record limit exceeded'));
  for (const journal of input.journals ?? []) if (journal.state !== 'complete') findings.push(failure('composition/journals', `federation proposal ${journal.proposalId} is ${journal.state}; readiness and release are blocked`));
  const unique = [...new Map(closure.map(a => [addressKey(a) + ('bundleDigest' in a ? a.bundleDigest : ''), a])).values()].sort((a,b) => addressKey(a).localeCompare(addressKey(b)));
  return { revisionVector, snapshotDigest: canonicalHash(revisionVector), closure: unique, findings, ready: !findings.some(f => f.severity === 'error') };
}

export function importedMutationRefusal(ownerModelId: string, localModelId: string): { owner: string; nextAction: string } | null {
  return ownerModelId === localModelId ? null : { owner: ownerModelId, nextAction: `propose an owner-local change in model ${ownerModelId}, publish its export, then update the consumer pin` };
}
