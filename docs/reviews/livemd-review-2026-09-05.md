# LiveMD editing, collaboration, and incrementality review

Reviewed commit: `be21050a27cc3e54c12cf039c3076a46f27c3834`.

Eight reproducible findings: two collaboration correctness bugs and six parser/rendering performance or correctness problems. Production code was not changed. The companion `livemd-review-reproductions.patch` adds focused regression probes to existing test harnesses; eight assertions intentionally fail on this revision, and one differential test passes.

## Findings

### 1. P1 — Mixed-container imports silently skip Markdown updates

**Location:** `node_modules/loro-codemirror/src/sync.ts:61–66`, consumed through `packages/live-md-loro/src/index.ts:49–53` and the source aliases in `vite.shared.ts:74–76`.

The pinned adapter returns from the entire import callback when it encounters an unrelated container or a non-text diff. Event batches can contain a metadata map before the Markdown text. In that case, the Loro document receives the text changes but the editor never receives them. Subsequent editing uses positions in the stale editor against the updated CRDT.

**Reproduction:** Initialize a metadata map before the Markdown text, sync two documents containing `hello`, then import a commit that changes both metadata and appends ` world`. The emitted order was map, then Markdown text. The editor stayed `hello`; its bound Loro text became `hello world`.

**Fix direction:** Skip unrelated events with `continue`, handle the bound text diff independently, and test mixed map/text and multiple-text batches. Fix the pinned/bundled dependency or replace this adapter path locally; editing an installed dependency alone is not a durable fix.

### 2. P1 — Multiple views on one LoroDoc diverge and then edit the wrong positions

**Location:** `packages/live-md-loro/src/index.ts:133–148`; upstream `node_modules/loro-codemirror/src/sync.ts:40–42`.

The upstream plugin ignores every local Loro event. The local wrapper forwards only events with the external-edit origin. Ordinary editor commits therefore reach neither another view bound to the same document nor its selection mapping. The package explicitly supports reusing collaboration extensions across views, but its existing reuse test checks handle disposal without checking the second view's content.

**Reproduction:** Bind two initially empty editors to one document. Insert `hello` in the first. The second stays empty. Insert `!` at the second editor's end: the final values are first editor `hello`, second editor `!`, and Loro `!hello`.

**Fix direction:** Identify the originating view and propagate ordinary local changes to the other bound views without echoing changes into Loro. Test shared-view input, selection mapping, undo, and external edits together.

### 3. P2 — An edit during suspended parsing discards the incremental base

**Location:** `packages/language/src/language.ts:1480–1504`.

`ParseContext.changes()` derives the next base only from `this.tree`. During an incomplete parse, that published tree is empty while the usable edited base remains in `this.oldTree`. The method cancels pending work, disposes that base, and hands the next context an empty tree. The next native parse receives `null` as its old tree.

**Reproduction:** Complete an initial parse, suspend the parse after one edit, then apply a second edit before resuming. Instrumented native parse bases were `[null, "edited-root-1", null]`. The last parse should still have an edited incremental base. The probe controls suspension deterministically; it does not depend on machine speed.

**Impact:** Parsing becomes a fresh document parse precisely when typing outruns the parser. This affects LiveMD's block parser and the shared language layer. It is distinct from the semantic cache's explicit full-walk fallback.

**Fix direction:** Preserve and further edit the most recent valid base through interrupted generations, with correct ownership and composed changed-range tracking. Extend the suspended-session tests to cover successive edits, not only resumption without another edit.

### 4. P2 — “Incremental” direct projection performs a hidden whole-document pass

**Location:** `packages/live-md/src/core/projection/compilers.ts:100–104,190–197`.

Every nonempty incremental direct patch replaces its structural line decorations using `compileFullDirectStructuralLineDecorations()`. That function projects every cached record, including all descriptor work needed to produce the specs, before filtering to line classes. It supplies a new trace and discards it, so normal incremental counters omit this full pass.

**Reproduction:** Append one character to the last of 100 ordinary paragraphs. A spy observed `projectLeafCacheRecords()` project all 100 records, while the reported `directProjectionRecords` was **0**.

**Impact:** Small edits still incur document-wide projection work and allocation. Benchmarks based on the existing trace can report locality while missing this work.

**Fix direction:** Patch structural line decorations using affected line ranges and record ownership. Include all projection passes in the same trace; assert actual record visits as well as reported counters.

### 5. P2 — Pending input synchronously scans and rebuilds every replacement

**Location:** `packages/live-md/src/core/runtime/projection-state.ts:103–120`, called from `runtime/field.ts:805–806`.

`mapProjectionDecorations()` iterates the entire decoration set, individually maps replacement positions, removes all replacements, and recreates a replacement RangeSet. Pending input maps both the base projection and current projection this way. This work happens inside the input transaction before the semantic scheduler can yield.

**Reproduction:** With 100 image replacements and the caret in an ordinary trailing paragraph, appending one character caused **200 full-range decoration callbacks** synchronously during `view.dispatch()`, before waiting for analysis.

**Fix direction:** Preserve the exact insertion-boundary behavior using appropriate range mapping semantics or a separately maintained replacement index. Avoid rebuilding every replacement and avoid duplicate base/current mapping when they are the same generation. Add input-path counters for mapping callbacks and allocations.

### 6. P2 — An unrelated offscreen edit rebuilds the entire visible surface

**Location:** `packages/live-md/src/core/runtime/field.ts:481–505,1486–1499`.

Normal analysis commits publish empty `surfaceInvalidationRanges`. The surface plugin treats any changed runtime with no partial invalidation as a reason to empty its complete surface cache. Its next refresh recompiles the entire visible window, even when the change is entirely offscreen. Selection changes that alter the active source island also enter this broad invalidation path. Task toggles have a partial-invalidation path, but ordinary edits do not.

**Reproduction:** Append one character at the end of 30 paragraphs, outside the compiled viewport. Semantic analysis touched one record and reused 29, but surface rendering revisited **18 visible records**, mapped **90 descriptors**, and recompiled `[0,439]` for an edit near offset 738.

**Fix direction:** Carry mapped old/new effect ranges and changed active-source ranges into surface invalidation. Preserve compiled ranges and mapped surface decorations outside those windows. Keep viewport invalidation separate from document-wide semantic revision changes.

### 7. P2 — Editing a code fence always starts an unbudgeted fresh fence parse

**Location:** `packages/live-md/src/core/runtime/render-cache.ts:228–308`, called from `core/projection/code-fence.ts:125`.

The fence highlight cache stores source and highlight spans, but no reusable parser/tree state. A source change misses the cache, creates a native parser, parses the entire fence with no old tree and no stop callback, highlights all of it, then destroys the parser and trees. This occurs during surface compilation. The block parser and semantic scheduler's incremental behavior do not make this nested language parse incremental or interruptible.

**Reproduction:** Insert one character into a 100-line TypeScript fence. The native call parsed **1,701 characters** with `reused: false` and `bounded: false`.

**Fix direction:** Maintain bounded, per-fence incremental parse sessions and edited trees, with explicit eviction/disposal and scheduler budgets. This is a whole-fence reparse, not a whole-Markdown-document reparse; its cost grows with fence size.

### 8. P2 — Nested fenced code never triggers its grammar load

**Location:** `packages/live-md/src/core/languages.ts:148–173,178–215`; `core/editor.ts:120–127,144`.

Encountered-language discovery uses a raw-line regex that recognizes only zero to three spaces before a fence. Valid fences inside blockquotes or sufficiently indented list items have container prefixes. The block parser recognizes these fences, but the lazy loader never requests their grammars. Unless another top-level fence or an explicit preload loads the grammar, their code highlighting remains absent.

**Reproduction:** `codeFenceLanguageNames("> ```ts\n> const x = 1\n> ```")` returns `[]`, rather than including `ts`.

**Fix direction:** Discover fence info from parsed block descriptors, or correctly strip Markdown container prefixes with a tested scanner. Cover initial loading and edits to nested fence info strings.

## Dependency and fallback map

| Layer                                                      | Live editing behavior and review result                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@codemirror/state`, `@codemirror/view`                    | Transactions, persistent document/range structures, selections, view updates, DOM rendering. Local replacement remapping bypasses much of the range structure's incremental benefit: finding 5.                                                                                                                                      |
| `packages/language` → vendored `web-tree-sitter`           | Incremental Markdown block parsing, parser scheduling, changed ranges, syntax wrappers. Ordinary reuse exists; interrupted generations lose it: finding 3.                                                                                                                                                                           |
| `packages/language-data`                                   | Markdown block/inline grammar service, included ranges, WASM and query loading, focused fence language loading. Nested fence discovery problem is in LiveMD's loader: finding 8.                                                                                                                                                     |
| LiveMD semantic analysis                                   | Range-local block discovery, fixed-point expansion, exact-source cache reuse, leaf-local inline parsing, resumable analysis. Full walks remain for initialization, invalidated inputs, and explicit fallback. These are not all bugs.                                                                                                |
| LiveMD direct projection                                   | Layout-affecting decorations are retained across the document, with local patch machinery. Hidden structural rebuild and replacement remapping undermine locality: findings 4–5.                                                                                                                                                     |
| LiveMD surface projection                                  | Viewport-bounded inline decorations and fence highlighting. Ordinary commits discard surface reuse, and changed fences parse afresh: findings 6–7.                                                                                                                                                                                   |
| KaTeX, Mermaid, beautiful-mermaid, images/tables           | Descriptor-driven widgets and bounded result caches. Result-cache reuse is different from native incremental parsing or retaining rendered projections.                                                                                                                                                                              |
| Local commands, autocomplete, basic setup, official search | Keymaps, Markdown continuation, wrapping commands, bracket insertion, history/search integration. Related package suites passed. Search reuses semantic data but still builds a per-state visibility index by walking block syntax and semantic records; no claim of fully local search indexing.                                    |
| `live-md-loro` → pinned `loro-codemirror` → `loro-crdt`    | Deltas are generally used for imports/external edits. Mixed event batches and same-document local events can diverge: findings 1–2. Checkout and initial mismatches use full replacement by design.                                                                                                                                  |
| Grove/editor hosts                                         | `LiveMdEditor.tsx`, editor/controller and web-component boundaries, and document runtime integration were inspected for full-value replacement and collaboration wiring. `setValue()` deliberately replaces the whole document and resets selection; it should remain a content-reset API rather than an incremental edit transport. |

Changed inline hosts are parsed afresh within leaf ranges; this is leaf-level incremental analysis, not native incremental inline-tree reuse. Full HTML export is a separate explicit render operation. Neither behavior, by itself, proves an accidental fallback of the entire live editor.

The LiveMD README's statement that range-local analysis and direct incremental projection are still follow-up work is stale relative to the actual implementation. It should be updated after the intended guarantees and these remaining full passes are settled.

## Validation and limits

- `vp install`: completed; no tracked dependency changes.
- `vp check`: passed on the baseline and with the formatted review artifacts and all reproduction probes present (including type checking).
- `vp run -r test`: attempted; stopped after two stream-parser tests failed. Both passed immediately in isolation; the complete language suite subsequently passed. Treat the initial failure as an unresolved timing/test reliability observation, not a confirmed persistent stream-parser defect.
- Existing LiveMD suite: **379 passed**, 29 files, about 404 seconds wall time.
- Existing LiveMD-Loro suite: **11 passed**.
- Complete language suite on rerun: **118 passed**.
- Language-data, commands, autocomplete, and basic-setup suites: **49 passed** combined.
- Thus **557 existing tests** passed across the directly reviewed packages. This is not a claim that every workspace/app suite passed.
- A deterministic differential probe performed **300 sequential edits** across paragraphs, emphasis, lists/tasks, quotes, headings, fences, tables, links, HTML, rules, and indented code. Committed full-document projection matched a fresh canonical build after every edit.
- The differential comparison deliberately uses the complete runtime snapshot, not the viewport-limited surface. An initial viewport/full-document comparison produced a false positive from expected offscreen omission; that was discarded.
- All eight findings have focused reproduction evidence in the companion patch. Performance findings establish work counts and missing reuse/budgets, not browser latency thresholds.
- Browser IME/composition, mobile selection, visual scroll stability, and real network collaboration were not exercised end to end. Passing state/DOM tests does not establish correctness for those interactions.

To reproduce in a disposable checkout, apply `livemd-review-reproductions.patch`, then run:

```sh
vp run @codemirror-treesitter/language#test -- tests/parse-session.test.ts -t REVIEW
vp run @codemirror-treesitter/live-md-loro#test -- tests/collaboration.test.ts -t REVIEW
vp run @codemirror-treesitter/live-md#test -- tests/analysis-snapshot.test.ts -t REVIEW
```

The patch is test-only and intentionally asserts the desired behavior for each bug. Prioritize the two collaboration divergences, then preserve parser bases and remove unreported whole-document input/projection work. Follow with surface invalidation, bounded incremental fence parsing, and nested grammar discovery.
