# Maintained loro-codemirror binding

Source copied from loro-dev/loro-codemirror commit
`ed809e304dd83f7df9ad72343a2c0d6ea652a62f` (package version 0.3.3).
The upstream MIT license is preserved in `LICENSE`. Only runtime TypeScript
source and package metadata are included; upstream tooling and examples are omitted.

The root package override installs this source. Existing Vite aliases resolve its
`src` entry points, and `packages/live-md-loro` bundles it into its published output.
No upstream build or postinstall script is required.

Local changes:

- Skip unrelated events in mixed-container batches.
- Project all non-originating local and imported text changes through the sync
  plugin, including undo; remove the undo plugin's duplicate text subscription.
- Give each view a distinct commit origin and annotate every projection to avoid echoes.
- Annotate initialization instead of an armed dispatch guard and cancel it on destroy.

Regression coverage lives in `packages/live-md-loro/tests/collaboration.test.ts`.
When refreshing upstream, retain these fixes until equivalent coverage passes.

- Map remote presence through document changes immediately and resolve CRDT
  cursors again after imported/local changes; coalesce refreshes and cancel on destroy.
- Restore undo selections only when no newer local selection/edit exists;
  cancel queued commands/restorations on destroy and share callback ownership
  across views using one UndoManager.

The bundled LiveMD Loro package includes `LICENSE.loro-codemirror` for attribution.
Declaration generation may emit ignored `src/*.d.ts` artifacts, as it does for
workspace package sources; those files are not maintained source.

- Capture undo ownership and the source transaction's starting selection before
  writing a local edit into Loro, so another view cannot supply its cursor metadata.
- Process local transactions individually in batched CodeMirror updates, even
  when the same update also contains an already-synchronized transaction.
