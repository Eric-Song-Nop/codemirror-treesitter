import { type EditorState } from "@codemirror/state";
import {
  syntaxTree,
  type SyntaxNode,
  type TreeSitterQueryMatch,
} from "@codemirror-treesitter/language";
import { isWhitespace } from "../util.js";
import {
  createLiveMdUnitId,
  liveMdOwnerId,
  liveMdSemanticCaptures,
  liveMdSemanticSource,
  liveMdUnitSignature,
} from "./ids.js";
import {
  activeLiveMdLines,
  expandLiveMdQueryRanges,
  fullLiveMdDocRange,
  liveMdNodeRange,
  normalizeLiveMdRanges,
} from "./ranges.js";
import { liveMdCapture, liveMdMatchKind, queryLiveMdSemanticMatches } from "./query.js";
import { createLiveMdUnitIndex } from "./unit-index.js";
import type {
  LiveMdDocRange,
  LiveMdInlineMarkKind,
  LiveMdParagraphContainerKind,
  LiveMdSemanticIndex,
  LiveMdSemanticUnit,
  LiveMdSemanticUnitBase,
} from "./types.js";

export type BuildLiveMdSemanticIndexOptions = {
  activeLines?: ReadonlySet<number>;
  ranges?: readonly LiveMdDocRange[];
};

export function buildLiveMdSemanticIndex(
  state: EditorState,
  options: BuildLiveMdSemanticIndexOptions = {},
): LiveMdSemanticIndex {
  let tree = syntaxTree(state);
  let ranges = normalizeLiveMdRanges(state, options.ranges ?? fullLiveMdDocRange(state));
  let queryRanges = expandLiveMdQueryRanges(state, ranges);
  let units = collectLiveMdSemanticUnits(state, queryLiveMdSemanticMatches(tree, queryRanges));
  let unitIndex = createLiveMdUnitIndex(units);

  return {
    activeLines: options.activeLines ?? activeLiveMdLines(state),
    docLength: state.doc.length,
    ownerRanges: unitIndex.ownerRanges,
    queryRanges,
    ranges,
    tree,
    unitIndex,
    units: unitIndex.units,
    unitsById: unitIndex.unitsById,
    unitsByOwnerId: unitIndex.unitsByOwnerId,
  };
}

function collectLiveMdSemanticUnits(
  state: EditorState,
  matches: ReturnType<typeof queryLiveMdSemanticMatches>,
) {
  let units: LiveMdSemanticUnit[] = [];
  let seen = new Set<string>();

  for (let { match } of matches) {
    for (let unit of unitsForLiveMdMatch(state, match)) {
      if (seen.has(unit.id)) continue;
      seen.add(unit.id);
      units.push(unit);
    }
  }

  return units.sort(
    (left, right) =>
      left.range.from - right.range.from ||
      left.range.to - right.range.to ||
      left.kind.localeCompare(right.kind),
  );
}

function unitsForLiveMdMatch(state: EditorState, match: TreeSitterQueryMatch) {
  let units: LiveMdSemanticUnit[] = [];
  let paragraphContainer = liveMdParagraphContainerUnit(match);
  if (paragraphContainer) units.push(paragraphContainer);

  let featureUnit = liveMdFeatureUnit(state, match);
  if (featureUnit) units.push(featureUnit);

  for (let capture of match.captures) {
    let unit = simpleLiveMdCaptureUnit(state, match, capture.name, capture.node);
    if (unit) units.push(unit);
  }

  return units;
}

function liveMdFeatureUnit(
  state: EditorState,
  match: TreeSitterQueryMatch,
): LiveMdSemanticUnit | null {
  switch (liveMdMatchKind(match)) {
    case "codeFence":
      return liveMdCodeFenceUnit(state, match);
    case "heading":
      return liveMdHeadingUnit(match);
    case "image":
      return liveMdImageUnit(match);
    case "latex":
      return liveMdLatexUnit(match);
    case "link":
      return liveMdLinkUnit(match);
    case "rule":
      return liveMdRuleUnit(match);
    case "table":
      return liveMdTableUnit(match);
    default:
      return null;
  }
}

function liveMdHeadingUnit(match: TreeSitterQueryMatch): LiveMdSemanticUnit | null {
  let node = liveMdCapture(match, "heading")?.node;
  if (!node) return null;
  let marker = liveMdCapture(match, "heading.marker")?.node;
  let level = Number(match.setProperties?.["heading.level"]) || 1;
  return {
    ...baseLiveMdUnit("heading", node, match, ["heading", level], node),
    level,
    markerRange: nodeRangeOrNull(marker),
  };
}

function liveMdCodeFenceUnit(
  state: EditorState,
  match: TreeSitterQueryMatch,
): LiveMdSemanticUnit | null {
  let node = liveMdCapture(match, "codeFence")?.node;
  if (!node) return null;
  let languageNode = liveMdCapture(match, "codeFence.language")?.node;
  let contentNode = liveMdCapture(match, "codeFence.content")?.node;
  let language = readLiveMdFenceLanguage(state, languageNode);
  return {
    ...baseLiveMdUnit(
      "codeFence",
      node,
      match,
      ["codeFence", language, contentNode ? state.sliceDoc(contentNode.from, contentNode.to) : ""],
      node,
    ),
    closeRange: nodeRangeOrNull(liveMdCapture(match, "codeFence.close")?.node),
    contentRange: nodeRangeOrNull(contentNode),
    language,
    languageRange: nodeRangeOrNull(languageNode),
    openRange: nodeRangeOrNull(liveMdCapture(match, "codeFence.open")?.node),
  };
}

function liveMdImageUnit(match: TreeSitterQueryMatch): LiveMdSemanticUnit | null {
  let node = liveMdCapture(match, "image")?.node;
  if (!node) return null;
  let alt = liveMdCapture(match, "image.description")?.node;
  let destination = liveMdCapture(match, "image.destination")?.node;
  return {
    ...baseLiveMdUnit("image", node, match, ["image", node.text], node),
    altRange: nodeRangeOrNull(alt),
    destinationRange: nodeRangeOrNull(destination),
  };
}

function liveMdLatexUnit(match: TreeSitterQueryMatch): LiveMdSemanticUnit | null {
  let node = liveMdCapture(match, "latex")?.node;
  if (!node) return null;
  return {
    ...baseLiveMdUnit("latex", node, match, ["latex", node.text], node),
    closeRange: nodeRangeOrNull(liveMdCapture(match, "latex.close")?.node),
    openRange: nodeRangeOrNull(liveMdCapture(match, "latex.open")?.node),
  };
}

function liveMdLinkUnit(match: TreeSitterQueryMatch): LiveMdSemanticUnit | null {
  let node = liveMdCapture(match, "link")?.node;
  if (!node) return null;
  return {
    ...baseLiveMdUnit("link", node, match, ["link", node.text], node),
    destinationRange: nodeRangeOrNull(liveMdCapture(match, "link.destination")?.node),
    textRange: nodeRangeOrNull(liveMdCapture(match, "link.text")?.node),
  };
}

function liveMdRuleUnit(match: TreeSitterQueryMatch): LiveMdSemanticUnit | null {
  let node = liveMdCapture(match, "rule")?.node;
  if (!node) return null;
  return baseLiveMdUnit("rule", node, match, ["rule"], node);
}

function liveMdTableUnit(match: TreeSitterQueryMatch): LiveMdSemanticUnit | null {
  let node = liveMdCapture(match, "table")?.node;
  if (!node) return null;
  return {
    ...baseLiveMdUnit("table", node, match, ["table", node.text], node),
    delimiterRowRange: nodeRangeOrNull(liveMdCapture(match, "table.delimiter.row")?.node),
  };
}

function liveMdParagraphContainerUnit(match: TreeSitterQueryMatch): LiveMdSemanticUnit | null {
  let container = liveMdCapture(match, "paragraph.container")?.node;
  let child = liveMdCapture(match, "paragraph.child")?.node;
  let containerKind = match.setProperties?.["paragraph.kind"];
  if (!container || !child || typeof containerKind != "string") return null;
  if (!isLiveMdParagraphContainerKind(containerKind)) return null;
  return {
    ...baseLiveMdUnit(
      "paragraphContainer",
      container,
      match,
      ["paragraphContainer", containerKind, child.name, child.from, child.to],
      container,
    ),
    childRange: liveMdNodeRange(child),
    containerKind,
  };
}

function simpleLiveMdCaptureUnit(
  state: EditorState,
  match: TreeSitterQueryMatch,
  name: string,
  node: SyntaxNode,
): LiveMdSemanticUnit | null {
  switch (name) {
    case "blockquote":
      return baseLiveMdUnit("blockquote", node, match, [name], node);
    case "list.item":
      return baseLiveMdUnit("listItem", node, match, [name], node);
    case "list.marker":
      return {
        ...baseLiveMdUnit(
          "listMarker",
          node,
          match,
          [name, state.sliceDoc(node.from, node.to)],
          node,
        ),
        marker: state.sliceDoc(node.from, node.to),
      };
    case "mark.emphasis":
    case "mark.inlineCode":
    case "mark.strike":
    case "mark.strong":
      return {
        ...baseLiveMdUnit("inlineMark", node, match, [name], node),
        mark: liveMdInlineMarkKind(name),
      };
    case "syntax":
      return {
        ...baseLiveMdUnit("syntax", node, match, [name, node.name], node),
        captureName: name,
      };
    case "task.checked":
    case "task.unchecked":
      return {
        ...baseLiveMdUnit("taskMarker", node, match, [name], node),
        checked: name == "task.checked",
      };
    case "uriAutolink":
      return baseLiveMdUnit("uriAutolink", node, match, [name], node);
    default:
      return null;
  }
}

function baseLiveMdUnit<Kind extends LiveMdSemanticUnit["kind"]>(
  kind: Kind,
  node: SyntaxNode,
  match: TreeSitterQueryMatch,
  signatureParts: readonly unknown[],
  ownerNode = node,
): LiveMdSemanticUnitBase<Kind> {
  let range = liveMdNodeRange(node);
  let ownerRange = liveMdNodeRange(ownerNode);
  let captures = liveMdSemanticCaptures(match);
  let signature = liveMdUnitSignature(signatureParts);
  let source = liveMdSemanticSource(
    liveMdMatchKind(match),
    node,
    match.patternIndex,
    captures,
    match.setProperties ?? null,
  );
  return {
    captures,
    id: createLiveMdUnitId(["unit", kind, node.name, range.from, range.to, signature]),
    kind,
    ownerId: liveMdOwnerId(kind, ownerRange, ownerNode.name),
    ownerRange,
    range,
    signature,
    source,
  };
}

function nodeRangeOrNull(node: SyntaxNode | null | undefined) {
  return node ? liveMdNodeRange(node) : null;
}

function liveMdInlineMarkKind(name: string): LiveMdInlineMarkKind {
  switch (name) {
    case "mark.emphasis":
      return "emphasis";
    case "mark.inlineCode":
      return "inlineCode";
    case "mark.strike":
      return "strike";
    case "mark.strong":
      return "strong";
    default:
      return "unknown";
  }
}

function isLiveMdParagraphContainerKind(kind: string): kind is LiveMdParagraphContainerKind {
  switch (kind) {
    case "block":
    case "document":
    case "list":
    case "listItem":
      return true;
    default:
      return false;
  }
}

function readLiveMdFenceLanguage(state: EditorState, languageNode?: SyntaxNode) {
  if (!languageNode) return "";
  return normalizeLiveMdFenceLanguage(state.sliceDoc(languageNode.from, languageNode.to));
}

function normalizeLiveMdFenceLanguage(language: string) {
  let token = firstLiveMdToken(language.trim());
  if (token.startsWith("{")) token = token.slice(1);
  if (token.startsWith(".")) token = token.slice(1);
  if (token.endsWith("}")) token = token.slice(0, -1);
  return token.toLowerCase();
}

function firstLiveMdToken(value: string) {
  for (let index = 0; index < value.length; index++) {
    if (isWhitespace(value.charCodeAt(index))) return value.slice(0, index);
  }
  return value;
}
