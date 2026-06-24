import { type LeafAnalysisRecord } from "../analysis/descriptors.js";
import { type LeafAnalysisCache } from "../analysis/markdown-leaf-cache.js";
import { type DocRange } from "../analysis/types.js";
import { createLiveMdBuild, finishProjectionLayers, type LiveMdProjectionLayer } from "./emit.js";
import {
  liveMdEffectSpecLayer,
  projectLeafCacheRecords,
  projectLeafCacheRecordsTouchingRanges,
  projectLeafRecords,
  type LiveMdEffectSpecMapper,
} from "./project-leaf.js";
import { emptyProjectionLayer, mergeCompileRanges } from "./range-set-patch.js";
import {
  type LiveMdBuild,
  type LiveMdEffectSpec,
  type LiveMdProjectionCompileInput,
} from "./types.js";

export type LiveMdVisibleSurfaceProjectionOptions = {
  codeFenceHighlights?: boolean;
};

export function compileFullSurfaceProjection(
  input: LiveMdProjectionCompileInput,
  cache: LeafAnalysisCache,
  options: LiveMdVisibleSurfaceProjectionOptions = {},
): LiveMdProjectionLayer {
  recordSurfaceCompile(input, [{ from: 0, to: input.state.doc.length }]);
  let build = createLiveMdBuild(input);
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
  let build = createLiveMdBuild(input);
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
  let build = createLiveMdBuild(input);
  let before = build.trace.projectionRecords;
  projectLeafRecords(build, records, visibleSurfaceSpec(build, ranges, options));
  build.trace.surfaceRecordsVisited += build.trace.projectionRecords - before;
  return finishProjectionLayers(build).surface;
}

function recordSurfaceCompile(input: LiveMdProjectionCompileInput, ranges: readonly DocRange[]) {
  input.trace.surfaceCompileCalls++;
  input.trace.surfaceCompileRanges = mergeCompileRanges([
    ...input.trace.surfaceCompileRanges,
    ...ranges,
  ]);
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
