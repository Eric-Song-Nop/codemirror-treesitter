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

## Fix coverage and merge order

All ten original findings have implemented fixes and maintained regression tests. The historical review documents and failing probe patches describe the original revision; they are not the current implementation status.

| Review finding                              | Pull request                                                            | Regression coverage                                                                                |
| ------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Review 1: mixed-container imports           | [#132](https://github.com/Eric-Song-Nop/codemirror-treesitter/pull/132) | Mixed map/text batches update the bound editor                                                     |
| Review 2: shared-document views             | [#132](https://github.com/Eric-Song-Nop/codemirror-treesitter/pull/132) | Sibling edits, external edits, undo, and exactly-once writes                                       |
| Review 3: interrupted parser base           | [#131](https://github.com/Eric-Song-Nop/codemirror-treesitter/pull/131) | Repeated length-changing interruptions, nested reuse, resource ownership                           |
| Review 4: hidden full structural projection | [#133](https://github.com/Eric-Song-Nop/codemirror-treesitter/pull/133) | Actual cache visits, local trace, canonical random-edit equivalence, empty-line/EOF point bounds   |
| Review 5: synchronous replacement scan      | [#133](https://github.com/Eric-Song-Nop/codemirror-treesitter/pull/133) | Persistent mapping of 1,000 replacements, exact insertion/deletion boundaries, no full scan        |
| Review 6: offscreen surface rebuild         | [#134](https://github.com/Eric-Song-Nop/codemirror-treesitter/pull/134) | Offscreen zero-work, bounded edit/selection changes, burst edits, prefix shifts                    |
| Review 7: full unbudgeted fence parsing     | [#137](https://github.com/Eric-Song-Nop/codemirror-treesitter/pull/137) | Native old-tree reuse, interrupted work, themes, cleanup, bounded queries, 40-fence queue fairness |
| Review 8: nested fence grammar loading      | [#137](https://github.com/Eric-Song-Nop/codemirror-treesitter/pull/137) | Quote/list fences initially and after information-string edits                                     |
| Cursor 1: stale imported presence           | [#135](https://github.com/Eric-Song-Nop/codemirror-treesitter/pull/135) | Imports, deletion, checkout, and numeric range mapping                                             |
| Cursor 2: delayed undo selection race       | [#135](https://github.com/Eric-Song-Nop/codemirror-treesitter/pull/135) | Newer selections, destruction, shared undo ownership, mixed transaction batches                    |

Additional validated issues discovered during implementation:

- [#136](https://github.com/Eric-Song-Nop/codemirror-treesitter/pull/136): public UTF-16 query offsets must be converted to native byte indices. Real WASM tests cover tree/node captures and matches, Unicode, nonzero roots, and one-sided bounds. Explicit zero upper bounds return no results instead of invoking the native unbounded-query sentinel; nonzero point queries retain their behavior.
- [#138](https://github.com/Eric-Song-Nop/codemirror-treesitter/pull/138): an interrupted initial parse must not hide configured language metadata. A forced-budget regression checks comment metadata and language activity before and after syntax publication.
- Followup review of #137 caught dropped work beyond the native session limit and unbounded highlight queries. Both were fixed before completing the track. Delayed parser tests explicitly wait for completion while retaining exact reuse and disposal assertions.

Independent main-targeted PRs are #131, #132, #133, #137, and #138. Stacks are **#131 → #136**, **#132 → #135**, and **#133 → #134**. Merge each prerequisite first, then retarget its successor to `main` and rerun CI. The existing workflow only triggers pull requests targeting `main`; stacked branches therefore require local combined validation before retargeting.

The Loro changes are durable source-controlled fixes in `vendor/loro-codemirror`, with the original license, provenance, source aliases, package build, and clean-install verification. They do not rely on editing `node_modules`.

## Final validation

The combined implementation is preserved on `fix/livemd-integration`. No PR has been merged.

- `vp install` passed in the clean integration worktree.
- `vp check` passed: formatting, linting, and type checking.
- `vp run --concurrency-limit 1 -r test` passed all 22 tasks: 1,116 Vitest tests plus one Rust test. This includes 401 LiveMD tests, 21 LiveMD-Loro tests, and 377 Grove application tests.
- The final zero-upper-bound query followup then passed all 127 combined language tests and `vp check`.
- `vp run --concurrency-limit 1 -r build` passed all 33 tasks, including the Grove production bundle contract. The language package was rebuilt after the final query followup.
- `vp run audit` passed after builds completed, including all 146 built language entries and dependency boundaries.
- `vp run verify:web-tree-sitter` and `vp run local-md-workspace#i18n:check` passed.
- Chromium's focused LiveMD browser regression smoke passed, covering rendered preview/edit boundaries.
- The Grove Agent/Loro browser fixture passed through direct page-target CDP: editor, Loro, and persisted text matched; exactly one local update occurred; IndexedDB and unselected-document assertions passed.

The broad Grove UI smoke harness stalled in browser-level CDP setup before importing its fixture on this Linux environment. The relevant fixture was executed independently as described above; the entire broad smoke is not claimed to have passed. No new end-to-end IME or multi-browser network-presence coverage was added.

Initial validation failures were resolved rather than hidden: structural empty-line endpoints, configured language metadata during initial parsing, and fence tests that assumed synchronous completion now have deterministic coverage. The 10,000-group structural reuse test retains exact reuse assertions with a 30-second test timeout for loaded runners.
