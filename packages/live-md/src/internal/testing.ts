// Test-only hooks. This module is not reachable from any package entry
// (`index`, `register`, `fixtures`); tests import it by relative path.
// Search hooks live in `search-testing.ts` because importing `core/search.ts`
// registers LiveMD's search test as a module side effect.
import type { EditorState } from "@codemirror/state";
import type { Tree } from "@codemirror-treesitter/language";
import type { EditorView } from "@codemirror/view";
import { clearLiveMdLinkMarkCache, liveMdLinkMarkCacheSize } from "../core/links.js";
import {
  buildCanonicalLiveMdAnalysis,
  buildLiveMdAnalysisSnapshot,
  flushLiveMdAnalysisTurns,
  liveMdViewAnalysisSnapshot,
  refreshLiveMdSurface,
} from "../core/runtime/field.js";
import { countNativeTrees, type LiveMdRenderCache } from "../core/runtime/render-cache.js";

export function __testBuildLiveMdAnalysis(state: EditorState) {
  return buildLiveMdAnalysisSnapshot(state);
}

export function __testBuildCanonicalLiveMdAnalysis(
  state: EditorState,
  renderCache?: LiveMdRenderCache,
) {
  return buildCanonicalLiveMdAnalysis(state, renderCache);
}

export function __testLiveMdAnalysis(view: EditorView | { state: EditorState }) {
  return liveMdViewAnalysisSnapshot(view);
}

export function __testRefreshLiveMdSurface(view: EditorView) {
  refreshLiveMdSurface(view);
}

export function __testRefreshLiveMdSurfacePreservingState(view: EditorView) {
  refreshLiveMdSurface(view, { preserveState: true });
}

export function __testFlushLiveMdAnalysis(view: EditorView) {
  return flushLiveMdAnalysisTurns(view);
}

export function __testLiveMdLinkMarkCacheSize() {
  return liveMdLinkMarkCacheSize();
}

export function __testClearLiveMdLinkMarkCache() {
  clearLiveMdLinkMarkCache();
}

export function __testCountNativeTrees(tree: Tree) {
  return countNativeTrees(tree);
}
