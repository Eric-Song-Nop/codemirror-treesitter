import { RangeSet } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { type LeafAnalysisCache, type LeafAnalysisRecord } from "../analysis/descriptors.js";
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

export function compileFullDirectLayoutProjection(
  input: LiveMdProjectionCompileInput,
  cache: LeafAnalysisCache,
  extend?: (build: LiveMdBuild) => void,
): LiveMdProjectionLayer {
  let build = createCompileBuild(input);
  projectLeafCacheRecords(
    build,
    cache,
    liveMdEffectSpecLayerMapper("direct"),
    liveMdRecordMayProduceDirectLayout,
  );
  extend?.(build);
  return finishProjectionLayers(build).direct;
}

export function compileFullSurfaceProjection(
  input: LiveMdProjectionCompileInput,
  cache: LeafAnalysisCache,
): LiveMdProjectionLayer {
  let build = createCompileBuild(input);
  projectLeafCacheRecords(build, cache, liveMdEffectSpecLayerMapper("surface"));
  return finishProjectionLayers(build).surface;
}

export function compileVisibleSurfaceProjection(
  input: LiveMdProjectionCompileInput,
  cache: LeafAnalysisCache,
  ranges: readonly DocRange[],
  options: LiveMdVisibleSurfaceProjectionOptions = {},
): LiveMdProjectionLayer {
  if (!ranges.length) return emptyProjectionLayer();
  let build = createCompileBuild(input);
  projectLeafCacheRecordsTouchingRanges(
    build,
    cache,
    ranges,
    visibleSurfaceSpec(build, ranges, options),
  );
  return finishProjectionLayers(build).surface;
}

export function compileVisibleSurfaceProjectionFromRecords(
  input: LiveMdProjectionCompileInput,
  records: readonly LeafAnalysisRecord[],
  ranges: readonly DocRange[],
  options: LiveMdVisibleSurfaceProjectionOptions = {},
): LiveMdProjectionLayer {
  if (!ranges.length || !records.length) return emptyProjectionLayer();
  let build = createCompileBuild(input);
  projectLeafRecords(build, records, visibleSurfaceSpec(build, ranges, options));
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

function visibleSurfaceSpec(
  build: LiveMdBuild,
  ranges: readonly DocRange[],
  options: LiveMdVisibleSurfaceProjectionOptions,
): LiveMdEffectSpecMapper {
  return (spec) => {
    if (liveMdEffectSpecLayer(build, spec) == "direct") return [];
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
