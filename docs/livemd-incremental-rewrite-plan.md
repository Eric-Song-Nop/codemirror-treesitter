# LiveMD Incremental Rewrite Plan

This stack resets LiveMD to a clean full-document baseline before rebuilding
incremental analysis around Tree-sitter block parsing and leaf-local projection.

The current direction is:

```text
CodeMirror text changes
-> Tree-sitter Markdown block grammar reparses with the edited old tree
-> TreeCursor discovers affected LiveMD leaf blocks
-> changed paragraph/heading leaves run full inline parsing
-> changed tables parse all cells
-> changed fences rebuild fence-local projection
-> unchanged leaf analysis and effects are mapped and reused
```

Accepted local costs:

- Changed paragraph or heading: parse the whole leaf inline.
- Changed table: parse every cell in the table.
- Changed fence: rebuild that fence's preview and highlighting.
- Huge single paragraphs, tables, or unclosed fences may still be expensive.

Rejected designs:

- Viewport-driven semantic analysis.
- Paragraph gap/separator ownership as a long-term model.
- Persistent inline syntax trees and inline deltas.
- Generic nested-tree scheduling as the LiveMD hot path.
- Query-based block leaf discovery.
- Long-lived identity based on Tree-sitter node IDs.
- Generic dependency graphs for custom features.

Stack scope:

- PR62 removes the old viewport/dirty-range incremental path and keeps a
  full-document correctness baseline.
- PR63 splits the monolithic decorations runtime without behavior changes.
- PR64 introduces the `LiveMdEffect` projection model while still doing full
  rebuilds.
- PR65 removes paragraph separator/gap behavior so blank physical lines remain
  editable.
- PR66 fixes the TreeCursor wrapper hot-path APIs.
- PR67 is a draft spike for changed-leaf discovery and instrumentation.
