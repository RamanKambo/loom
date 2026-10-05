# Explicit composition

A composition lists each direct repository member in `.loom/loom.json` with its stable model identity and exact export pins. Filesystem nesting grants no membership. A composition-only model may have an empty source scope. An implementation parent must narrow its own scope to exclude delegated child roots: a parent `.` claim still conflicts with a child's implementation roots.

An export pin identifies publisher, contract, version, schema version, content digest and source commit. Published content includes public contracts and their required record closure, retaining each record's owning model. Missing checkouts, incorrect digests, missing closure records, unresolved agreement bindings and incomplete federation journals block composed readiness. A qualified child does not prove parent integration; passing parent checks do not qualify a child implementation.

Agreement bundles publish parent-owned boundary constraints downward. Child export bundles pin those agreements. A composition release selects the complete exact member set and revision vector, bindings, trusted evidence and acceptance references. A stored release may be checked at `.loom/composition-release.json`. A draft is written under `.loom/drafts`, and cannot resolve as a trusted published contract. Release publication refuses dirty owned source inputs and requires current qualification, acceptance and evidence.

`planFederation` returns a read-only proposal bound to the original revision vector. A controller can explicitly export the portable proposal payload with `exportFederationProposal`; another process can import it with `importFederationProposal`. Import verifies every content hash. Applying rechecks the original vector under repository locks, stages the exact payload and advances a journal through `prepared`, `applying`, `complete` or `recovery-required`. The operation never stages Git files, commits or moves gitlinks.

Recovery resumes journal-owned writes whose old hashes still match or restores applied writes whose new hashes still match. A changed file is an external edit and is preserved. Every destination must remain inside its declared owner's model/configuration files, including after links and junctions resolve. An incomplete journal blocks readiness until recovery establishes completion.

`sourceSnapshot` records a commit, dirty flag, canonical content digest and byte hashes of source inputs using repository-relative paths. Source snapshots and revision vectors contain no wall-clock time or absolute checkout path.
