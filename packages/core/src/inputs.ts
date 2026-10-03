import type {
  Acceptance,
  Baseline,
  EvidenceKind,
  EvidenceRecord,
  LoomConfig,
  Model,
  Policy,
  PublishedContract,
  WorkflowState,
} from './generated/types.js';

/**
 * Verified records an adapter supplies to an evaluation. The core never reads
 * them from disk and never establishes their provenance: `verified` and
 * `trusted` are the adapter's verdicts, and an untrusted record grants nothing.
 */
export interface EvaluationInputs {
  baseline?: { record: Baseline; model: Model; verified: boolean };
  /** Accepted baselines that hold the shapes of earlier, still supported contract versions. */
  supportedBaselines?: { record: Baseline; model: Model }[];
  acceptances?: { record: Acceptance; trusted: boolean }[];
  evidence?: { record: EvidenceRecord; trusted: boolean; reason?: string }[];
  policy?: Policy;
  gates?: LoomConfig['gates'];
  state?: WorkflowState;
  publishedContracts?: PublishedContract[];
  /** ISO date supplied by the adapter; the core has no clock. */
  asOf?: string;
  /** Current hash of each generated artifact instance, for evidence whose inputs name an artifact. */
  artifacts?: Readonly<Record<string, string>>;
}

/**
 * The inputs an artifact is rendered with when it is qualified or when the
 * currency of evidence about it is checked: the resolved published contracts
 * and nothing else. A view rendered with every input summarizes the evidence
 * store, so evidence about it would go stale the moment it was stored.
 */
export function artifactInputs(inputs: EvaluationInputs): EvaluationInputs | undefined {
  return inputs.publishedContracts?.length ? { publishedContracts: inputs.publishedContracts } : undefined;
}

export type ImplementationGate = 'none' | 'proposed-contract' | 'accepted-contract';

export interface EffectiveGates {
  implementationRequires: ImplementationGate;
  integrationEvidence: EvidenceKind[];
  releaseEvidence: EvidenceKind[];
  /** Configured gates the trusted policy overrides because they are weaker. */
  weakened: string[];
}

const GATE_RANK: Record<ImplementationGate, number> = { none: 0, 'proposed-contract': 1, 'accepted-contract': 2 };

/**
 * The gates in force: the trusted policy merged with the workspace
 * configuration so that configuration can only strengthen it. With neither,
 * implementation requires accepted contracts, the strictest reading.
 */
export function effectiveGates(inputs: EvaluationInputs): EffectiveGates {
  const policy = inputs.policy;
  const config = inputs.gates ?? {};
  const weakened: string[] = [];
  const fromPolicy = policy?.readiness.implementation.requires;
  let implementationRequires: ImplementationGate = fromPolicy ?? config.implementationRequires ?? 'accepted-contract';
  if (config.implementationRequires && fromPolicy) {
    if (GATE_RANK[config.implementationRequires] > GATE_RANK[fromPolicy]) implementationRequires = config.implementationRequires;
    else if (GATE_RANK[config.implementationRequires] < GATE_RANK[fromPolicy]) {
      weakened.push(`implementationRequires '${config.implementationRequires}' is weaker than the policy's '${fromPolicy}'`);
    }
  }
  const union = (a: readonly EvidenceKind[] = [], b: readonly EvidenceKind[] = []): EvidenceKind[] => [...new Set([...a, ...b])].sort();
  return {
    implementationRequires,
    integrationEvidence: union(policy?.readiness.integration.evidence),
    releaseEvidence: union(policy?.readiness.release.evidence, config.releaseRequires),
    weakened,
  };
}

/** Seconds in an ISO 8601 duration; years and months count as 365 and 30 days, so values are comparable. */
export function durationSeconds(value: string): number | null {
  const m = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!m) return null;
  const n = (i: number): number => (m[i] ? Number(m[i]) : 0);
  return ((n(1) * 365 + n(2) * 30 + n(3) * 7 + n(4)) * 24 + n(5)) * 3600 + n(6) * 60 + n(7);
}
