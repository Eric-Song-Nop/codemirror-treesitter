import {
  Language as TSLanguage,
  Query as TSQuery,
  type Node as TSNode,
  type QueryOptions as TSQueryOptions,
} from "web-tree-sitter";
import { SyntaxNode, Tree } from "./tree.js";

export type TreeSitterQueryTarget = Tree | SyntaxNode;

export type TreeSitterQueryOptions = {
  from?: number;
  to?: number;
  containedFrom?: number;
  containedTo?: number;
  maxStartDepth?: number | null;
  matchLimit?: number;
};

export type TreeSitterQueryCapture = {
  name: string;
  node: SyntaxNode;
  patternIndex: number;
  setProperties?: Record<string, string | null>;
  assertedProperties?: Record<string, string | null>;
  refutedProperties?: Record<string, string | null>;
};

export type TreeSitterQueryMatch = {
  patternIndex: number;
  captures: readonly TreeSitterQueryCapture[];
  setProperties?: Record<string, string | null>;
  assertedProperties?: Record<string, string | null>;
  refutedProperties?: Record<string, string | null>;
};

export class TreeSitterQuery {
  private readonly query: TSQuery;

  private constructor(
    private readonly language: TSLanguage,
    source: string,
  ) {
    this.query = new TSQuery(language, source);
  }

  /** @internal */
  static create(language: TSLanguage, source: string) {
    return new TreeSitterQuery(language, source);
  }

  captures(
    target: TreeSitterQueryTarget,
    options: TreeSitterQueryOptions = {},
  ): readonly TreeSitterQueryCapture[] {
    let resolved = this.resolveTarget(target);
    if (!resolved) return [];
    let contained = containedRange(options);
    return this.query
      .captures(resolved.node, queryOptions(options, resolved.node))
      .filter((capture) => !contained || containsNode(contained, capture.node))
      .map((capture) => wrapCapture(resolved.tree, capture));
  }

  matches(
    target: TreeSitterQueryTarget,
    options: TreeSitterQueryOptions = {},
  ): readonly TreeSitterQueryMatch[] {
    let resolved = this.resolveTarget(target);
    if (!resolved) return [];
    let contained = containedRange(options);
    return this.query
      .matches(resolved.node, queryOptions(options, resolved.node))
      .filter(
        (match) =>
          !contained || match.captures.every((capture) => containsNode(contained, capture.node)),
      )
      .map((match) => {
        return withProperties(
          {
            patternIndex: match.patternIndex,
            captures: match.captures.map((capture) => wrapCapture(resolved.tree, capture, match)),
          },
          match,
        );
      });
  }

  private resolveTarget(target: TreeSitterQueryTarget): { tree: Tree; node: TSNode } | null {
    let tree = target instanceof Tree ? target : target.tree;
    let node = target instanceof Tree ? target.topNode.node : target.node;
    if (!node) return null;
    if (node.tree.language != this.language) {
      throw new RangeError("Tree-sitter query target must use the same grammar as the query");
    }
    return { tree, node };
  }
}

function queryOptions(options: TreeSitterQueryOptions, node: TSNode): TSQueryOptions {
  let result: TSQueryOptions = {};
  if (options.from != null || options.to != null) {
    result.startIndex = options.from ?? 0;
    result.endIndex = options.to ?? node.endIndex;
    result.startPosition = pointAt(node, result.startIndex);
    result.endPosition = pointAt(node, result.endIndex);
  }
  if (options.containedFrom != null || options.containedTo != null) {
    if (options.from == null && options.to == null) {
      result.startIndex = options.containedFrom ?? 0;
      result.endIndex = options.containedTo ?? node.endIndex;
      result.startPosition = pointAt(node, result.startIndex);
      result.endPosition = pointAt(node, result.endIndex);
    }
  }
  if (options.matchLimit !== undefined) result.matchLimit = options.matchLimit;
  if (options.maxStartDepth != null) result.maxStartDepth = options.maxStartDepth;
  return result;
}

function containedRange(options: TreeSitterQueryOptions) {
  return options.containedFrom != null || options.containedTo != null
    ? { from: options.containedFrom ?? 0, to: options.containedTo ?? Infinity }
    : null;
}

function containsNode(range: { from: number; to: number }, node: TSNode) {
  return node.startIndex >= range.from && node.endIndex <= range.to;
}

function wrapCapture(
  tree: Tree,
  capture: {
    name: string;
    node: TSNode;
    patternIndex: number;
    setProperties?: Record<string, string | null>;
    assertedProperties?: Record<string, string | null>;
    refutedProperties?: Record<string, string | null>;
  },
  fallbackProperties?: {
    setProperties?: Record<string, string | null>;
    assertedProperties?: Record<string, string | null>;
    refutedProperties?: Record<string, string | null>;
  },
): TreeSitterQueryCapture {
  return withProperties(
    {
      name: capture.name,
      node: new SyntaxNode(tree, capture.node),
      patternIndex: capture.patternIndex,
    },
    {
      setProperties: capture.setProperties ?? fallbackProperties?.setProperties,
      assertedProperties: capture.assertedProperties ?? fallbackProperties?.assertedProperties,
      refutedProperties: capture.refutedProperties ?? fallbackProperties?.refutedProperties,
    },
  );
}

function withProperties<T extends object>(
  value: T,
  source: {
    setProperties?: Record<string, string | null>;
    assertedProperties?: Record<string, string | null>;
    refutedProperties?: Record<string, string | null>;
  },
): T {
  if (source.setProperties) Object.assign(value, { setProperties: source.setProperties });
  if (source.assertedProperties) {
    Object.assign(value, { assertedProperties: source.assertedProperties });
  }
  if (source.refutedProperties) {
    Object.assign(value, { refutedProperties: source.refutedProperties });
  }
  return value;
}

function pointAt(node: TSNode, index: number) {
  let root = node.tree.rootNode;
  let row = root.startPosition.row;
  let column = root.startPosition.column;
  let text = root.text;
  let start = root.startIndex;
  let end = Math.min(text.length, Math.max(0, index - start));
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) == 10) {
      row++;
      column = 0;
    } else {
      column++;
    }
  }
  return { row, column };
}
