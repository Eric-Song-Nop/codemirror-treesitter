---
name: grove-effect-ts
description: Use when adding or modifying Effect TypeScript orchestration in apps/local-md-workspace. Effect and Zustand are intentionally forbidden in LiveMD and every other core package.
---

# Effect in Grove local-md-workspace

Effect is an application orchestration dependency, not an editor-library
dependency. Its only production scope in this repository is
`apps/local-md-workspace`.

## Hard boundary

- Import `effect` and `zustand` only from `apps/local-md-workspace`.
- Never import either library from `packages/live-md`, another `packages/*`
  package, or another app.
- Keep the LiveMD editor runtime and reusable core packages framework-neutral.
- The root `effect` devDependency exists only so agents can inspect
  `node_modules/effect/src`; runtime code must use the app's declared
  dependency.

## Before writing Effect code

Read `node_modules/effect/AGENTS.md` **completely** and follow its relevant
links. Effect is pinned to the current beta, so do not rely on remembered Effect
3 APIs. Search `node_modules/effect/src` when the guide does not cover an API.

Use Effect for typed asynchronous workflows, interruption, services, and scoped
resource cleanup. Use a Zustand vanilla store as the React-facing authoritative
read model. React components subscribe to the store; they must not mirror store
values into refs with synchronization effects.

Prefer:

- `Effect.fn("name")` with generator syntax for Effect-returning functions.
- tagged errors instead of untyped promise rejection paths.
- one app-owned `ManagedRuntime` bridge at imperative React/browser edges.
- scopes/finalizers for collaboration documents, persistence ownership, relay
  hosts, observers, and other resources.
- explicit latest-intent identity and fiber interruption for replaceable
  workflows; after every non-interruptible external boundary, verify the intent
  before publishing.
- atomic Zustand store actions for session publication and teardown.

Do not wrap every synchronous helper in Effect. Domain data transformations and
the core editor remain ordinary TypeScript.

## Validation

Run focused tests while editing, then from the repository root run:

```sh
vp check
vp run local-md-workspace#test
vp run audit
```
