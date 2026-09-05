# LiveMD review remediation plan

Scope: all eight findings in `livemd-review-2026-09-05.md` and both cursor findings in `livemd-cursor-review-2026-09-05.md`, based on commit `be21050`.

## Dependency order and PR tracks

| Track                         | Findings                                                         | Prerequisite                              | Acceptance                                                                                                                           |
| ----------------------------- | ---------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Loro synchronization          | Mixed imports; shared-document views                             | Durable source-controlled upstream patch  | Every bound view converges; exactly one CRDT write per originating edit; mixed batches and undo stay synchronized                    |
| Loro cursors                  | Imported presence positions; delayed undo restoration            | Synchronization PR                        | Cursors resolve against current content; newer selections/destroy supersede deferred restoration                                     |
| Parser interruptions          | Lost native incremental base                                     | Independent                               | Successive interrupted edits reuse a correctly edited native base, including nested trees and length changes; resources balance      |
| Projection mapping and layout | Synchronous replacement scans; hidden full structural projection | Independent                               | Edits map persistent ranges and patch local structural ranges; actual visits match trace; output matches canonical rendering         |
| Viewport surface reuse        | Offscreen edits rebuild visible surface                          | Projection mapping/layout PR              | Map retained surface and invalidate only changed effects/active source ranges; offscreen edits do not rebuild the unchanged viewport |
| Code fences                   | Missing nested grammar loads; full unbudgeted fence parsing      | Coordinate lifecycle with surface runtime | Nested grammar loading works initially/on edits; fence trees reuse across edits with bounded work and cleanup                        |

## Execution

- Work in isolated worktrees. Parser, Loro, code-fence, and projection work can proceed in parallel.
- Keep unrelated npm-publishing PR #103 untouched.
- Each independent PR targets `main`. Dependent PRs target their prerequisite branch, with explicit merge order and focused diffs.
- Convert reproductions into maintained regression tests; preserve the historical review artifacts as evidence of the reviewed revision.
- Update affected READMEs, dependency/patch guidance, and public contracts where applicable.
- Review each patch and run targeted tests before committing/publishing.
- Assemble all branch tips into a local integration branch, resolve conflicts, then run `vp check`, workspace tests/builds, audit, and affected app checks/smokes where supported.
- Publish concrete PR descriptions with behavior, dependencies, validation, and any remaining limitations. Track every finding to a passing regression; do not equate passing existing tests with completing the fixes.

## Status

Implementation in progress. PR links and final validation will be recorded here as the work completes.
