import { type ChangeDesc, type Range, RangeSet, type RangeValue } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { type LeafAnalysisCache, type LeafAnalysisRecord } from "../analysis/descriptors.js";
import { type DocRange, type LiveMdLeafAnalysisTrace } from "../analysis/types.js";
import {
  createLiveMdBuild,
  finishProjectionLayers,
  liveMdProjectionValueOwnerKeys,
  type LiveMdProjectionLayer,
  type LiveMdProjectionLayers,
} from "./emit.js";
import {
  liveMdEffectSpecLayer,
  liveMdEffectSpecLayerMapper,
  liveMdRecordMayProduceDirectLayout,
  liveMdRecordOwnerKey,
  projectLeafCacheRecords,
  projectLeafCacheRecordsTouchingRanges,
  projectLeafRecords,
  type LiveMdEffectSpecMapper,
} from "./project-leaf.js";
import { type LiveMdBuild, type LiveMdBuildConfig, type LiveMdEffectSpec } from "./types.js";

export type LiveMdProjectionCompileInput = Omit<LiveMdBuildConfig, "trace"> & {
  trace: LiveMdLeafAnalysisTrace;
};

export type LiveMdVisibleSurfaceProjectionOptions = {
  codeFenceHighlights?: boolean;
};

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
  let build = createCompileBuild(input);
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

  let build = createCompileBuild(input);
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

export function compileFullSurfaceProjection(
  input: LiveMdProjectionCompileInput,
  cache: LeafAnalysisCache,
  options: LiveMdVisibleSurfaceProjectionOptions = {},
): LiveMdProjectionLayer {
  recordSurfaceCompile(input, [{ from: 0, to: input.state.doc.length }]);
  let build = createCompileBuild(input);
  let before = build.trace.projectionRecords;
  projectLeafCacheRecords(build, cache, fullSurfaceSpec(build, options));
  build.trace.surfaceRecordsVisited += build.trace.projectionRecords - before;
  return finishProjectionLayers(build).surface;
}

export function compileVisibleSurfaceProjection(
  input: LiveMdProjectionCompileInput,
  cache: LeafAnalysisCache,
  ranges: readonly DocRange[],
  options: LiveMdVisibleSurfaceProjectionOptions = {},
): LiveMdProjectionLayer {
  if (!ranges.length) return emptyProjectionLayer();
  recordSurfaceCompile(input, ranges);
  let build = createCompileBuild(input);
  let before = build.trace.projectionRecords;
  projectLeafCacheRecordsTouchingRanges(
    build,
    cache,
    ranges,
    visibleSurfaceSpec(build, ranges, options),
  );
  build.trace.surfaceRecordsVisited += build.trace.projectionRecords - before;
  return finishProjectionLayers(build).surface;
}

export function compileVisibleSurfaceProjectionFromRecords(
  input: LiveMdProjectionCompileInput,
  records: readonly LeafAnalysisRecord[],
  ranges: readonly DocRange[],
  options: LiveMdVisibleSurfaceProjectionOptions = {},
): LiveMdProjectionLayer {
  if (!ranges.length || !records.length) return emptyProjectionLayer();
  recordSurfaceCompile(input, ranges);
  let build = createCompileBuild(input);
  let before = build.trace.projectionRecords;
  projectLeafRecords(build, records, visibleSurfaceSpec(build, ranges, options));
  build.trace.surfaceRecordsVisited += build.trace.projectionRecords - before;
  return finishProjectionLayers(build).surface;
}

export function compileProjectionLayersFromCache(
  input: LiveMdProjectionCompileInput,
  cache: LeafAnalysisCache,
): LiveMdProjectionLayers {
  let direct = compileFullDirectLayoutProjection(input, cache);
  let surface = compileFullSurfaceProjection(input, cache);
  return {
    atomicRanges: RangeSet.join([direct.atomicRanges, surface.atomicRanges]),
    decorations: RangeSet.join([direct.decorations, surface.decorations]),
    destructiveDecorations: RangeSet.join([
      direct.destructiveDecorations,
      surface.destructiveDecorations,
    ]),
    direct,
    interactiveDecorations: surface.interactiveDecorations,
    sourceSafeDecorations: RangeSet.join([
      direct.sourceSafeDecorations,
      surface.sourceSafeDecorations,
    ]),
    surface,
  };
}

function createCompileBuild(input: LiveMdProjectionCompileInput): LiveMdBuild {
  return createLiveMdBuild(input);
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

function directProjectionFromSets(
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

function patchOwnedRangeSet<T extends RangeValue>(
  current: RangeSet<T>,
  dirtyRanges: readonly DocRange[],
  additions: readonly Range<T>[],
  removeOwnerKeys: ReadonlySet<string>,
) {
  let next = current;
  let removalKeys = new Set(removeOwnerKeys);
  for (let addition of additions) {
    for (let ownerKey of liveMdProjectionValueOwnerKeys(addition.value)) {
      removalKeys.add(ownerKey);
    }
  }
  for (let range of dirtyRanges) {
    next = next.update({
      filter: (_from, _to, value) => {
        let ownerKeys = liveMdProjectionValueOwnerKeys(value);
        return !ownerKeys.some((ownerKey) => removalKeys.has(ownerKey));
      },
      filterFrom: range.from,
      filterTo: range.to,
    });
  }
  return additions.length ? next.update({ add: additions, sort: true }) : next;
}

function collectRangeSetRanges<T extends RangeValue>(
  rangeSet: RangeSet<T>,
  ranges: readonly DocRange[],
): Range<T>[] {
  let collected: Range<T>[] = [];
  if (!ranges.length) return collected;
  for (let range of ranges) {
    rangeSet.between(range.from, range.to, (from, to, value) => {
      collected.push(value.range(from, to));
    });
  }
  return collected;
}

function recordSurfaceCompile(input: LiveMdProjectionCompileInput, ranges: readonly DocRange[]) {
  input.trace.surfaceCompileCalls++;
  input.trace.surfaceCompileRanges = mergeCompileRanges([
    ...input.trace.surfaceCompileRanges,
    ...ranges,
  ]);
}

function mergeCompileRanges(ranges: readonly DocRange[]) {
  let sorted = ranges
    .filter((range) => range.from < range.to)
    .slice()
    .sort((left, right) => left.from - right.from || left.to - right.to);
  let merged: DocRange[] = [];
  for (let range of sorted) {
    let previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      merged.push({ from: range.from, to: range.to });
    }
  }
  return merged;
}

function fullSurfaceSpec(
  build: LiveMdBuild,
  options: LiveMdVisibleSurfaceProjectionOptions,
): LiveMdEffectSpecMapper {
  return (spec) => {
    if (liveMdEffectSpecLayer(build, spec) != "surface") return [];
    build.trace.surfaceDescriptorsMapped++;
    if (spec.kind == "codeFenceHighlight" && options.codeFenceHighlights !== true) return [];
    return [spec];
  };
}

function visibleSurfaceSpec(
  build: LiveMdBuild,
  ranges: readonly DocRange[],
  options: LiveMdVisibleSurfaceProjectionOptions,
): LiveMdEffectSpecMapper {
  return (spec) => {
    if (liveMdEffectSpecLayer(build, spec) == "direct") return [];
    build.trace.surfaceDescriptorsMapped++;
    if (spec.kind == "codeFenceHighlight" && options.codeFenceHighlights !== true) return [];
    return clipSurfaceSpec(build, spec, ranges);
  };
}

function clipSurfaceSpec(
  build: LiveMdBuild,
  spec: LiveMdEffectSpec,
  ranges: readonly DocRange[],
): readonly LiveMdEffectSpec[] {
  switch (spec.kind) {
    case "codeFenceHighlight":
      return intersectRanges({ from: spec.contentFrom, to: spec.contentTo }, ranges).map(
        (range) => ({
          ...spec,
          contentFrom: lineBoundaryFrom(build, range.from),
          contentTo: lineBoundaryTo(build, range.to),
        }),
      );
    case "mark":
    case "syntax":
      return intersectRanges(spec, ranges).map((range) => ({ ...spec, ...range }));
    case "replace":
      return ranges.some((range) => rangesTouch(range, spec)) ? [spec] : [];
    default:
      return [];
  }
}

function intersectRanges(range: DocRange, ranges: readonly DocRange[]) {
  let clipped: DocRange[] = [];
  let seen = new Set<string>();
  for (let visible of ranges) {
    let from = Math.max(range.from, visible.from);
    let to = Math.min(range.to, visible.to);
    if (from >= to) continue;
    let key = `${from}:${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clipped.push({ from, to });
  }
  return clipped;
}

function rangesTouch(left: DocRange, right: DocRange) {
  return left.from < right.to && right.from < left.to;
}

function lineBoundaryFrom(build: LiveMdBuild, position: number) {
  return build.state.doc.lineAt(Math.max(0, Math.min(position, build.state.doc.length))).from;
}

function lineBoundaryTo(build: LiveMdBuild, position: number) {
  return build.state.doc.lineAt(Math.max(0, Math.min(position, build.state.doc.length))).to;
}

function emptyProjectionLayer(): LiveMdProjectionLayer {
  return {
    atomicRanges: RangeSet.empty,
    decorations: Decoration.none,
    destructiveDecorations: Decoration.none,
    interactiveDecorations: Decoration.none,
    sourceSafeDecorations: Decoration.none,
  };
}
