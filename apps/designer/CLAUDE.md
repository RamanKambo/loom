# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

It loads on top of `Tools/loom/CLAUDE.md` when a designer file is read, and carries only the
designer's conventions. Commands and behaviour: @README.md

## Architecture

Angular 22, standalone and zoneless, state in signals. `src/app/loom-store.ts` is the only state
holder and the only caller of `@loom/core`; components render its signals and call its methods. The
model changes only to the model `mutate()` returned, so a refused edit never reaches the view. The
readiness, acceptance, qualification, change-plan and diff results come from the same core tool
functions the MCP server calls, so the designer and an agent see identical content.

## Rules

- Import the engine only as `'@loom/core'`, never from `../../packages/core/src` or `dist` paths, because
  the package entry is the contract the CLI and MCP server consume too.
- Never re-implement an engine rule in the UI. Every form, including the guided edit and the record
  editor, builds a `Patch` and sends it through `LoomStore.apply()`; the preview goes through
  `LoomStore.preview()`, which is the core change planner.
- Lists the engine publishes are read from it, not hard-coded: record collections from
  `COLLECTIONS`, record fields, enums and requiredness from `SCHEMA_BUNDLE` (`src/app/schema-fields.ts`),
  task classes from the contract's `TaskClass`, view targets from the documentation profiles in
  `PROFILES`, projection targets from `PROJECTION_TARGETS`, and download file names from the files
  `renderTarget` returns. A hard-coded copy goes stale when the contract adds a field or target.
- Every baseline, acceptance, policy and evidence record the store passes to the engine is marked
  untrusted (`TRUST_LIMIT` in `src/app/loom-store.ts`), because the page cannot read the trusted Git ref.
  Never add a path that marks one trusted.
- A persistent write goes through `LoomStore.save()`, which compares the file on disk with the base
  revision through `checkRevision` before writing; `src/app/persistence.spec.ts` fails if that check is
  bypassed.
- Keep `prebundle.exclude: ["@loom/core"]` in the `serve` options of `angular.json`. The dev server
  otherwise keeps serving its cached pre-bundle of the linked core after the core is rebuilt, and
  the page fails on any export the cache predates; the production build and the tests do not show it.
- A store change keeps `src/app/loom-store.spec.ts` asserting against `sampleModel()`, with consumers
  derived from the model rather than listed by hand, so the tests follow the sample when it grows.
