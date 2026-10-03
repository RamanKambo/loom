# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

It loads on top of `Tools/loom/CLAUDE.md` when a designer file is read, and carries only the
designer's conventions. Commands and behaviour: @README.md

## Architecture

Angular 22, standalone and zoneless, state in signals. `src/app/loom-store.ts` is the only state
holder and the only caller of `@loom/core`; components render its signals and call its methods. The
model changes only to the model `mutate()` returned, so a refused edit never reaches the view.

## Rules

- Import the engine only as `'@loom/core'`, never from `../../packages/core/src` or `dist` paths, because
  the package entry is the contract the CLI and MCP server consume too.
- Never re-implement an engine rule in the UI. The guided edit form builds a `Patch` and sends it
  through `LoomStore.apply()`, the same path as the batch editor.
- Lists the engine publishes are read from it, not hard-coded: projection targets from
  `PROJECTION_TARGETS`, download file names from the files `renderTarget` returns (one per
  component instance for a per-component target), property kinds from `SCHEMA_BUNDLE.$defs.Kind`.
  A hard-coded copy goes stale when the core adds a target or kind.
- Keep `prebundle.exclude: ["@loom/core"]` in the `serve` options of `angular.json`. The dev server
  otherwise keeps serving its cached pre-bundle of the linked core after the core is rebuilt, and
  the page fails on any export the cache predates; the production build and the tests do not show it.
- A store change keeps `src/app/loom-store.spec.ts` asserting against `sampleModel()`, with consumers
  derived from the model rather than listed by hand, so the tests follow the sample when it grows.
