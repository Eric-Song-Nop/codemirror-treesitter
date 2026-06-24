import { RangeSet } from "@codemirror/state";
import { type LeafAnalysisCache } from "../analysis/markdown-leaf-cache.js";
import { type LiveMdProjectionLayers } from "./emit.js";
import { compileFullDirectLayoutProjection } from "./direct-compiler.js";
import { compileFullSurfaceProjection } from "./surface-compiler.js";
import { type LiveMdProjectionCompileInput } from "./types.js";

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
