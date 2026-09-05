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
