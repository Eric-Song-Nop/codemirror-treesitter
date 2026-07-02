# LiveMD Improvement Plan

Date: 2026-07-02
Companion to: [ARCHITECTURE_REVIEW.md](./ARCHITECTURE_REVIEW.md)
Baseline commit: `40294b3`

Every problem recorded in the review (IDs A1–A6e, R1–R6) maps to a work item
below. Items are grouped into PR-sized changes, ordered so that each PR lands
independently, keeps `vp run @codemirror-treesitter/live-md#check` and `#test`
green, and unblocks the next. Code sketches use the repository's existing
style (no semicolon changes, `let`, sorted object keys where the file does).

Validation for every PR (from AGENTS.md):

```bash
vp run @codemirror-treesitter/live-md#check
vp run @codemirror-treesitter/live-md#test
vp run @codemirror-treesitter/live-md#build
```

## Implementation status

- **Phase 0 / PR-0:** implemented on 2026-07-02 in draft PR #86
  (`fable-review`). The code now records pending edit-surface ranges and line
  counts on `LiveMdLeafAnalysisTrace`, and the test suite has an asserted
  paragraph-locality case plus a nested-list inflation baseline for PR-2 to
  flip.
- **Phase 1 / PR-1:** ready for review on 2026-07-03 in draft PR #87
  (`codex/live-md-pr1-ranges`). The code adds the shared range-math module,
  replaces duplicated LiveMD range/hash helpers, and makes the point-aware,
  inclusive-boundary, and strict-overlap range semantics explicit at call
  sites.
- **Phase 1 / PR-2:** ready for review on 2026-07-03 in draft PR #88
  (`codex/live-md-pr2-reveal-range`). The code separates conservative
  invalidation ranges from pending reveal ranges, keeps nested-list edits
  local to the edited line, preserves destructive table/fence/widget reveal
  behavior, and stops untouched selection lines from joining the edit surface.
- **Phase 1 / PR-3:** ready for review on 2026-07-03 in draft PR #90
  (`codex/live-md-pr3-container-syntax`). The code shares the broad
  container syntax-range filter with the runtime edit-surface path, keeping
  structural fence-start edits local while preserving committed semantic
  restructuring.

---

## Phase 0 — measurement first

### PR-0: Reveal-locality tracing and tests _(implemented; fixes R6; prerequisite for R1–R4)_

**Goal.** Make "revealed area per keystroke" a measured, asserted quantity
before changing reveal policy, so every later PR can prove it improved and
never regressed.

**Implemented.** Draft PR #86 adds the trace fields, writes them from
`pendingSourceAnalysis`, merges them across trace snapshots, and tests the
new measurement in `tests/analysis-snapshot.test.ts`. The passing locality
test uses a small plain-paragraph fixture that is local under the current
policy. A pending selection-only regression test keeps the recorded edit
surface visible in the trace while a scheduled source analysis is outstanding.
The nested-list fixture originally asserted that reveal was inflated; PR-2
flips that baseline to `editSurfaceLines <= 3`.

**Changes.**

1. `core/analysis/types.ts` — extend `LiveMdLeafAnalysisTrace`:

   ```ts
   export type LiveMdLeafAnalysisTrace = {
     // ...existing fields...
     /** Ranges cleared to raw source by the last pending update. */
     editSurfaceRanges: readonly DocRange[];
     /** Total lines covered by editSurfaceRanges. */
     editSurfaceLines: number;
   };
   ```

   Initialize both in `emptyLiveMdLeafAnalysisTrace()` (`[]` / `0`) and add
   `editSurfaceLines: true` to `liveMdTraceNumericKeyMap` in
   `core/runtime/field.ts` so trace merging keeps working.

2. `core/runtime/field.ts` — in `pendingSourceAnalysis`, after computing
   `editSurface`, record it on the trace returned by `pendingInputTrace`:

   ```ts
   let trace = pendingInputTrace(transaction);
   trace.editSurfaceRanges = editSurface.ranges;
   trace.editSurfaceLines = countLines(transaction.state, editSurface.ranges);
   ```

   with a small `countLines(state, ranges)` helper (sum of
   `lineAt(to).number - lineAt(from).number + 1` per merged range).

3. `tests/analysis-snapshot.test.ts` — new describe block
   `"pending reveal locality"` using `dispatchScheduledLocalEdit` with a
   plain-paragraph locality fixture, a pending selection-only trace
   preservation fixture, and a nested-list inflation fixture:

   ```ts
   it("keeps a middle paragraph edit's reveal within its own block", async () => {
     // type one char in the middle paragraph fixture
     // assert trace.editSurfaceLines <= paragraphLines + 2
   });

   it("preserves edit-surface trace across pending selection-only updates", async () => {
     // start a pending source edit, move the selection before commit,
     // assert trace.editSurfaceRanges/Lines still reflect pending.editSurface
   });

   it("documents nested list pending reveal inflation", async () => {
     // 50-line list item fixture, edit one inner paragraph line
     // BASELINE (before PR-2): editSurfaceLines > 3
     // TARGET (after PR-2): flip this to editSurfaceLines <= 3
   });

   it("keeps a task checkbox toggle from revealing its own line", async () => {
     // dispatch the input.task change; assert no destructive decoration
     // was cleared on the marker line (after PR-4; skipped until then)
   });
   ```

   Land the first test asserting current _paragraph_ behavior (already local).
   Land the nested-list case as a passing current-behavior baseline that
   documents R1 (`editSurfaceLines > 3`), then flip it in PR-2.

**Files.** `core/analysis/types.ts`, `core/runtime/field.ts`,
`tests/analysis-snapshot.test.ts`.
**Size.** ~120 lines. **Risk.** None (trace-only).

---

## Phase 1 — render stability while editing

### PR-1: Shared range-math module _(ready in draft PR #87; fixes A6b; mechanical prerequisite)_

**Goal.** One source of truth for range primitives before reveal-policy
changes touch them; eliminates the divergent `rangesTouch` semantics.

**Changes.**

1. New `core/analysis/ranges.ts` exporting the canonical set, consolidated
   from the five existing copies:

   ```ts
   export function clamp(value: number, min: number, max: number): number;
   export function clampRangeToDoc(range: DocRange, docLength: number): DocRange;
   export function mapRange(range: DocRange, changes: ChangeDesc): DocRange; // exclusive assoc (1,-1)
   export function mapInclusiveRange(range: DocRange, changes: ChangeDesc): DocRange;
   export function normalizeRanges(ranges: readonly DocRange[], docLength: number): DocRange[];
   export function subtractRanges(
     ranges: readonly DocRange[],
     remove: readonly DocRange[],
   ): DocRange[];
   export function rangesSame(left: DocRange, right: DocRange): boolean;
   export function rangesEqual(left: readonly DocRange[], right: readonly DocRange[]): boolean;
   /** Point-aware touch: empty ranges touch at their position. */
   export function rangesTouchPoint(left: DocRange, right: DocRange): boolean;
   /** Inclusive overlap used by the block cursor (from <= to' && from' <= to). */
   export function rangesTouchInclusive(left: DocRange, right: DocRange): boolean;
   export function rangesOverlap(left: DocRange, right: DocRange): boolean; // strict from < to' && from' < to
   export function lineRangeFor(doc: Text, from: number, to: number): DocRange;
   export function countLines(doc: Text, ranges: readonly DocRange[]): number;
   export function hashString(value: string): string; // djb2, one copy
   export function hashDocRange(doc: Text, range: DocRange): number; // FNV-1a, moved from markdown-leaf-analysis.ts
   ```

2. Replace the local copies in `field.ts`, `markdown-leaf-cache.ts`,
   `markdown-source-islands.ts`, `markdown-block-cursor.ts`,
   `markdown-inline-analysis.ts`, `compilers.ts`, `render-cache.ts`,
   `widgets.ts`, `emit.ts`. Where a caller relied on a specific `rangesTouch`
   variant, name the variant explicitly at the call site — this is the point
   of the PR: the choice becomes visible.

3. `normalizeRanges` and `mergeDocRanges` (from
   `@codemirror-treesitter/language`) overlap; keep `mergeDocRanges` as the
   already-clamped merge and have `normalizeRanges(ranges, docLength)` clamp
   then delegate.

**Files.** New `core/analysis/ranges.ts`; edits in the nine files above.
**Size.** ~-250 net lines. **Risk.** Low but wide; the existing oracle and
random-edit tests are the safety net. Do it as a pure move-and-rename PR with
zero behavior change.

### PR-2: Deflate the pending edit surface _(fixes R1, R5d — the critical blink)_

**Goal.** Typing inside a list item must reveal at most the edited line's
block, not the whole ancestor item.

**Key insight.** `effectRange` has two consumers with different needs:

- _cache invalidation / commit patching_ — must stay conservative (include
  ancestor line-class spans), purely a recompute-cost concern;
- _pending reveal_ — must be tight, purely a visual concern.

Today one range serves both. Introduce a second, tight range for reveal.

**Changes.**

1. `core/analysis/descriptors.ts` — add to `LeafAnalysisRecord`:

   ```ts
   /**
    * Range whose destructive projection must be revealed while an edit to
    * this record is pending. Excludes ancestor-context structural effects
    * (line classes are source-safe and never concealed), so it stays within
    * the record's own source lines.
    */
   revealRange: DocRange;
   ```

2. `core/analysis/markdown-leaf-analysis.ts` — compute it in
   `createAnalysisRecord`, next to `analysisEffectRange`:

   ```ts
   function analysisRevealRange(
     analysis: LeafAnalysis,
     sourceRange: DocRange,
     docLength?: number,
   ): DocRange {
     let from = sourceRange.from;
     let to = sourceRange.to;
     // Only leaf-local descriptors participate: structuralEffects carry the
     // ancestor listPath/quote line classes and are excluded on purpose —
     // they are source-safe and never destructively concealed.
     for (let descriptor of analysis.descriptors) {
       if (!descriptorMayProduceDestructiveProjection(descriptor)) continue;
       for (let range of liveMdDescriptorRanges(descriptor)) {
         from = Math.min(from, range.from + sourceRange.from);
         to = Math.max(to, range.to + sourceRange.from);
       }
     }
     // ...clamp as in analysisEffectRange
   }
   ```

   with `descriptorMayProduceDestructiveProjection` covering the kinds that
   ever emit `replace`/hidden-`syntax` specs: `syntax`, `listMarker`,
   `taskMarker`, `image`, `latex`, `table`, `codeFence`, `linkMark` — i.e.
   everything except `lineClass` and `textMark` (text marks are
   source-safe marks). Marker units use `unit.sourceRange` (their line) as
   the base.

3. Persist `revealRange` through the cache payload
   (`markdown-leaf-cache.ts`: `LeafRecordPayload`, `leafRecordPayload`,
   `recordFromPayload` — one more relative range field).

4. `core/runtime/field.ts` — `touchedRecordSafetyRanges` becomes the reveal
   computation and stops pushing `effectRange`:

   ```ts
   function touchedRecordRevealRanges(
     baseAnalysis: LiveMdRuntimeState,
     state: EditorState,
     changes: ChangeDesc,
   ): readonly DocRange[] {
     let ranges: DocRange[] = [];
     let oldChangedRanges = changedOldRanges(changes);
     if (baseAnalysis.semantic) {
       for (let record of findLeafAnalysisRecordsTouchingRanges(
         baseAnalysis.semantic.cache,
         oldChangedRanges,
       )) {
         // Reveal only records whose OWN source the edit touched; records
         // pulled in via effectRange overlap keep their projection mapped.
         if (
           !oldChangedRanges.some(
             (range) =>
               rangesTouchPoint(record.sourceRange, range) ||
               rangesTouchPoint(recordCacheSourceRange(record), range),
           )
         )
           continue;
         ranges.push(mapRange(record.revealRange, changes));
       }
     }
     return mergeDocRanges(ranges.map((range) => clampRangeToDoc(range, state)));
   }
   ```

   The safety-index _query_ still uses the wide invalidation range (that is
   what finds candidate records); only what gets _added to the edit surface_
   tightens.

5. `pendingEditSurface` — restrict selection ranges to those intersecting the
   change (R5d):

   ```ts
   let selectionLineRanges = selectionPhysicalLineRanges(state).filter((range) =>
     changedLineRanges.some((changed) => rangesTouchPoint(range, changed)),
   );
   ```

   (The caret's block is already revealed by the active-source-island
   mechanism; the edit surface only needs to cover selection ranges the
   change actually rewrote, e.g. multi-cursor typing.)

6. Flip the `it.fails` locality test from PR-0 to a hard assertion:
   `editSurfaceLines <= editedLines + 2` for the nested-list fixture. Add an
   oracle-equivalence run over the nested-list fixture to confirm commit
   results are unchanged (they should be — this PR does not touch analysis
   or commit patching, only the pending reveal set).

**Files.** `descriptors.ts`, `markdown-leaf-analysis.ts`,
`markdown-leaf-cache.ts`, `runtime/field.ts`, tests.
**Size.** ~250 lines. **Risk.** Medium. The failure mode to test for: a
pending window where a destructive decoration _should_ have been cleared
(because the edit invalidated it) but wasn't — worst case is a stale widget
for one commit cycle, healed at commit; assert via the
`keeps transitioned semantic cache equivalent to a fresh full rebuild` suite
plus a new test that edits _inside_ a collapsed table/fence and asserts the
widget is revealed (those edits touch the record's own sourceRange, so they
still reveal correctly).

### PR-3: Filter broad container syntax ranges from the edit surface _(ready in draft PR #90; fixes R2)_

**Goal.** A structural keystroke (`-`, `>`, backtick at line start) must not
reveal the entire enclosing container.

**Changes.**

1. Export the existing filter from `markdown-leaf-cache.ts` (move it into
   `ranges.ts` or a shared `invalidation.ts`):

   ```ts
   export function isBroadContainerSyntaxRange(
     range: DocRange,
     textContextRanges: readonly DocRange[],
     docLength: number,
   ): boolean;
   ```

2. `core/runtime/field.ts` — apply it in `pendingEditSurface` before line
   expansion, mirroring `localInitialCheckRanges`:

   ```ts
   let syntaxLineRanges = syntaxChangedRanges
     .filter((range) => !isBroadContainerSyntaxRange(range, changedLineRanges, state.doc.length))
     .map((range) => lineRangeFor(state, range.from, range.to));
   ```

   Rationale for safety: the analysis layer already treats these ranges as
   noise for _discovery_ (they are re-derived by the fixed-point expansion
   when genuinely needed); the reveal layer needs them even less, because
   reveal is cosmetic — anything under-revealed is healed at commit by the
   incremental direct patch, whose input (`mappedOldEffectRanges` /
   `newEffectRanges` from the transition) is computed independently of the
   edit surface.

3. Test: in a fenced-code fixture, type a third backtick on a new line
   (splits the fence — a container-sized syntax change) and assert
   `editSurfaceLines` stays within a few lines of the caret while the
   _committed_ analysis still restructures the fences correctly
   (oracle-equivalence over the same edit).

**Files.** `markdown-leaf-cache.ts` (export move), `runtime/field.ts`, tests.
**Size.** ~60 lines. **Risk.** Low.

### PR-4: Origin-sensitive reveal policy + synchronous task toggle _(fixes R3)_

**Goal.** Only edits the local selection interacts with reveal raw source;
checkbox clicks, undo of distant ranges, and remote collaboration edits keep
stale mapped decorations and heal at commit without flicker.

**Changes.**

1. `core/runtime/field.ts` — classify each changed range in
   `pendingEditSurface`:

   ```ts
   function changeIsSelectionLocal(state: EditorState, changedRange: DocRange): boolean {
     return state.selection.ranges.some((range) =>
       rangesTouchPoint({ from: range.from, to: range.to }, changedRange),
     );
   }
   ```

   Changed line ranges that are **not** selection-local are excluded from
   the reveal set (they still drive invalidation/recompute — the pending
   analysis and commit patch are unaffected). Transactions annotated as
   remote should always be non-revealing; support both signals:

   ```ts
   let remote =
     transaction.annotation(Transaction.remote) === true ||
     transaction.annotation(Transaction.addToHistory) === false;
   ```

   (`live-md-loro` already dispatches with `addToHistory: false` /
   remote-style annotations via `loro-codemirror`; verify the exact
   annotation used and branch on that — do not guess from `userEvent`.)

2. **Undo/redo**: `userEvent` `"undo"`/`"redo"` → reveal only changed ranges
   that intersect the _post-transaction_ selection (CodeMirror restores
   selection with the undo; the range the user is looking at reveals, distant
   ones don't).

3. **Synchronous task toggle fast path.** A checkbox toggle is a
   deterministic single-record change; it should never enter the pending
   state. In `liveMdAnalysisField.update`, before `pendingSourceAnalysis`:

   ```ts
   if (transaction.isUserEvent("input.task") && value.semantic && !value.pending) {
     let fast = taskToggleFastPath(value, transaction);
     if (fast) return fast;
   }
   ```

   `taskToggleFastPath` (new, ~80 lines in a small
   `core/runtime/fast-paths.ts`):
   - find the single changed range; locate the unique `kind == "marker"`
     record whose `cacheSourceRange` equals the toggled `[x]`/`[ ]` range;
     bail (return null → normal pending path) if not exactly one, or if the
     change is not a 1-char space/x swap;
   - rebuild that one unit via `analyzeMarkdownLeafAnalysisUnit` with the
     marker's flipped text (markers don't need the inline parser —
     `markerDescriptors` is pure), producing a replacement record with the
     same `cacheId`;
   - patch the cache with `patchLeafAnalysisCache` over the marker's line,
     and the direct projection with `compileIncrementalDirectLayoutProjection`
     using `{ records: [newRecord], removeRecordIds: [cacheId], ranges:
[markerLine] }`;
   - return a complete (non-pending) `LiveMdRuntimeState` with
     `revision + 1`.

   Because the replacement `TaskCheckboxWidget` differs only in `checked`,
   CodeMirror swaps the DOM in place; nothing else in the document is
   touched, same-frame.

   The surface plugin needs one addition: when the runtime changes without
   pending and without doc-range invalidation beyond the marker line, its
   `refresh()` already recompiles only `subtractDocRanges(visible,
compiledRanges)`; extend the fast-path state to also drop the marker line
   from `compiledRanges` so the checkbox's surface syntax recompiles.

4. Tests: checkbox toggle produces zero destructive-decoration clears
   outside the marker's replace range and completes without a pending state;
   a simulated remote transaction (annotation set) reveals nothing; undo of a
   distant edit reveals nothing.

**Files.** `runtime/field.ts`, new `runtime/fast-paths.ts`,
`runtime/types.ts` (if the fast path needs a helper type), tests; possibly a
one-line annotation export in `live-md-loro`.
**Size.** ~300 lines. **Risk.** Medium — the fast path must bail to the
generic path on anything unexpected; keep the guard conditions strict and
covered by the random-edit equivalence test (extend it to include task
toggles in the edit mix).

### PR-5: Bound the pending window under sustained typing _(fixes R4, part of A4)_

**Goal.** Fluent typing must not grow the revealed region unboundedly; the
common single-block edit should commit within ~1 frame.

**Changes, in three independent steps (can be split):**

1. **Cap input yields** (`field.ts`, `LiveMdSchedulerPlugin`). Track
   `inputYieldCount` per revision alongside the existing deadline-yield
   count; after `liveMdSchedulerMaxInputYields = 5`, run the analysis
   without the input-pending check in `scheduledYieldCheck` (one blocking
   run bounded by the range-local transition cost, which PR-0's trace shows
   is small for local edits). This guarantees every revision eventually
   commits even under continuous typing.

2. **Adaptive quiet delay.** `liveMdSchedulerQuietDelay` is a fixed 24 ms.
   Keep it for expensive documents, but when the previous commit's trace
   shows a cheap transition (`recordsAnalyzed <= 8 && fallbackCount == 0`),
   schedule the idle task directly from the rAF callback with delay 0. Store
   `lastCommitCost` on the plugin from the committed analysis trace.

3. **Do not accumulate reveal ranges across pending revisions for
   non-selection-local content.** In `pendingEditSurface`, previous ranges
   currently map forward wholesale:

   ```ts
   let previousRanges =
     previousPending?.editSurface.ranges.map((range) => mapRange(range, transaction.changes)) ?? [];
   ```

   After PR-4 the surface only ever contains selection-local content, so
   accumulation is bounded by where the user actually typed; additionally
   drop previous ranges that no longer intersect the current selection's
   blocks _and_ were not re-touched by this transaction's changes — they can
   re-conceal immediately using the base analysis's mapped destructive sets
   (the data is still present in `baseAnalysis`, mapped through
   `pending.changes`). Implement as:

   ```ts
   let staleRevealRanges = previousRanges.filter(
     (range) =>
       !changedLineRanges.some((changed) => rangesTouchPoint(range, changed)) &&
       !selectionLineRanges.some((line) => rangesTouchPoint(range, line)),
   );
   // re-conceal: patch mapped base destructive decorations for these ranges
   // back into directDestructiveDecorations instead of leaving them cleared
   ```

   using `collectRangeSetRanges(baseAnalysis.directDestructiveDecorations
.map(pending.changes), staleRevealRanges)` + `patchRangeSet`. This gives
   "the region behind the caret heals as you type past it" instead of "all
   at once when you pause".

4. Tests: simulate a 40-keystroke burst across three paragraphs with input
   always pending (mock `isInputPending`); assert (a) a commit lands within
   the capped yields, (b) `editSurfaceLines` never exceeds the current
   paragraph + previous paragraph, (c) final state equals the oracle.

**Files.** `runtime/field.ts`, tests.
**Size.** ~200 lines. **Risk.** Medium. Step 3 is the subtle one — it
re-adds decorations during pending, which `mapPendingSurface` in the surface
plugin must mirror for surface-layer destructive sets; do it through the
shared state machine if PR-7 has landed first, otherwise implement in both
places and note the duplication for PR-7 to collapse.

### PR-6: Widget size stability _(fixes R5a, R5b, R5c)_

**Goal.** Block widgets never cause scroll hops when entering/leaving or
finishing async renders.

**Changes.**

1. `core/runtime/render-cache.ts` — add a measured-height side cache:

   ```ts
   export type LiveMdRenderCache = {
     // ...existing maps...
     measuredHeights: Map<string, number>; // resultKey → px
   };
   ```

2. `core/widgets.ts` — every block-capable widget gets:

   ```ts
   get estimatedHeight() {
     return this.heights?.get(this.resultKey) ?? this.defaultEstimate;
   }
   ```

   - `TablePreviewWidget`: `defaultEstimate = 28 * (rows + 1)` (row height ×
     header+rows); store the `measuredHeights` map + a stable key on
     construction (`widgetFromSpec` passes `build.renderCache.measuredHeights`
     and the render `resultKey`).
   - `MermaidWidget`: default estimate 160; the placeholder element gets
     `style.minHeight = estimatedHeight + "px"` so the "Rendering Mermaid
     diagram" → SVG swap does not reflow (R5b); on `applyMermaidResult`,
     measure (`element.getBoundingClientRect().height`) and write back to
     `measuredHeights` keyed by `result.resultKey`.
   - `LatexWidget` (block): default estimate 40 for display mode; measure in
     a `updateDOM`-free way by writing back from `toDOM` post-connect via
     `requestAnimationFrame` guard, or simpler: accept the default estimate
     (KaTeX is synchronous; CM measures it the same frame, so only the
     estimate matters for off-viewport lines).
   - `ImagePreviewWidget` (R5c): accept an optional `{ width, height }` from
     the resolver — extend `LiveMdImageRenderResult` with optional
     dimensions; when present set `img.width/height` (browser reserves the
     box); when absent, on `load` store natural height in `measuredHeights`
     keyed by `src` so re-creations reserve it.

3. Tests: widget `estimatedHeight` returns stored measurement after a
   simulated measure write; mermaid placeholder has min-height; image with
   resolver-provided dimensions renders width/height attributes.

**Files.** `core/widgets.ts`, `core/runtime/render-cache.ts`,
`core/projection/project-leaf.ts` (`widgetFromSpec` plumbing),
`core/images.ts` (optional dimensions type), tests.
**Size.** ~220 lines. **Risk.** Low.

---

## Phase 2 — architecture consolidation

### PR-7: Single pending-projection state machine _(fixes A2)_

**Goal.** One implementation of map/clear/patch for projection layers,
consumed by both the StateField (direct) and the surface plugin (surface).

**Changes.**

1. New `core/runtime/projection-state.ts`:

   ```ts
   export type ProjectionSets = {
     atomicRanges: RangeSet<RangeValue>;
     destructiveDecorations: DecorationSet;
     interactiveDecorations: DecorationSet;
     sourceSafeDecorations: DecorationSet;
   };

   /** Map all sets through a change. Source-safe/interactive are mapped
    *  only; destructive/atomic are mapped then cleared over revealRanges. */
   export function mapProjectionSets(
     sets: ProjectionSets,
     changes: ChangeDesc,
     revealRanges: readonly DocRange[],
   ): ProjectionSets;

   /** Clear destructive/atomic over ranges without mapping (selection-only
    *  reveals during pending). */
   export function revealProjectionSets(
     sets: ProjectionSets,
     ranges: readonly DocRange[],
   ): ProjectionSets;

   /** Replace content within ranges with recompiled additions, keyed by
    *  owner. (Wraps patchOwnedRangeSet for each set.) */
   export function patchProjectionSets(
     sets: ProjectionSets,
     ranges: readonly DocRange[],
     additions: ProjectionSets,
     removeOwnerKeys: ReadonlySet<string>,
   ): ProjectionSets;

   /** Re-conceal: restore base destructive content over ranges (PR-5 §3). */
   export function restoreProjectionSets(
     sets: ProjectionSets,
     base: ProjectionSets,
     ranges: readonly DocRange[],
   ): ProjectionSets;

   export function joinProjectionSets(sets: ProjectionSets): DecorationSet;
   ```

2. `LiveMdRuntimeState` gains `direct: ProjectionSets` replacing the four
   `direct*` fields; `LiveMdSurfaceProjectionState` collapses onto
   `ProjectionSets` + `compiledRanges` + `semanticRevision`. Update
   `pendingSourceAnalysis`, `pendingSelectionAnalysis`, `mapPendingSurface`,
   `clearPendingActiveSurface`, `patchSurfaceProjectionState`,
   `surfaceProjectionFromState`, `compileIncrementalDirectLayoutProjection`
   to delegate. `filterSurfaceProjectionToRanges`, `mergeSurfaceProjections`,
   `joinDirectProjectionSets`, `joinProjectionSets` (field.ts versions)
   collapse into the module.

3. No behavior change; the projection-effects and analysis-snapshot suites
   are the regression net. Property to keep: `directDecorations ==
join(sourceSafe, destructive)` — assert once in a test instead of
   maintaining it by hand at every construction site (today it is rebuilt
   manually in five places).

**Files.** New `runtime/projection-state.ts`; heavy edits in
`runtime/field.ts` (expected net −400 lines), `runtime/types.ts`,
`projection/compilers.ts`.
**Size.** ~600 lines touched. **Risk.** Medium; pure refactor, staged as
(a) introduce module + adopt in surface plugin, (b) adopt in field, each
with green tests.

### PR-8: Per-leaf feature API; retire the legacy path _(fixes A5, then A1)_

**Goal.** Custom Markdown features contribute descriptors during leaf
analysis so they ride the cache, the incremental transitions, and the
projection layers — then delete the legacy full-document query path.

**Design.**

1. `core/features.ts` — extend `LiveMdMarkdownFeature` with a leaf-scoped
   hook (keeping `query`/`decorate` temporarily as deprecated):

   ```ts
   export type LiveMdMarkdownFeature = {
     name: string;
     query?: string;                       // tree-sitter query, matched per leaf
     /** NEW: called once per (leaf, match) during analysis. Returns
      *  DOM-free descriptors relative to the document (offset handled by
      *  the caller). Must be pure w.r.t. (leaf source, context, match). */
     analyze?(context: LiveMdFeatureAnalyzeContext): readonly LiveMdFeatureDescriptor[];
     renderHtml?(...): ...;               // unchanged
     /** DEPRECATED: document-level decorate; forces conservative recompute. */
     decorate?(...): ...;
   };

   export type LiveMdFeatureDescriptor =
     | { kind: "lineClass"; className: string; range: DocRange }
     | { kind: "mark"; className: string; range: DocRange }
     | { kind: "syntax"; range: DocRange }
     | { kind: "replace"; widget: LiveMdFeatureWidgetSpec; range: DocRange; block?: boolean; atomic?: boolean };
   ```

   `LiveMdFeatureAnalyzeContext` exposes `node(name)`, `slice(range|node)`,
   `leaf` metadata (`kind`, `sourceRange`, `contextKey`) — the same helpers
   `renderHtml` already gets, minus editor state.

2. `core/analysis/markdown-leaf-analysis.ts` — during
   `analyzeMarkdownLeafAnalysisUnit`, run each feature's compiled query
   against the leaf's node (block tree, `from/to` bounded — the query
   plumbing exists in `analysis/query.ts` / `queryNodeMatches`), map results
   through `feature.analyze`, and append them to the record's descriptors as
   a new descriptor kind:

   ```ts
   | { kind: "feature"; feature: string; effect: LiveMdFeatureDescriptor }
   ```

   **Cache-key integration** (the critical part): feature identity must be
   in the reuse key, else toggling features serves stale analyses. Extend
   `LiveMdRenderKeyContext`-style epochs with a `featuresEpoch =
liveMdCompositeEpoch(...state.facet(liveMdMarkdownFeatureFacet))` and
   include it in `matchKey` via `cacheStructuralKey` (append
   `|f:<featuresEpoch>` when any feature has `analyze`). Feature-config
   changes then invalidate all records (correct: feature output may change
   anywhere) but through the ordinary transition machinery, not a separate
   path.

3. `core/projection/project-leaf.ts` — project `kind: "feature"` descriptors
   to the corresponding effect specs; layer assignment falls out of the
   existing `liveMdEffectSpecLayer`.

4. Active-line behavior: features receive no `activeLines` at analysis time
   (analysis is selection-independent by design). The projection context
   decides visibility exactly like built-ins: feature `replace` descriptors
   are suppressed inside active source ranges by the same
   `isEditableSource` check. If a feature needs custom active behavior, it
   can mark a descriptor `{ activeVariant: LiveMdFeatureDescriptor }` —
   defer this until a host asks.

5. Migration & deletion, staged across two PRs:
   - **PR-8a**: add `analyze`, keep `decorate` working; port the README's
     callout example and the test-suite features to `analyze`; document
     deprecation.
   - **PR-8b**: delete `hasLegacyDocumentQueryFeature`,
     `buildLegacyLiveMdBuild`, `applyLegacyMarkdownFeatures`,
     `processMatches`, `legacySurface` on the runtime state,
     `visibleLegacySurface`, and the legacy branches in
     `buildLiveMdAnalysis` / `liveMdAnalysisField.update` /
     `LiveMdSurfacePlugin.refresh`. The canonical oracle for tests moves to
     `analyzeMarkdownLeafSemantics` + full projection compile (it already
     exists: `compileProjectionLayersFromCache`). Expected: −500 lines in
     `field.ts`, README migration caveats replaced by the new feature docs.

**Files.** `features.ts`, `analysis/markdown-leaf-analysis.ts`,
`analysis/descriptors.ts`, `projection/project-leaf.ts`,
`projection/builtin.ts`, `runtime/field.ts`, README, tests.
**Size.** PR-8a ~450 lines; PR-8b ~−700 lines.
**Risk.** PR-8a low (additive); PR-8b medium — it changes the oracle. Land
8a, migrate all in-repo consumers (`apps/local-md-workspace` callouts if
any), soak, then 8b.

### PR-9: Resumable scheduled analysis _(fixes A4 fully)_

**Goal.** Yielding preserves completed per-unit work; commit latency becomes
proportional to _remaining_ work.

**Changes.**

1. `core/analysis/markdown-leaf-cache.ts` — the three transition functions
   take an optional resume state and return it on yield instead of throwing
   away progress. Shape:

   ```ts
   export type LeafAnalysisResumeState = {
     revision: number;
     unitIndex: number; // next unit to analyze
     records: LeafAnalysisRecord[]; // completed so far
     usedOldIds: Set<number>;
     nextCacheId: number;
     // discovery outputs, so the snapshot phase is not repeated:
     snapshot: MarkdownBlockSnapshot;
     oldCandidates: ReadonlyMap<string, readonly MappedOldRecord[]>;
   };
   ```

   The unit loop already checkpoints every 32 units; on `yieldCheck` throw,
   catch _inside_ the transition, package the resume state, and rethrow a
   `LiveMdScheduledYield` carrying it.

2. `LiveMdSchedulerPlugin` — hold `resume: LeafAnalysisResumeState | null`;
   pass it back on the next attempt **iff** `pending.revision` is unchanged
   (any new keystroke invalidates it — positions in the resume state are in
   the current doc's coordinates and the next transaction would shift them;
   mapping resume state through changes is possible but not worth the
   complexity: under sustained typing in one block the transition is small
   anyway, and PR-5's input-yield cap bounds the worst case).

3. The inline-parser session must survive across resume slices (it is
   per-transition today, disposed in `finally`); move ownership to the
   resume state with an explicit `dispose()` on cancel/commit. Tree-sitter
   parser handles are the resource to be careful with — add a test that
   cancelled resumes do not leak (`inlineParserSessions` vs disposals in the
   trace).

**Files.** `analysis/markdown-leaf-cache.ts`, `runtime/field.ts`, tests.
**Size.** ~300 lines. **Risk.** Medium-high (resource lifetimes). This is
why it is sequenced after the reveal-policy PRs — those remove most of the
_visible_ pain; this one is a latency optimization.

### PR-10: Explicit invalidation contract for local discovery _(fixes A3)_

**Goal.** Replace "heuristic + retry + oracle tests" with a stated invariant
the code enforces.

**Changes.**

1. Write the contract as a doc comment on `collectLocalMarkdownSnapshot` and
   a new `docs/INVALIDATION.md`, enumerating exactly why each seed exists:
   - ±1 line context: setext headings (underline defines the previous
     line's leaf), list-item lazy continuation, blank-line separation
     changes;
   - mapped old safety ranges: leaves whose trimmed `sourceRange` /
     `effectRange` extends beyond the tree node (trailing blank-line trim in
     `leafSourceRange`);
   - filtered syntax ranges: genuine structural re-parses smaller than the
     broad-container threshold.

2. Reduce the sources of non-tree-derivable identity so the fixed point
   converges in one round in practice:
   - move blank-line trimming (`leafSourceRange`) from snapshot finish into
     leaf classification, so `sourceRange` is a pure function of (node,
     doc-lines-of-node) — the current cross-leaf `deepestLineMarker`
     dependency is only needed for lists that share terminal lines; add a
     targeted rule for that case instead of scanning markers;
   - marker-only line detection (`withMarkerOnlySourceIslands`) similarly
     depends only on (line, markers-on-line) — index markers by line once.

3. Turn the full-walk fallback into a traced anomaly: keep it (safety), but
   add `it` cases asserting `fixedPointRounds == 1` for the standard edit
   corpus, and log `fallbackCount` in the benchmark app so regressions are
   visible.

**Files.** `analysis/markdown-block-cursor.ts`,
`analysis/markdown-leaf-cache.ts`, new `docs/INVALIDATION.md`, tests.
**Size.** ~250 lines + docs. **Risk.** Medium (touches identity), guarded by
the oracle suite.

### PR-11: Replace the segmented-leaves Proxy with an explicit index _(fixes A6a)_

**Changes.**

1. New interface in `markdown-source-islands.ts`:

   ```ts
   export type SourceIslandIndex = {
     readonly length: number;
     at(index: number): LiveMdSourceIslandLeaf | undefined;
     find(doc: Text, position: number, assoc: -1 | 0 | 1): LiveMdSourceIslandLeaf | null;
     /** Materializes; O(n). Prefer at()/find(). */
     toArray(): readonly LiveMdSourceIslandLeaf[];
   };
   ```

2. The segmented implementation keeps its lazy per-segment mapping behind
   `at`/`find` (binary search over segment starts already exists); the array
   Proxy, `isArrayIndexProperty`, and the shadow `map/filter/every/some`
   methods are deleted. Callers that iterate
   (`activeMarkdownSourceRanges`, `sourceIslandLeavesInDoc`, tests) switch
   to `find`/`at` or an explicit `toArray()` where full iteration is truly
   needed — making every materialization grep-able.

3. Keep the "does not materialize during local transitions /
   selection-only reprojection" tests; they now assert `toArray` is not
   called (spy) instead of Proxy internals.

**Files.** `analysis/markdown-source-islands.ts`, `runtime/field.ts`,
tests. **Size.** ~200 lines, net negative. **Risk.** Low.

### PR-12: Small correctness/perf batch _(fixes A6c, A6d, A6e, R5e)_

1. **Fence highlight cache key (A6d)** — `render-cache.ts`: include the
   source text in the key for sources ≤ 16 KiB (typical fences), keep
   hash+length only above that but add the same `exactSourceMatches`-style
   verification by storing `source` on the cached result and comparing on
   hit:

   ```ts
   let cached = cache.codeFenceHighlights.get(key);
   if (cached && cached.source == source) return cached;
   ```

2. **Hand-written descriptor keys (A6c)** — replace `JSON.stringify` in
   `descriptorKey` / `dedupeDescriptors` / `stableAnalysisKey` /
   `markerCacheStructuralKey` / `TablePreviewWidget.tableKey` with a
   `liveMdDescriptorKey(descriptor)` switch over the closed union (this
   function already exists in `project-leaf.ts` — export and reuse it), and
   a `tableShapeKey`-style writer for tables. Benchmark before/after with
   `apps/live-md-benchmark` on the 10k fixture.

3. **Surface compiled-range eviction (A6e)** — in
   `LiveMdSurfacePlugin.refresh`, after patching, drop compiled ranges more
   than 2 viewport-heights from the current viewport:

   ```ts
   let keepWindow = {
     from: viewport.from - 2 * viewportHeight,
     to: viewport.to + 2 * viewportHeight,
   };
   this.surfaceState = evictSurfaceOutside(this.surfaceState, keepWindow);
   ```

   (clear the sets over the evicted ranges and subtract from
   `compiledRanges`; recompile on return via the existing subtract logic).

4. **Scroll read-ahead (R5e)** — extend `liveMdSurfaceVisibleRanges` by half
   a viewport in the last scroll direction (track `lastViewportFrom` on the
   plugin). One-line range extension; compile cost is bounded by the same
   per-range compile that already runs.

**Files.** `runtime/render-cache.ts`, `analysis/markdown-leaf-analysis.ts`,
`projection/project-leaf.ts`, `runtime/field.ts`, `core/widgets.ts`, tests.
**Size.** ~250 lines. **Risk.** Low.

---

## Sequencing and dependency graph

```
PR-0  reveal tracing/tests ──────────────┐
PR-1  ranges module ───────────┬─────────┤
                               ▼         ▼
PR-2  deflate edit surface (R1) ──► PR-3 syntax-range filter (R2)
                               │
                               ▼
PR-4  origin-sensitive reveal + task fast path (R3)
                               │
                               ▼
PR-5  bounded pending window (R4)      PR-6 widget sizes (R5) [independent]
                               │
        ┌──────────────────────┘
        ▼
PR-7  unified projection state machine (A2)
        │
        ▼
PR-8a per-leaf feature API (A5) ──► PR-8b delete legacy path (A1)
        │
        ▼
PR-9  resumable analysis (A4)          PR-10 invalidation contract (A3)
PR-11 SourceIslandIndex (A6a)          PR-12 small batch (A6c/d/e, R5e)
```

- **Phase 1 (PR-0…PR-6)** is the user-visible payoff: after PR-2 + PR-3 the
  worst unrelated blinking (whole-list reveals, container reveals) is gone;
  after PR-4 checkbox/undo/remote flicker is gone; after PR-5 sustained
  typing feels stable; after PR-6 scroll geometry is stable.
- **Phase 2 (PR-7…PR-12)** is the architecture payoff: one pipeline, one
  state machine, features that keep incrementality, and stated invariants.
- PR-6, PR-11, PR-12 are parallelizable at any point after PR-1.

## Risk register

| Risk                                                                          | PRs        | Mitigation                                                                                                                                                                                          |
| ----------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Under-revealing leaves stale destructive decorations during pending           | 2, 3, 4, 5 | Stale content is healed at commit by the incremental patch, which is computed from transition outputs independent of the edit surface; add explicit "edit inside collapsed widget reveals it" tests |
| Task fast path diverges from generic path                                     | 4          | Strict bail conditions; task toggles added to the random-edit oracle mix                                                                                                                            |
| Re-conceal during pending desyncs field vs surface plugin                     | 5          | Prefer landing PR-7 first if timing allows; otherwise implement via one shared helper both call                                                                                                     |
| Feature epoch in cache keys causes full invalidation on config identity churn | 8a         | README already mandates reference-stable feature arrays; epoch is per-object identity, matching existing compartment behavior                                                                       |
| Resume-state resource leaks (tree-sitter parsers)                             | 9          | Trace-based leak assertions (`inlineParserSessions` == disposals)                                                                                                                                   |
| Refactor regressions                                                          | 1, 7, 8b   | Every PR keeps the oracle-equivalence + random-edit suites green; they are the system's real spec                                                                                                   |

## Acceptance criteria for the stability goal

After Phase 1, all of the following hold and are enforced by tests:

1. Typing one character in a paragraph nested in a 50-line list item:
   `trace.editSurfaceLines <= 3`.
2. Splitting a fence with a structural keystroke: `editSurfaceLines` within
   3 lines of the caret; committed analysis equals oracle.
3. Task checkbox click: no pending state entered; no destructive clear
   outside the marker's replace range; widget DOM updated in place.
4. Remote (annotated) transaction: zero destructive clears; commit patch
   only.
5. 40-keystroke burst with input always pending: at least one commit lands
   (bounded yields); revealed region never exceeds current + previous
   block; final state equals oracle.
6. Table/mermaid/image widgets report `estimatedHeight`; mermaid
   placeholder min-height equals estimate; no document height change on
   async render completion beyond the measured-vs-estimate delta of the
   first render.
