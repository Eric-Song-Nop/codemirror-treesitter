import { EditorState, Facet, combineConfig, type Extension, type Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { syntaxTree } from "./language.js";
import { NodeProp, NodeType, SyntaxNode, Tree, type SyntaxNodeRef } from "./tree.js";

export interface Config {
  afterCursor?: boolean;
  brackets?: string;
  maxScanDistance?: number;
  renderMatch?: (match: MatchResult, state: EditorState) => readonly Range<Decoration>[];
}

const baseTheme = EditorView.baseTheme({
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "#328c8252" },
  "&.cm-focused .cm-nonmatchingBracket": { backgroundColor: "#bb555544" },
});

const DefaultScanDist = 10000;
const DefaultBrackets = "()[]{}";

const bracketMatchingConfig = Facet.define<Config, Required<Config>>({
  combine(configs) {
    return combineConfig(configs, {
      afterCursor: true,
      brackets: DefaultBrackets,
      maxScanDistance: DefaultScanDist,
      renderMatch: defaultRenderMatch,
    });
  },
});

const matchingMark = Decoration.mark({ class: "cm-matchingBracket" });
const nonmatchingMark = Decoration.mark({ class: "cm-nonmatchingBracket" });

function defaultRenderMatch(match: MatchResult) {
  let decorations = [];
  let mark = match.matched ? matchingMark : nonmatchingMark;
  decorations.push(mark.range(match.start.from, match.start.to));
  if (match.end) decorations.push(mark.range(match.end.from, match.end.to));
  return decorations;
}

function bracketDeco(state: EditorState) {
  let decorations: Range<Decoration>[] = [];
  let config = state.facet(bracketMatchingConfig);
  for (let range of state.selection.ranges) {
    if (!range.empty) continue;
    let match =
      matchBrackets(state, range.head, -1, config) ||
      (range.head > 0 && matchBrackets(state, range.head - 1, 1, config)) ||
      (config.afterCursor &&
        (matchBrackets(state, range.head, 1, config) ||
          (range.head < state.doc.length && matchBrackets(state, range.head + 1, -1, config))));
    if (match) decorations = decorations.concat(config.renderMatch(match, state));
  }
  return Decoration.set(decorations, true);
}

const bracketMatcher = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    paused = false;

    constructor(view: EditorView) {
      this.decorations = bracketDeco(view.state);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || this.paused) {
        if (update.view.composing) {
          this.decorations = this.decorations.map(update.changes);
          this.paused = true;
        } else {
          this.decorations = bracketDeco(update.state);
          this.paused = false;
        }
      }
    }
  },
  { decorations: (value) => value.decorations },
);

const bracketMatchingUnique = [bracketMatcher, baseTheme];

export function bracketMatching(config: Config = {}): Extension {
  return [bracketMatchingConfig.of(config), bracketMatchingUnique];
}

export const bracketMatchingHandle = new NodeProp<(node: SyntaxNode) => SyntaxNode | null>();

function matchingNodes(node: NodeType, dir: -1 | 1, brackets: string): null | readonly string[] {
  let byProp = node.prop(dir < 0 ? NodeProp.openedBy : NodeProp.closedBy);
  if (byProp) return byProp;
  if (node.name.length == 1) {
    let index = brackets.indexOf(node.name);
    if (index > -1 && index % 2 == (dir < 0 ? 1 : 0)) return [brackets[index + dir]!];
  }
  return null;
}

export interface MatchResult {
  start: { from: number; to: number };
  end?: { from: number; to: number };
  matched: boolean;
}

function findHandle(node: SyntaxNodeRef) {
  let hasHandle = node.type.prop(bracketMatchingHandle);
  return hasHandle ? hasHandle(node) : node;
}

export function matchBrackets(
  state: EditorState,
  pos: number,
  dir: -1 | 1,
  config: Config = {},
): MatchResult | null {
  let maxScanDistance = config.maxScanDistance || DefaultScanDist;
  let brackets = config.brackets || DefaultBrackets;
  let tree = syntaxTree(state);
  let node = tree.resolveInner(pos, dir);
  for (let cur: SyntaxNode | null = node; cur; cur = cur.parent) {
    let matches = matchingNodes(cur.type, dir, brackets);
    if (matches && cur.from < cur.to) {
      let handle = findHandle(cur);
      if (
        handle &&
        (dir > 0 ? pos >= handle.from && pos < handle.to : pos > handle.from && pos <= handle.to)
      ) {
        return matchMarkedBrackets(pos, dir, cur, handle, matches, brackets);
      }
    }
  }
  return matchPlainBrackets(state, pos, dir, tree, node.type, maxScanDistance, brackets);
}

function matchMarkedBrackets(
  _pos: number,
  dir: -1 | 1,
  token: SyntaxNode,
  handle: SyntaxNodeRef,
  matching: readonly string[],
  brackets: string,
) {
  let parent = token.parent;
  let firstToken = { from: handle.from, to: handle.to };
  let depth = 0;
  let cursor = parent?.cursor();
  try {
    if (cursor && (dir < 0 ? cursor.childBefore(token.from) : cursor.childAfter(token.to))) {
      do {
        if (dir < 0 ? cursor.to <= token.from : cursor.from >= token.to) {
          if (depth == 0 && matching.includes(cursor.type.name) && cursor.from < cursor.to) {
            let endHandle = findHandle(cursor.node);
            return {
              start: firstToken,
              end: endHandle ? { from: endHandle.from, to: endHandle.to } : undefined,
              matched: true,
            };
          }
          if (matchingNodes(cursor.type, dir, brackets)) {
            depth++;
          } else if (matchingNodes(cursor.type, -dir as -1 | 1, brackets)) {
            if (depth == 0) {
              let endHandle = findHandle(cursor.node);
              return {
                start: firstToken,
                end:
                  endHandle && endHandle.from < endHandle.to
                    ? { from: endHandle.from, to: endHandle.to }
                    : undefined,
                matched: false,
              };
            }
            depth--;
          }
        }
      } while (dir < 0 ? cursor.prevSibling() : cursor.nextSibling());
    }
    return { start: firstToken, matched: false };
  } finally {
    cursor?.delete();
  }
}

function matchPlainBrackets(
  state: EditorState,
  pos: number,
  dir: number,
  tree: Tree,
  tokenType: NodeType,
  maxScanDistance: number,
  brackets: string,
) {
  if (dir < 0 ? !pos : pos == state.doc.length) return null;
  let startCh = dir < 0 ? state.sliceDoc(pos - 1, pos) : state.sliceDoc(pos, pos + 1);
  let bracket = brackets.indexOf(startCh);
  if (bracket < 0 || (bracket % 2 == 0) != dir > 0) return null;

  let startToken = { from: dir < 0 ? pos - 1 : pos, to: dir > 0 ? pos + 1 : pos };
  let iter = state.doc.iterRange(pos, dir > 0 ? state.doc.length : 0);
  let depth = 0;
  for (let distance = 0; !iter.next().done && distance <= maxScanDistance; ) {
    let text = iter.value;
    if (dir < 0) distance += text.length;
    let basePos = pos + distance * dir;
    for (
      let offset = dir > 0 ? 0 : text.length - 1, end = dir > 0 ? text.length : -1;
      offset != end;
      offset += dir
    ) {
      let found = brackets.indexOf(text[offset]!);
      if (found < 0 || tree.resolveInner(basePos + offset, 1).type != tokenType) continue;
      if ((found % 2 == 0) == dir > 0) {
        depth++;
      } else if (depth == 1) {
        return {
          start: startToken,
          end: { from: basePos + offset, to: basePos + offset + 1 },
          matched: found >> 1 == bracket >> 1,
        };
      } else {
        depth--;
      }
    }
    if (dir > 0) distance += text.length;
  }
  return iter.done ? { start: startToken, matched: false } : null;
}
