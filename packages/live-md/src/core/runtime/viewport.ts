import type { EditorView } from "@codemirror/view";
import {
  clampLiveMdPosition,
  fullLiveMdDocRange,
  liveMdLineRangeFor,
  liveMdRangeContains,
  mergeLiveMdRanges,
} from "../analysis/index.js";
import type { LiveMdDocRange } from "../analysis/index.js";

export function visibleLiveMdLineRanges(view: EditorView): readonly LiveMdDocRange[] {
  if (view.scrollDOM.clientHeight == 0) return fullLiveMdDocRange(view.state);
  if (!liveMdRangesCoverSelection(view.visibleRanges, view)) {
    return fullLiveMdDocRange(view.state);
  }

  let ranges: LiveMdDocRange[] = [];
  for (let range of view.visibleRanges) {
    let from = clampLiveMdPosition(range.from, 0, view.state.doc.length);
    let to = clampLiveMdPosition(range.to, 0, view.state.doc.length);
    if (from > to) continue;
    ranges.push(liveMdLineRangeFor(view.state, from, to));
  }
  return mergeLiveMdRanges(ranges);
}

function liveMdRangesCoverSelection(ranges: readonly LiveMdDocRange[], view: EditorView) {
  for (let selectionRange of view.state.selection.ranges) {
    if (!ranges.some((range) => liveMdRangeContains(range, selectionRange.head))) {
      return false;
    }
  }
  return true;
}
