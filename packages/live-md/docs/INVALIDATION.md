# LiveMD Local Invalidation Contract

LiveMD commits most edits by replacing a local semantic-cache window instead of
walking the whole Markdown tree. The local path is correct when the discovery
seed is closed over every input that can change leaf identity. If the seed does
not close within the fixed-point retry limit, the runtime treats that as an
anomaly and falls back to a full walk.

## Seed Ranges

`collectLocalMarkdownSnapshot` starts from three range families.

1. Text-change line context

   Every text edit contributes the touched physical lines in the new document
   and in the old document, expanded by one line before and after. The neighbor
   lines are part of the contract because CommonMark block identity can be
   defined outside the edited bytes:
   - a setext heading underline defines the previous line's leaf;
   - a list item can lazily continue onto a following paragraph line;
   - adding or removing a blank separator can split or merge adjacent leaves.

2. Mapped old safety ranges

   Cached records are indexed by the union of their syntax range, source range,
   effect range, reveal range, and marker cache range. The old-document change
   lines are expanded by the same one-line context rule, then matched records'
   safety ranges are mapped through the edit and included in the seed. This
   covers leaves whose rendered identity is wider or narrower than the tree
   node, especially trailing blank-line trimming in `leafSourceRange`.

3. Filtered syntax ranges

   Parser-reported changed ranges are included after broad-container ranges are
   filtered out. This keeps genuine local structural reparses in the local path
   while avoiding whole-document cache churn when a parent container reports a
   large invalidation span.

## Fixed Point

After collecting the first local block snapshot, discovery expands the seed with
the collected leaf `sourceRange`s and marker physical lines. Simple line-local
edits are already closed and report `fixedPointRounds == 1`; broader structural
edits may need another round but remain range-local unless the retry limit is
hit.

The retry loop remains a safety check. If collected leaves or markers keep
expanding the seed for all retry rounds, `fallbackCount` is set and the caller
performs a full-walk semantic transition. Benchmarks surface this counter so a
future regression is visible even when correctness is preserved by fallback.

## Source Ranges

Leaf `sourceRange` is derived from the tree node's physical lines by trimming
terminal blank lines and, for list/quote nodes with shared terminal lines,
consulting marker ownership. Marker ownership is also used for context metadata,
such as quote marker ranges.

Marker-only source islands are built from markers indexed by physical line. A
line becomes a marker island only when it has marker records for that line,
does not overlap an existing leaf source range, and contains no non-marker text.
