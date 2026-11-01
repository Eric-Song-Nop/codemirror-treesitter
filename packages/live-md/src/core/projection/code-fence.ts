import { type Text } from "@codemirror/state";
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
  let result = cachedLiveMdCodeFenceHighlightResult(
    build.renderCache,
    build.trace,
    source,
    build.codeFenceLanguages,
    build.codeFenceHighlighters,
    recordRenderKey,
    language,
    { from: contentFrom, to: contentTo },
  );
  let emitRelativeFrom = Math.max(0, emitFrom - contentFrom);
  let emitRelativeTo = Math.min(source.length, emitTo - contentFrom);
  if (emitRelativeFrom >= emitRelativeTo) return;

  for (let span of result.spans) {
    let from = Math.max(span.from, emitRelativeFrom);
    let to = Math.min(span.to, emitRelativeTo);
    if (from >= to) continue;
    let decoration = Decoration.mark({ class: span.className });
    splitTextRangeByLine(
      build.state.doc,
      contentFrom + from,
      contentFrom + to,
      (rangeFrom, rangeTo) => {
        addMark(build, rangeFrom, rangeTo, decoration);
      },
    );
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
