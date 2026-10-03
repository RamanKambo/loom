# Loom open items

Unresolved questions about Loom, each with what would close it. A decision lands in the code, the README or a commit message, and its item is then deleted. Identifiers are never reused.

## OI-5 Should the OpenAPI projection include the schemas of pinned published-contract types?

An operation whose request, response or error is typed by a record of a pinned published contract (an id of the form `<contract>:<record>`) has no schema inside the generated document, so the `openapi` target reports the construct `type.externalSchema` as unsupported and renders only a marked draft (`packages/core/src/projections/openapi.ts`; `unsupported` in `packages/core/schema/profiles/openapi.json`). The `api-database` adoption fixture in `qualification/fixtures` is such a model.

**What would close:** a decision to render the pinned bundle's type definitions into the document's components from the resolved bundles the workspace adapter already supplies, with `openapi.validate` and `openapi.compatibility` qualifying the `api-database` fixture outside draft mode; or a decision that external types stay unsupported, recorded in the profile.

**Cost of leaving open:** a system that consumes another system's published contract over HTTP gets only a draft OpenAPI document, which cannot qualify or publish.
