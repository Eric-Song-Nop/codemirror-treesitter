import { Text } from "@codemirror/state";
import { Decoration } from "@codemirror/view";
import { cachedLiveMdCodeFenceHighlightResult } from "../runtime/render-cache.js";
import { addMark } from "./emit.js";
import { type LiveMdBuild } from "./types.js";

export function addCodeFenceHighlights(
  build: LiveMdBuild,
  contentFrom: number,
  contentTo: number,
  emitFrom: number,
  emitTo: number,
  language: string,
  recordRenderKey: string,
) {
  if (contentFrom >= contentTo) return;

  let source = build.state.sliceDoc(contentFrom, contentTo);
  let sourceText = Text.of(source.split("\n"));
  let result = cachedLiveMdCodeFenceHighlightResult(
    build.renderCache,
    build.trace,
    source,
    build.codeFenceLanguages,
    build.codeFenceHighlighters,
    recordRenderKey,
    language,
  );
  let emitRelativeFrom = Math.max(0, emitFrom - contentFrom);
  let emitRelativeTo = Math.min(sourceText.length, emitTo - contentFrom);
  if (emitRelativeFrom >= emitRelativeTo) return;

  for (let span of result.spans) {
    let from = Math.max(span.from, emitRelativeFrom);
    let to = Math.min(span.to, emitRelativeTo);
    if (from >= to) continue;
    let decoration = Decoration.mark({ class: span.className });
    splitTextRangeByLine(sourceText, from, to, (rangeFrom, rangeTo) => {
      addMark(build, contentFrom + rangeFrom, contentFrom + rangeTo, decoration);
    });
  }
}

function splitTextRangeByLine(
  text: Text,
  from: number,
  to: number,
  visit: (from: number, to: number) => void,
) {
  let cursor = from;
  while (cursor < to) {
    let line = text.lineAt(cursor);
    let rangeTo = Math.min(to, line.to);
    if (cursor < rangeTo) visit(cursor, rangeTo);
    cursor = line.to < to ? line.to + 1 : to;
  }
}
