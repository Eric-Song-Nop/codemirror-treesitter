import { type SyntaxNode, type TreeSitterQueryMatch } from "@codemirror-treesitter/language";
import { addAtom, addLineClass } from "../projection/emit.js";
import { forEachLineInRange, isWhitespaceOnly } from "../util.js";
import { capture, isParagraphContainerKind, nodeKey, sortedNodes } from "./query.js";
import { type LiveMdBuild, type ParagraphContainer } from "./types.js";

export function collectParagraphContainer(
  match: TreeSitterQueryMatch,
  containers: Map<string, ParagraphContainer>,
) {
  let containerCapture = capture(match, "paragraph.container");
  let childCapture = capture(match, "paragraph.child");
  let kind = match.setProperties?.["paragraph.kind"];
  if (!containerCapture || !childCapture || typeof kind != "string") return;
  if (!isParagraphContainerKind(kind)) return;

  let key = nodeKey(containerCapture.node);
  let container = containers.get(key);
  if (!container) {
    container = { children: [], kind, node: containerCapture.node };
    containers.set(key, container);
  }
  container.children.push(childCapture.node);
}

export function markParagraphBreaks(
  build: LiveMdBuild,
  containers: ReadonlyMap<string, ParagraphContainer>,
) {
  for (let container of containers.values()) {
    if (container.kind == "listItem") continue;
    let siblings = sortedNodes(container.children);
    let previousFrom =
      container.kind == "list"
        ? (node: SyntaxNode) => blockContainerBreakFrom(build, node, containers)
        : (node: SyntaxNode) => blockBreakFrom(build, node);
    for (let index = 1; index < siblings.length; index++) {
      markParagraphBreakRun(build, previousFrom(siblings[index - 1]!), siblings[index]!.from);
    }
    let last = siblings.at(-1);
    if (last) markParagraphBreakRun(build, previousFrom(last), container.node.to);
  }
}

function blockBreakFrom(build: LiveMdBuild, node: SyntaxNode): number {
  if (node.to <= node.from) return node.to;
  let before = node.to - 1;
  if (build.state.sliceDoc(before, node.to) != "\n") return node.to;
  return build.state.doc.lineAt(before).to;
}

function blockContainerBreakFrom(
  build: LiveMdBuild,
  node: SyntaxNode,
  containers: ReadonlyMap<string, ParagraphContainer>,
) {
  let blocks = sortedNodes(containers.get(nodeKey(node))?.children);
  return blocks.length ? blockBreakFrom(build, blocks[blocks.length - 1]!) : node.to;
}

function markParagraphBreakRun(build: LiveMdBuild, from: number, to: number) {
  if (from >= to || !isWhitespaceOnly(build.state.sliceDoc(from, to))) return;

  let newlinePositions: number[] = [];
  let source = build.state.sliceDoc(from, to);
  for (let index = 0; index < source.length; index++) {
    if (source.charCodeAt(index) == 10) newlinePositions.push(from + index);
  }

  let separatorCount = Math.floor(newlinePositions.length / 2);
  if (!separatorCount) return;

  let blankLines: number[] = [];
  forEachLineInRange(build.state, from, to, (line) => {
    if (line.from > from && isWhitespaceOnly(build.state.sliceDoc(line.from, line.to))) {
      blankLines.push(line.number);
    }
  });

  for (let index = 0; index < separatorCount; index++) {
    addAtom(build, newlinePositions[index * 2], newlinePositions[index * 2 + 1] + 1);

    let separatorLine = blankLines[index * 2];
    if (separatorLine == null) return;
    addLineClass(build, separatorLine, "cm-md-block-separator");
  }
}
