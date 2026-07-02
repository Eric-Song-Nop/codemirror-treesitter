# LiveMD Architecture & Render-Stability Review

Date: 2026-07-02
Scope: `packages/live-md` — incremental Markdown analysis, projection, runtime
scheduling, and render stability while editing.
Baseline commit: `40294b3` (LiveMD: Rewrite pending edit surface, #85).

This document records the full findings of an architecture and algorithm
review of the LiveMD in-place Markdown rendering editor, with a dedicated
section on render stability ("no unrelated blinking while editing"). A
companion document, [IMPROVEMENT_PLAN.md](./IMPROVEMENT_PLAN.md), turns every
problem recorded here into a concrete, PR-sized work plan.

Status update: Phase 0 of the improvement plan has landed the R6 measurement
work in draft PR #86. The runtime now records pending edit-surface ranges and
line counts in `LiveMdLeafAnalysisTrace`, and the test suite includes both a
passing paragraph-locality assertion and a current-behavior nested-list
inflation baseline.

---

## 1. System overview

LiveMD is a CodeMirror 6 extension stack that renders Markdown in place
(Typora/Obsidian-style "live preview") while keeping the document fully
editable as plain Markdown text. The pipeline, end to end:

```
                    ┌────────────────────────────────────────────────┐
                    │ incremental tree-sitter block parse            │
                    │ (packages/language, syntaxTree /               │
                    │  syntaxTreeChangedRanges)                      │
                    └───────────────┬────────────────────────────────┘
                                    ▼
                    ┌────────────────────────────────────────────────┐
 ANALYSIS           │ block snapshot: leaves + markers + context     │
                    │ core/analysis/markdown-block-cursor.ts         │
                    │  - walkMarkdownBlocks (full)                   │
                    │  - collectMarkdownBlocksInRanges (range-local) │
                    └───────────────┬────────────────────────────────┘
                                    ▼
                    ┌────────────────────────────────────────────────┐
                    │ leaf semantic analysis → DOM-free descriptors  │
                    │ core/analysis/markdown-leaf-analysis.ts        │
                    │ core/analysis/markdown-inline-analysis.ts      │
                    │ core/analysis/markdown-table-analysis.ts       │
                    │ core/analysis/markdown-fence-analysis.ts       │
                    └───────────────┬────────────────────────────────┘
                                    ▼
                    ┌────────────────────────────────────────────────┐
 CACHE              │ immutable leaf analysis cache (RangeSet-backed)│
                    │ core/analysis/markdown-leaf-cache.ts           │
                    │  - buildFreshLeafAnalysisCache                 │
                    │  - transitionLeafAnalysisCache (full walk)     │
                    │  - transitionLeafAnalysisCacheLocal (range-    │
                    │    local, fixed-point discovery)               │
                    └───────────────┬────────────────────────────────┘
                                    ▼
                    ┌────────────────────────────────────────────────┐
 PROJECTION         │ descriptors → CodeMirror effects/decorations   │
                    │ core/projection/project-leaf.ts (per record)   │
                    │ core/projection/compilers.ts (full/incremental │
                    │   direct layer, visible surface layer)         │
                    │ core/projection/emit.ts (layer assembly)       │
                    └───────────────┬────────────────────────────────┘
                                    ▼
                    ┌────────────────────────────────────────────────┐
 RUNTIME            │ StateField + scheduler + surface plugin        │
                    │ core/runtime/field.ts                          │
                    │  - liveMdAnalysisField (direct layer, pending  │
                    │    state machine)                              │
                    │  - liveMdSchedulerPlugin (idle-time recompute) │
                    │  - liveMdSurfacePlugin (viewport surface layer)│
                    │ core/runtime/render-cache.ts (KaTeX, Mermaid,  │
                    │   tables, images, fence highlights)            │
                    └────────────────────────────────────────────────┘
```

Key vocabulary used throughout the codebase and this document:

- **Leaf**: a block-level Markdown unit (paragraph, heading, table, fenced
  code, indented code, html block, thematic break) classified by
  `classifyMarkdownLeaf` (`markdown-block-cursor.ts:38`).
- **Marker**: a structural marker owned by a container (list marker, task
  marker, quote marker, block continuation).
- **Descriptor**: a DOM-free, leaf-relative semantic fact ("this range is a
  strong mark", "this is a task marker, checked") produced by analysis.
  Descriptors are stored offset-relative to `sourceRange.from`
  (`relativeDescriptors`, `markdown-leaf-analysis.ts:583`).
- **Record** (`LeafAnalysisRecord`): a leaf/marker plus its analysis
  (descriptors, structural effects, `analysisKey`, `renderKey`), identified by
  `cacheId`, with `range`, `sourceRange`, `effectRange`, and cache-matching
  keys.
- **Source island**: the source range revealed as raw Markdown when the
  selection is inside it (`markdown-source-islands.ts`).
- **Direct layer**: layout-affecting projection output (line classes, block
  replaces / multi-line replaces, atomic ranges) maintained document-wide in
  the StateField.
- **Surface layer**: cosmetic projection output (marks, syntax
  visible/hidden, code-fence highlights, inline replaces) compiled lazily per
  viewport in `liveMdSurfacePlugin`.
- **Pending analysis**: the state between a document change and the async
  scheduler committing a recomputed analysis; during this window old
  decorations are position-mapped and selectively cleared.
- **Edit surface**: the set of ranges whose destructive decorations are
  cleared (revealed to raw source) while an analysis is pending
  (`pendingEditSurface`, `field.ts:776`).

---

## 2. Detailed findings — strengths

These are properties of the current design that are correct, deliberate, and
should be preserved through any refactor.

### S1. Correct pipeline decomposition: analysis vs projection

The system separates _what a leaf means_ (analysis, DOM-free descriptors)
from _what to draw given selection/viewport_ (projection). Analysis results
are cacheable and reusable across edits because they do not depend on
selection or viewport; projection is cheap and recomputed as needed. This is
the separation that Typora/Obsidian-class editors need to get right for both
performance and testability, and LiveMD has it.

Evidence: `LeafAnalysis` carries only descriptors + keys
(`descriptors.ts`); active-line/active-source decisions happen at projection
time (`projectLeaf`, `project-leaf.ts:77-99`; `rangeTouchesActiveLine`,
`emit.ts:408`).

### S2. Leaf-relative descriptors in a RangeSet-backed cache

Records are stored in a `RangeSet<PositionedLeafRecord>` with payload ranges
_relative_ to an anchor (`leafRecordPayload`, `markdown-leaf-cache.ts:677`),
plus a parallel `safety` RangeSet indexing each record's invalidation range.
Consequences:

- `RangeSet.map(changes)` repositions the whole cache in O(log n) without
  touching payloads (`patchLeafAnalysisCache`, `markdown-leaf-cache.ts:618`).
- A record's analysis object identity survives edits elsewhere in the
  document, which is what makes render-key-based caching effective.
- Range queries (`findLeafAnalysisRecordEntriesTouchingRanges`) use
  CodeMirror's persistent interval tree instead of a hand-rolled index.

### S3. Paranoid reuse keying

Record reuse across a transition is keyed by
`kind + mapped identity range + mapped cacheSourceRange + contextKey +
sourceLength + sourceHash + structuralKey` (`matchKey`,
`markdown-leaf-cache.ts:1073`), and then — critically — verified by an
**exact text comparison** (`exactSourceMatches`,
`markdown-leaf-cache.ts:1058`) so a 32-bit FNV hash collision cannot silently
reuse a wrong analysis. Hash collisions are counted in the trace
(`sourceHashCollisions`). The README documents this explicitly ("exact source
text is used for the oracle so hash collisions cannot hide changed leaves").

### S4. Render keys decoupled from cache identity

`renderKey` = hash(kind, sourceHash, sourceLength, rendererVersion,
resolverEpoch, themeEpoch, referenceEpoch) (`stableRenderKey`,
`markdown-leaf-analysis.ts:522`). `cacheId` is deliberately excluded, so
record identity churn does not invalidate render work (README, PR78 notes).
Epoch helpers (`runtime/epochs.ts`) give object-identity-based epochs for
resolvers/highlighters/parsers. Theme or resolver changes rekey the cache
without semantic reanalysis (`rekeyLeafAnalysisCache`,
`markdown-leaf-cache.ts:146`).

### S5. Direct/surface projection layer split

Layout-affecting decorations (line classes, block replaces, atomics) are
document-wide and patched incrementally; cosmetic decorations are compiled
per visible range (`liveMdSurfacePlugin.refresh`, `field.ts:338`;
`compileVisibleSurfaceProjection`, `compilers.ts:125`). The layer decision is
centralized in `liveMdEffectSpecLayer` (`project-leaf.ts:182`) and
`isDirectLayoutEffect` (`emit.ts:353`): a replace is direct iff it is a block
replace or crosses a line break. This resolves the classic live-preview
tension between "decorate everything" (slow) and "decorate viewport"
(scrollbar/geometry jank when scrolling), because geometry-relevant
decorations never depend on the viewport.

### S6. Async scheduler with correct commit validation

Document changes put the field into a pending state synchronously (mapping
old decorations); recompute runs on idle time (rAF → 24 ms quiet delay →
`requestIdleCallback`, with `navigator.scheduling.isInputPending` checks)
(`scheduleLiveMdWork`, `field.ts:1092`). The commit effect is validated
against revision, doc length, runtime epochs, absence of a newer pending, and
range validity before being accepted (`canCommitScheduledAnalysis`,
`field.ts:1014`); stale results are dropped and traced
(`withStaleResultDrop`). This prevents the classic "flash wrong positions,
then fix" async failure.

### S7. Incremental direct-layer patching with owner keys

Direct projection is patched, not rebuilt: changed/removed record ids map to
owner keys stamped on decorations (`withProjectionOwnerKeys`,
`emit.ts:373`), and `patchOwnedRangeSet` (`compilers.ts:211`) removes only
decorations owned by invalidated records within dirty ranges before adding
the recompiled ones. The transition result feeds exactly the right patch
input (`directProjectionPatchInput`, `field.ts:1421`), including the
active-source-range diff (`activeDirectProjectionPatch`).

### S8. Widget `eq()` discipline and render cache

Every widget implements content-based `eq()` (`widgets.ts`):

| Widget               | `eq()` basis                                          |
| -------------------- | ----------------------------------------------------- |
| `TaskCheckboxWidget` | `checked`                                             |
| `LatexWidget`        | block + displayMode + source + tex + cached resultKey |
| `MermaidWidget`      | source                                                |
| `ListMarkerWidget`   | marker text                                           |
| `ImagePreviewWidget` | alt + src                                             |
| `TablePreviewWidget` | JSON of table model                                   |

Combined with the synchronous render cache (`render-cache.ts`) — which caches
KaTeX HTML, Mermaid render handles (with in-flight promise dedup and render
tokens against stale async application), table models, resolved image
sources, and code-fence highlight spans — a rebuilt DecorationSet at commit
produces `eq`-equal widgets, so CodeMirror reuses DOM nodes and unchanged
widgets never repaint. Mermaid SVGs are themed via CSS variables
(`beautifulMermaidThemeOptions`, `widgets.ts:180`), so theme changes recolor
without re-render.

### S9. Verification strategy: oracle equivalence + locality assertions

`tests/analysis-snapshot.test.ts` covers:

- full-document analysis equivalence after edits (against a canonical
  full-query oracle build, `buildCanonicalLiveMdAnalysis`, `field.ts:2051`);
- local vs full-walk vs fresh transition equivalence across block boundaries;
- 10,000-paragraph / 10,000-list-item / 10,000-quote-paragraph locality
  assertions (middle edits must not traverse the document);
- a deterministic random edit sequence equivalent to full-walk and fresh
  rebuilds;
- scheduler behavior (no start before first frame, no starvation on short
  idle deadlines, coalescing to latest revision, epoch changes stay on the
  scheduled path);
- non-materialization assertions for the segmented source-island leaves.

For an incremental system, equivalence-to-naive-rebuild tests are the tests
that matter, and they exist here. Trace counters
(`LiveMdLeafAnalysisTrace`) make locality measurable rather than assumed.

### S10. Selection-driven reveal is synchronous

Entering/leaving a source island on a selection-only transaction is handled
synchronously in the field update (`pendingSelectionAnalysis`, `field.ts:736`;
`canReuseDirectProjectionForSelectionOnly`, `field.ts:1842`), including the
minimal-diff active patch (`activeDirectProjectionPatch`, `field.ts:1496`).
There is no async gap when moving the caret between blocks.

---

## 3. Detailed findings — architecture problems

### A1. Three coexisting analysis pipelines (main structural debt)

The runtime carries four builders:

1. **Legacy full-document query path** — `buildLegacyLiveMdBuild` +
   `processMatches` (`field.ts:2100-2176`): runs the document-level
   tree-sitter decoration queries and processes every match.
2. **Full-walk cache transition** — `transitionLeafAnalysisCache`
   (`markdown-leaf-cache.ts:313`): walks all blocks, reuses unchanged records
   by key + exact compare.
3. **Range-local transition** — `transitionLeafAnalysisCacheLocal`
   (`markdown-leaf-cache.ts:402`): fixed-point local discovery, falls back
   to (2).
4. **Canonical oracle build** — `buildCanonicalLiveMdAnalysis`
   (`field.ts:2051`), test-only but exported through test hooks.

Critically, **any host feature with `query` + `decorate` forces the legacy
path**: `hasLegacyDocumentQueryFeature` (`field.ts:2151`) gates
`buildLiveMdAnalysis` into full query + full projection, disables the
selection-only reuse fast path, and triggers conservative recomputation on
every relevant change. Since `LiveMdMarkdownFeature` is the advertised
extension mechanism (README "Public Entries"), any real host configuration
with a custom feature loses the entire incremental machinery.

Symptoms: `field.ts` is 2,242 lines; the README needs three paragraphs of
migration caveats; every new behavior must be implemented or reasoned about
three times.

### A2. The pending-surface state machine exists twice

The operation "an edit landed: strip destructive projection from the edit
surface, position-map the rest" is implemented independently in two
components with different data shapes:

- **StateField**, direct layer: `pendingSourceAnalysis` (`field.ts:641-717`)
  maps `directSourceSafeDecorations`, maps + clears
  `directDestructiveDecorations` and `directAtomicRanges` over
  `editSurface.ranges`.
- **ViewPlugin**, surface layer: `mapPendingSurface` (`field.ts:392-417`)
  does the same map/clear over the same ranges against
  `LiveMdSurfaceProjectionState` (atoms/compiledRanges/destructive/
  interactive/sourceSafe), plus a separate `clearPendingActiveSurface`
  variant (`field.ts:419-437`) for selection-driven reveals during pending.

The two must agree on `editSurface.ranges` semantics forever. There is no
shared abstraction; a change to reveal policy must be made twice,
consistently, in code with different shapes. This is the largest clarity
risk in the runtime.

### A3. Fixed-point local discovery is a heuristic where an invariant should be

`collectLocalMarkdownSnapshot` (`markdown-leaf-cache.ts:816-858`) seeds check
ranges from: changed lines expanded ±1 line (`expandToLineContext`), mapped
safety ranges of affected old records, and filtered syntax-changed ranges
(`isBroadContainerSyntaxRange` discards container-sized ranges,
`markdown-leaf-cache.ts:1167`). It then expands to a fixed point over
collected leaf source ranges / marker line ranges, with a hard cap of 3
rounds before falling back to a full walk.

This works (Gate B passes; oracle tests pass), but it exists because leaf
identity is not purely tree-derived:

- `leafSourceRange` (`markdown-block-cursor.ts:358`) trims trailing
  whitespace-only lines and truncates at lines owned by a different
  block context (`deepestLineMarker` / `sameBlockOwnerContext`);
- `contextKey` depends on ancestor list/quote structure;
- marker-only source islands (`withMarkerOnlySourceIslands`,
  `markdown-source-islands.ts:344`) depend on cross-leaf line occupancy.

So the _real_ invalidation contract — "a leaf's analysis depends on at most N
lines beyond its tree node because of X" — is implicit, spread across the
±1-line expansion, the broad-container filter, and the retry loop. The
correctness argument is only recoverable from the oracle test matrix.

### A4. Analysis work is all-or-nothing per revision

A yield (input pending, or idle deadline exhausted) is a thrown
`LiveMdScheduledYield` (`field.ts:635`) that discards all work and
reschedules. Deadline yields are capped
(`liveMdSchedulerMaxDeadlineYields = 2`, after which deadlines are ignored),
but **input yields are unbounded**. Under sustained typing the analysis
restarts from scratch on every attempt and nothing commits until the user
pauses. The unit loops already checkpoint every 32 units
(`markdown-leaf-cache.ts:282,337,439`; `project-leaf.ts:130`), so the
skeleton for resumability exists, but completed records are not persisted
across yields.

Contrast: the tree-sitter parse itself (packages/language) is incremental
and resumable; the second-stage analysis is not.

### A5. Feature API cannot participate in incrementality

`LiveMdMarkdownFeature.decorate` receives a whole-document query match
context. There is no per-leaf feature hook, so features cannot contribute
descriptors to cache records, cannot be patched incrementally, and force the
legacy path (A1). The README explicitly notes the old viewport/dirty-range
feature API was removed in the v3 reset; nothing replaced it yet.

### A6. Smaller architecture items

- **A6a. Proxy-based segmented source-island leaves**
  (`createSegmentedSourceIslandLeaves`, `markdown-source-islands.ts:190-251`):
  a `Proxy` impersonating a readonly array to keep keystroke cost O(1);
  index access is lazy per segment, but `map/filter/every/some/iterator`
  silently materialize everything. Correctness depends on mapped positions
  staying sorted across composed changes (asserted only by tests). Laziness
  is an illusion rather than a contract.
- **A6b. Duplicated range-math utilities**: `mapRange`, `normalizeRanges` /
  `mergeCompileRanges`, `rangesTouch`, `clamp`, `hashString`,
  `dedupeDescriptors`, `keyParts` are each defined 3–5 times across
  `field.ts`, `markdown-leaf-cache.ts`, `markdown-source-islands.ts`,
  `markdown-block-cursor.ts`, `markdown-inline-analysis.ts`,
  `compilers.ts`, `render-cache.ts`, `widgets.ts`, with subtly different
  signatures (e.g. two different `rangesTouch` semantics: inclusive in
  `markdown-block-cursor.ts:577` vs point-aware in
  `markdown-leaf-cache.ts:1228`).
- **A6c. `JSON.stringify` as key/dedupe function on hot paths**:
  `descriptorKey` (`markdown-leaf-analysis.ts:544`), `dedupeDescriptors`
  (two copies), `stableAnalysisKey`, `markerCacheStructuralKey`,
  `TablePreviewWidget.tableKey`. Order-sensitive and allocation-heavy;
  descriptors are a closed union that admits a hand-written key.
- **A6d. Render-cache fence-key collision risk**: code-fence highlight cache
  keys use `hashString(source) + source.length`
  (`cachedLiveMdCodeFenceHighlightResult`, `render-cache.ts:204-213`) rather
  than embedding the source text as the latex/mermaid/table keys do. A
  32-bit collision at equal length would serve wrong highlight spans.
- **A6e. Surface plugin `compiledRanges` grow monotonically** per semantic
  revision as the user scrolls (`field.ts:380-383`); `subtractDocRanges` and
  `patchSurfaceProjectionState` costs grow with accumulated ranges. Memory
  is bounded by the doc, but work per update is not bounded by the viewport.

---

## 4. Detailed findings — render stability while editing

Goal property: **typing at position P must not change the rendered
appearance of any content the user would consider unrelated to P.** The two
failure classes are _flicker_ (destructive decorations removed then
restored) and _layout shift_ (block widgets un-collapsing / heights changing
above or at the viewport, moving content).

### How the current reveal machinery works (reference)

On a doc change (`pendingSourceAnalysis`, `field.ts:641`):

1. `pendingEditSurface` (`field.ts:776`) computes the edit surface as the
   merge of:
   - `changedLineRanges` — physical lines of the change (B-side);
   - `selectionPhysicalLineRanges` — physical lines of **all** selection
     ranges (`field.ts:813`);
   - `previousRanges` — the previous pending surface, mapped forward
     (accumulates until commit);
   - `touchedEffectRanges` — for every cached record whose
     range/sourceRange/effectRange/cacheSourceRange touches the changed old
     ranges: the mapped `range`, `sourceRange`, `effectRange`, and
     `cacheSourceRange` (`touchedRecordSafetyRanges`, `field.ts:819`);
   - `syntaxLineRanges` — tree-sitter changed ranges expanded to line ranges,
     **unfiltered** (`field.ts:789`).
2. Destructive decorations and atomic ranges are mapped, then **cleared over
   the whole edit surface** (`field.ts:687-694`); source-safe decorations are
   only mapped. The surface plugin does the same for its sets
   (`mapPendingSurface`, `field.ts:392`).
3. Healing happens only when the scheduler commits a fresh analysis
   (rAF + 24 ms quiet + idle callback at minimum; unbounded under sustained
   typing per A4).

### R1. Effect-range inflation reveals entire ancestor list items (worst blink source)

Chain of causes:

1. Every leaf's structural effects include a `lineClass` descriptor spanning
   each ancestor list item's **entire `itemRange`** (`contextDescriptors`,
   `markdown-leaf-analysis.ts:404-416`:
   `{ className: "cm-md-list-line", range: item.itemRange }`).
2. `analysisEffectRange` (`markdown-leaf-analysis.ts:590`) unions all
   descriptor ranges, so every record inside a list item has
   `effectRange ⊇` the whole item (nested lists: the outermost item).
3. The safety index (`recordInvalidationRange`,
   `markdown-leaf-cache.ts:1000`) unions `effectRange` in, so an edit to one
   line "touches" every record in the item.
4. `touchedRecordSafetyRanges` (`field.ts:819`) puts every touched record's
   mapped `effectRange` into the edit surface.
5. The edit surface clears destructive decorations (step 2 above).

Net effect: typing one character inside any list item strips **all**
concealment — hidden syntax, list bullets, task checkboxes, collapsed
tables/mermaid/LaTeX — across the outermost ancestor list item until commit.
In a document that is mostly one large nested list (very common for notes),
this approaches whole-document reveal per keystroke. Because block widgets
are `direct` layer, un-collapsing them changes document height → content
above/below shifts (scroll jank), in addition to flicker.

Note the asymmetry: for _cache invalidation_ and _commit-time patching_,
effect-range inflation is merely conservative (extra recompute, no visual
effect). It is only the _pending reveal_ usage that turns it into visible
blinking.

### R2. Unfiltered tree-sitter changed ranges feed the edit surface

`pendingEditSurface` includes `syntaxChangedRanges` expanded to line ranges
with no breadth filter (`field.ts:788-799`). Tree-sitter routinely reports
container-sized changed ranges for structural edits (typing `-`, `>`, or a
backtick at line start can mark the enclosing list/quote/fence changed). The
analysis layer protects itself with `isBroadContainerSyntaxRange`
(`markdown-leaf-cache.ts:1167`) — the edit surface does not. One structural
keystroke can therefore clear concealment across an entire container.

### R3. Non-caret edits blink by design

The reveal policy is unconditional on transaction origin: any doc change
clears destructive decorations on its changed lines. Cases where this is
wrong:

- **Task checkbox click**: `TaskCheckboxWidget.toDOM`'s click handler
  dispatches a one-character change (`widgets.ts:73-87`,
  `userEvent: "input.task"`). The changed line is the checkbox's own line →
  the widget the user just clicked is cleared, flashing raw `- [x]` until
  commit, then re-collapsing.
- **Undo/redo** of multi-range changes reveals every touched range at once.
- **Remote collaboration edits** (`live-md-loro`): a collaborator typing
  blinks lines in _your_ viewport even though your caret is elsewhere. The
  reveal exists to serve the local editor's caret; remote changes need only
  stale-map + commit-patch.

The correct policy is origin-sensitive: reveal-to-source only where the
local selection interacts with the change; elsewhere keep stale mapped
decorations (invisible for the ~1-frame-to-commit window) and let the commit
patch them.

### R4. Sustained typing grows the revealed region and defers healing

Two compounding behaviors:

- Edit surfaces **accumulate**: `previousRanges` are mapped forward and
  merged on every keystroke (`field.ts:786-787`), resetting only at commit.
- Commit requires a run without input-pending yields; input yields are
  unbounded (A4). Under fluent typing nothing commits.

Net effect: type across a few blocks and the raw-source region monotonically
expands behind the caret, then everything re-collapses at once when typing
pauses — a delayed, batched blink. Also, the scheduler imposes a floor of
rAF + 24 ms + idle callback even for trivial single-leaf edits
(`liveMdSchedulerQuietDelay = 24`, `field.ts:110`).

### R5. Layout-shift items (secondary)

- **R5a. No `estimatedHeight` on any block widget** (`widgets.ts`). When a
  table/mermaid/LaTeX-block widget re-enters after reveal or first scrolls
  into view, CodeMirror assumes default line height until measured → scroll
  position hops.
- **R5b. Mermaid placeholder → SVG swap reflows**: `renderMermaidInto`
  inserts a text placeholder ("Rendering Mermaid diagram") replaced by the
  SVG when the async render finishes (`widgets.ts:391-408`); heights differ
  → document shifts at an arbitrary later time.
- **R5c. `ImagePreviewWidget` reserves no intrinsic size**; async image load
  shifts layout below the image.
- **R5d. Selection lines always join the edit surface**
  (`selectionPhysicalLineRanges` merged unconditionally, `field.ts:785,792`)
  even when the change is elsewhere — with multi-cursor or programmatic
  edits this clears widgets on lines that did not change. (Mostly redundant
  for the caret case, since the caret's source island is already revealed by
  the active-source mechanism.)
- **R5e. Viewport-edge raw flash while scrolling fast**: the surface layer
  compiles per visible range on `viewportChanged`; fast scrolling can outrun
  compilation, briefly showing unstyled/undecorated text at the edges. CM's
  viewport margin mostly covers this; there is no read-ahead in the scroll
  direction.

### R6. Observability gap for the stability property

The trace counts `surfaceMapOnlyUpdates`, `staleResultDrops`,
`widgetConstructions`, etc., but nothing measures **revealed area per
keystroke** — the property this whole section is about. The 10k-document
tests assert analysis locality, not reveal locality. "No unrelated
blinking" is currently a UX hope, not a tested invariant.

---

## 5. Comparison to state of the art

CM6/Lezer live previews (Obsidian-style) typically skip second-stage
semantic caching entirely: they rebuild viewport decorations from the
incremental parse on every update, synchronously. They can afford this
because Lezer tree iteration is cheap and their decorations are mostly
viewport-scoped. LiveMD needs more machinery because (a) tree-sitter query
execution + a separate inline parser pass is costlier, and (b) the direct
layer is document-wide by design (for geometry stability).

Given those constraints, LiveMD's architecture — incremental parse feeding
an immutable content-addressed analysis cache feeding a two-layer projection
with validated async commit — is the right shape, and the components
expected of a SOTA implementation (mapping-through-changes, epoch
invalidation, staleness-validated commits, oracle testing, content-based
widget equality, render caching) are all present.

What separates it from "clear" is consolidation and policy:

- one production analysis path instead of three (A1);
- one pending-projection state machine instead of two (A2);
- a feature API that participates in the cache (A5);
- stated invariants where heuristics stand in (A3);
- a reveal policy scoped to the user's actual edit (R1–R4) — the single
  biggest gap between LiveMD today and the "nothing unrelated ever blinks"
  feel of the best-in-class editors, whose common keystroke never enters an
  async reveal window at all.

---

## 6. Finding index

| ID  | Severity     | Area         | Summary                                                                  |
| --- | ------------ | ------------ | ------------------------------------------------------------------------ |
| A1  | High         | Architecture | Three coexisting pipelines; custom features force legacy full-query path |
| A2  | High         | Architecture | Pending-surface state machine duplicated in field + surface plugin       |
| A3  | Medium       | Algorithm    | Fixed-point local discovery is heuristic; invalidation contract implicit |
| A4  | Medium       | Runtime      | Analysis all-or-nothing per revision; unbounded input-yield restarts     |
| A5  | High         | API          | Feature API cannot participate in incrementality                         |
| A6a | Low          | Code health  | Proxy-based segmented leaves: laziness is an illusion                    |
| A6b | Medium       | Code health  | Range-math/hash utilities duplicated 3–5× with divergent semantics       |
| A6c | Low          | Perf         | JSON.stringify keys/dedupe on hot paths                                  |
| A6d | Low          | Correctness  | Fence highlight cache key hash-only (collision risk)                     |
| A6e | Low          | Perf         | Surface compiledRanges grow monotonically per revision                   |
| R1  | **Critical** | Stability    | Effect-range inflation reveals whole ancestor list item per keystroke    |
| R2  | High         | Stability    | Unfiltered syntax changed ranges inflate edit surface                    |
| R3  | High         | Stability    | Checkbox clicks / undo / remote edits blink by design                    |
| R4  | High         | Stability    | Sustained typing grows reveal region; healing deferred indefinitely      |
| R5a | Medium       | Stability    | No estimatedHeight on block widgets                                      |
| R5b | Medium       | Stability    | Mermaid placeholder→SVG swap reflows                                     |
| R5c | Low          | Stability    | Image widgets reserve no intrinsic size                                  |
| R5d | Low          | Stability    | Selection lines join edit surface unconditionally                        |
| R5e | Low          | Stability    | Viewport-edge raw flash on fast scroll                                   |
| R6  | Medium       | Testing      | No measurement/tests for revealed-area-per-keystroke                     |

See [IMPROVEMENT_PLAN.md](./IMPROVEMENT_PLAN.md) for the remediation plan,
proposed code changes, and PR breakdown.
