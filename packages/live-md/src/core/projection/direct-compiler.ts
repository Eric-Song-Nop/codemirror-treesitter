import { type ChangeDesc, RangeSet } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { type LeafAnalysisRecord } from "../analysis/descriptors.js";
import { type LeafAnalysisCache } from "../analysis/markdown-leaf-cache.js";
import { type DocRange } from "../analysis/types.js";
import { createLiveMdBuild, finishProjectionLayers, type LiveMdProjectionLayer } from "./emit.js";
import {
  liveMdEffectSpecLayerMapper,
  liveMdRecordMayProduceDirectLayout,
  liveMdRecordOwnerKey,
  projectLeafCacheRecords,
  projectLeafRecords,
} from "./project-leaf.js";
import {
  collectRangeSetRanges,
  mergeCompileRanges,
  patchOwnedRangeSet,
} from "./range-set-patch.js";
import { type LiveMdBuild, type LiveMdProjectionCompileInput } from "./types.js";

export type LiveMdDirectProjectionPatchInput = {
  changes?: ChangeDesc;
  previous: Pick<
    LiveMdProjectionLayer,
    "atomicRanges" | "destructiveDecorations" | "sourceSafeDecorations"
  >;
  ranges: readonly DocRange[];
  records: readonly LeafAnalysisRecord[];
  removeRecordIds: readonly number[];
};

export function compileFullDirectLayoutProjection(
  input: LiveMdProjectionCompileInput,
  cache: LeafAnalysisCache,
  extend?: (build: LiveMdBuild) => void,
): LiveMdProjectionLayer {
  input.trace.directProjectionWindows = mergeCompileRanges([
    ...input.trace.directProjectionWindows,
    { from: 0, to: input.state.doc.length },
  ]);
  let build = createLiveMdBuild(input);
  let projected = projectLeafCacheRecords(
    build,
    cache,
    liveMdEffectSpecLayerMapper("direct"),
    liveMdRecordMayProduceDirectLayout,
  );
  input.trace.directProjectionRecords += projected;
  extend?.(build);
  return finishProjectionLayers(build).direct;
}

export function compileIncrementalDirectLayoutProjection(
  input: LiveMdProjectionCompileInput,
  _cache: LeafAnalysisCache,
  patch: LiveMdDirectProjectionPatchInput,
): LiveMdProjectionLayer {
  let ranges = mergeCompileRanges(patch.ranges);
  let previous = mapDirectProjectionLayer(patch.previous, patch.changes);
  if (!ranges.length) return directProjectionFromSets(previous);

  input.trace.directProjectionWindows = mergeCompileRanges([
    ...input.trace.directProjectionWindows,
    ...ranges,
  ]);

  let build = createLiveMdBuild(input);
  let projected = projectLeafRecords(
    build,
    patch.records,
    liveMdEffectSpecLayerMapper("direct"),
    liveMdRecordMayProduceDirectLayout,
  );
  input.trace.directProjectionRecords += projected;
  let compiled = finishProjectionLayers(build).direct;
  let removeOwnerKeys = new Set(patch.removeRecordIds.map(liveMdRecordOwnerKey));
  let allCompiledRanges = [{ from: 0, to: input.state.doc.length }];

  return directProjectionFromSets({
    atomicRanges: patchOwnedRangeSet(
      previous.atomicRanges,
      ranges,
      collectRangeSetRanges(compiled.atomicRanges, allCompiledRanges),
      removeOwnerKeys,
    ),
    destructiveDecorations: patchOwnedRangeSet(
      previous.destructiveDecorations,
      ranges,
      collectRangeSetRanges(compiled.destructiveDecorations, allCompiledRanges),
      removeOwnerKeys,
    ),
    sourceSafeDecorations: patchOwnedRangeSet(
      previous.sourceSafeDecorations,
      ranges,
      collectRangeSetRanges(compiled.sourceSafeDecorations, allCompiledRanges),
      removeOwnerKeys,
    ),
  });
}

function mapDirectProjectionLayer(
  previous: LiveMdDirectProjectionPatchInput["previous"],
  changes: ChangeDesc | undefined,
) {
  if (!changes) return previous;
  return {
    atomicRanges: previous.atomicRanges.map(changes),
    destructiveDecorations: previous.destructiveDecorations.map(changes),
    sourceSafeDecorations: previous.sourceSafeDecorations.map(changes),
  };
}

export function directProjectionFromSets(
  input: LiveMdDirectProjectionPatchInput["previous"],
): LiveMdProjectionLayer {
  return {
    atomicRanges: input.atomicRanges,
    decorations: RangeSet.join([input.sourceSafeDecorations, input.destructiveDecorations]),
    destructiveDecorations: input.destructiveDecorations,
    interactiveDecorations: Decoration.none,
    sourceSafeDecorations: input.sourceSafeDecorations,
  };
}
