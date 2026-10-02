# Loom designer

An Angular single-page app for browsing and editing a Loom model. It enforces no rule itself: every
validation, mutation, diff, projection, import and export is a call into `@loom/core`, and the model
on screen is replaced only by a model that `mutate()` accepted.

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

## Behaviour

- The diff baseline is the model as last loaded.
- Export downloads the canonical text from `exportModel()`; the download is blocked while the model
  has an error finding.
- A refused edit leaves the model unchanged and shows the engine's findings, each with its `fix`.
