import { queryTreeMatches, syntaxTree } from "@codemirror-treesitter/language";
import type { Tree, TreeSitterParser, TreeSitterQueryMatch } from "@codemirror-treesitter/language";
import type { EditorState } from "@codemirror/state";
import type { LiveMdDocRange, LiveMdGlobalState, LiveMdReferenceDefinition } from "./types.js";

const referenceDefinitionQuery = `
((link_reference_definition
  (link_label) @label
  (link_destination)? @destination
  (link_title)? @title) @definition)
`;

export function buildLiveMdGlobalState(state: EditorState): LiveMdGlobalState {
  let definitions = new Map<string, LiveMdReferenceDefinition>();
  for (let match of queryTreeMatches(syntaxTree(state), liveMdGlobalQuerySource, {
    from: 0,
    to: state.doc.length,
  })) {
    let definition = capture(match, "definition");
    let label = capture(match, "label");
    if (!definition || !label) continue;

    let key = normalizeLiveMdReferenceLabel(state.sliceDoc(label.from, label.to));
    if (!key || definitions.has(key)) continue;

    let destination = capture(match, "destination");
    let title = capture(match, "title");
    definitions.set(key, {
      destination: destination
        ? normalizeLiveMdReferenceDestination(state.sliceDoc(destination.from, destination.to))
        : "",
      destinationRange: nodeRangeOrNull(destination),
      label: referenceLabelText(state.sliceDoc(label.from, label.to)),
      labelRange: nodeRange(label),
      range: nodeRange(definition),
      title: title ? normalizeLiveMdReferenceTitle(state.sliceDoc(title.from, title.to)) : null,
      titleRange: nodeRangeOrNull(title),
    });
  }
  return { referenceDefinitions: definitions };
}

function liveMdGlobalQuerySource(_parser: TreeSitterParser, tree: Tree) {
  return tree.topNode.name == "document" ? referenceDefinitionQuery : null;
}

export function normalizeLiveMdReferenceLabel(label: string) {
  return referenceLabelText(label).replace(/\s+/gu, " ").trim().toLowerCase();
}

function referenceLabelText(label: string) {
  let value = label.trim();
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1);
  return value;
}

function normalizeLiveMdReferenceDestination(destination: string) {
  let value = destination.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1).trim();
  return value;
}

function normalizeLiveMdReferenceTitle(title: string) {
  let value = title.trim();
  let first = value[0];
  let last = value.at(-1);
  if ((first == '"' && last == '"') || (first == "'" && last == "'")) {
    return value.slice(1, -1);
  }
  if (first == "(" && last == ")") return value.slice(1, -1);
  return value;
}

function capture(match: TreeSitterQueryMatch, name: string) {
  return match.captures.find((item) => item.name == name)?.node ?? null;
}

function nodeRange(node: LiveMdNodeRangeLike): LiveMdDocRange {
  return { from: node.from, to: node.to };
}

function nodeRangeOrNull(node: LiveMdNodeRangeLike | null): LiveMdDocRange | null {
  return node ? nodeRange(node) : null;
}

type LiveMdNodeRangeLike = {
  from: number;
  to: number;
};
