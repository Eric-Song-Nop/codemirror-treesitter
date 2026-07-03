import { type ChangeDesc, RangeSet } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { type LeafAnalysisCache, type LeafAnalysisRecord } from "../analysis/descriptors.js";
import { rangesOverlap } from "../analysis/ranges.js";
import { type DocRange, type LiveMdLeafAnalysisTrace } from "../analysis/types.js";
import {
  createLiveMdBuild,
  finishProjectionLayers,
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
import {
  mapProjectionSets,
  patchProjectionSets,
  projectionLayerFromSets,
  projectionSetsFromLayer,
  type ProjectionSets,
} from "../runtime/projection-state.js";

export type LiveMdProjectionCompileInput = Omit<LiveMdBuildConfig, "trace"> & {
  trace: LiveMdLeafAnalysisTrace;
};

export type LiveMdVisibleSurfaceProjectionOptions = {
  codeFenceHighlights?: boolean;
};

export type LiveMdDirectProjectionPatchInput = {
  changes?: ChangeDesc;
  previous: ProjectionSets;
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
  let previous = patch.changes
    ? mapProjectionSets(patch.previous, patch.changes, [])
    : patch.previous;
  if (!ranges.length) return projectionLayerFromSets(previous);

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
  let compiled = projectionSetsFromLayer(finishProjectionLayers(build).direct);
  let removeOwnerKeys = new Set(patch.removeRecordIds.map(liveMdRecordOwnerKey));

  return projectionLayerFromSets(patchProjectionSets(previous, ranges, compiled, removeOwnerKeys));
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
    if (spec.kind == "codeFenceHighlight" && options.codeFenceHighlights === false) return [];
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
    if (spec.kind == "codeFenceHighlight" && options.codeFenceHighlights === false) return [];
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
          emitFrom: lineBoundaryFrom(build, range.from),
          emitTo: lineBoundaryTo(build, range.to),
        }),
      );
    case "mark":
    case "syntax":
      return intersectRanges(spec, ranges).map((range) => ({ ...spec, ...range }));
    case "replace":
      return ranges.some((range) => rangesOverlap(range, spec)) ? [spec] : [];
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
