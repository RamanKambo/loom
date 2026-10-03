# Loom designer

An Angular single-page app for inspecting and editing a Loom model and for reading the engine's
validation, readiness, acceptance, qualification and change results. It enforces no rule itself:
every result is a call into `@loom/core`, and the model on screen is replaced only by a model that
`mutate()` accepted.

## Build, run and test

The app links `@loom/core` through `file:../../packages/core` and reads its built `dist`; the core's
runtime dependencies resolve from the monorepo's `node_modules`. Build the core first, from
`Tools/loom`:

```sh
npm install
npm run build
```

Then, from this directory:

```sh
npm install
npm start                                   # dev server on http://localhost:4200/
npm run build                               # production bundle in dist/designer
npx ng test --watch=false                   # Vitest in Node with jsdom, single run
npx ng test --watch=false --include src/app/loom-store.spec.ts   # one spec file
npx ng test --watch=false --filter "<regex>"                     # tests whose name matches
```

## Tabs

| Tab | What it shows or does |
|---|---|
| Browse | Components with their types, operations, routines and mutations, and the workflow list |
| Records | Every record collection of the contract: a form generated from the record's definition, a structured JSON editor checked against the same definition, add, remove, rename and the system profile |
| Mutate | The guided property edit and the batch patch editor; Preview runs the change planner without applying anything, Apply runs `mutate()` |
| Validate | The findings for the current model, each with its `fix` |
| States | Validation, readiness for a chosen task class and scope, acceptance and qualification, each with its reasons, the unmet prerequisites, the evidence obligations and the exact revisions evaluated |
| Unknowns | Open unknowns, applicable concerns the model leaves unresolved, and assumptions not yet validated |
| Diff | Changes since the model was opened or saved; this local comparison point is not an accepted baseline |
| Baseline | Selects the accepted baseline (record and snapshot), acceptance records, a policy and evidence records, and compares the candidate with the baseline |
| Views | The generated documentation views with their source revision, draft flag and coverage, plus the mapping and hosting records |
| Generate | Every projection target, downloadable as the files the engine writes |
| Publish | Builds a pinned published-contract bundle from selected records; the digest is the engine's canonical hash |

## Behavior

- **Nothing loaded in the designer is trusted.** Trust is established by reading the trusted Git
  ref or by verifying a signature against a policy read from it, and a browser page can do neither.
  A selected baseline, acceptance, policy or evidence record is therefore evaluated as untrusted,
  and the designer never reports acceptance as granted.
- Importing a model never accepts it; acceptance stays not evaluated until a baseline is selected.
- Selecting a baseline, editing the candidate and publishing are separate operations. Undo and the
  opened-model comparison point are local to the page.
- **A save never overwrites a file that changed since it was opened.** With a file opened through
  the File System Access API, Save re-reads the file and writes only while it is still at the
  revision the edit started from (`checkRevision`); otherwise the save is refused and nothing is
  written. Where the browser cannot write the file back, Save downloads the model together with
  that revision.
- Export downloads the canonical text from `exportModel()`; the download is blocked while the model
  has an error finding.
- A refused edit leaves the model unchanged and shows the engine's findings, each with its `fix`.
