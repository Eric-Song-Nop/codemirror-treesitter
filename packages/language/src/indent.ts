import {
  type ChangeSpec,
  EditorState,
  type Extension,
  Facet,
  countColumn,
} from "@codemirror/state";
import { type NodeIterator, NodeProp, SyntaxNode, Tree } from "./tree.js";
import { syntaxTree } from "./language.js";

export const indentService =
  Facet.define<(context: IndentContext, pos: number) => number | null | undefined>();

export const indentUnit = Facet.define<string, string>({
  combine: (values) => {
    if (!values.length) return "  ";
    let unit = values[0]!;
    if (!unit || /\S/.test(unit) || Array.from(unit).some((ch) => ch != unit[0])) {
      throw new Error("Invalid indent unit: " + JSON.stringify(values[0]));
    }
    return unit;
  },
});

export function getIndentUnit(state: EditorState) {
  let unit = state.facet(indentUnit);
  return unit.charCodeAt(0) == 9 ? state.tabSize * unit.length : unit.length;
}

export function indentString(state: EditorState, cols: number) {
  let result = "";
  let tabSize = state.tabSize;
  let ch = state.facet(indentUnit)[0]!;
  if (ch == "\t") {
    while (cols >= tabSize) {
      result += "\t";
      cols -= tabSize;
    }
    ch = " ";
  }
  for (let i = 0; i < cols; i++) result += ch;
  return result;
}

export function getIndentation(context: IndentContext | EditorState, pos: number): number | null {
  if (context instanceof EditorState) context = new IndentContext(context);
  for (let service of context.state.facet(indentService)) {
    let result = service(context, pos);
    if (result !== undefined) return result;
  }
  let tree = syntaxTree(context.state);
  return tree.length >= pos ? syntaxIndentation(context, tree, pos) : null;
}

export function indentRange(state: EditorState, from: number, to: number) {
  let updated: Record<number, number> = Object.create(null);
  let context = new IndentContext(state, { overrideIndentation: (start) => updated[start] ?? -1 });
  let changes: ChangeSpec[] = [];
  for (let pos = from; pos <= to; ) {
    let line = state.doc.lineAt(pos);
    pos = line.to + 1;
    let indent = getIndentation(context, line.from);
    if (indent == null) continue;
    if (!/\S/.test(line.text)) indent = 0;
    let cur = /^\s*/.exec(line.text)![0];
    let norm = indentString(state, indent);
    if (cur != norm) {
      updated[line.from] = indent;
      changes.push({ from: line.from, to: line.from + cur.length, insert: norm });
    }
  }
  return state.changes(changes);
}

export class IndentContext {
  unit: number;

  constructor(
    readonly state: EditorState,
    readonly options: {
      overrideIndentation?: (pos: number) => number;
      simulateBreak?: number;
      simulateDoubleBreak?: boolean;
    } = {},
  ) {
    this.unit = getIndentUnit(state);
  }

  lineAt(pos: number, bias: -1 | 1 = 1): { text: string; from: number } {
    let line = this.state.doc.lineAt(pos);
    let { simulateBreak, simulateDoubleBreak } = this.options;
    if (simulateBreak != null && simulateBreak >= line.from && simulateBreak <= line.to) {
      if (simulateDoubleBreak && simulateBreak == pos) return { text: "", from: pos };
      if (bias < 0 ? simulateBreak < pos : simulateBreak <= pos) {
        return { text: line.text.slice(simulateBreak - line.from), from: simulateBreak };
      }
      return { text: line.text.slice(0, simulateBreak - line.from), from: line.from };
    }
    return line;
  }

  textAfterPos(pos: number, bias: -1 | 1 = 1) {
    if (this.options.simulateDoubleBreak && pos == this.options.simulateBreak) return "";
    let { text, from } = this.lineAt(pos, bias);
    return text.slice(pos - from, Math.min(text.length, pos + 100 - from));
  }

  column(pos: number, bias: -1 | 1 = 1) {
    let { text, from } = this.lineAt(pos, bias);
    let result = this.countColumn(text, pos - from);
    let override = this.options.overrideIndentation ? this.options.overrideIndentation(from) : -1;
    if (override > -1) result += override - this.countColumn(text, text.search(/\S|$/));
    return result;
  }

  countColumn(line: string, pos = line.length) {
    return countColumn(line, this.state.tabSize, pos);
  }

  lineIndent(pos: number, bias: -1 | 1 = 1) {
    let { text, from } = this.lineAt(pos, bias);
    let override = this.options.overrideIndentation;
    if (override) {
      let overridden = override(from);
      if (overridden > -1) return overridden;
    }
    return this.countColumn(text, text.search(/\S|$/));
  }

  get simulatedBreak(): number | null {
    return this.options.simulateBreak || null;
  }
}

export const indentNodeProp = new NodeProp<(context: TreeIndentContext) => number | null>();

function syntaxIndentation(cx: IndentContext, ast: Tree, pos: number) {
  return indentFor(ast.resolveStack(pos, -1), cx, pos);
}

function indentFor(stack: NodeIterator | null, cx: IndentContext, pos: number): number | null {
  for (let cur: NodeIterator | null = stack; cur; cur = cur.next) {
    let strategy = indentStrategy(cur.node);
    if (strategy) return strategy(TreeIndentContext.create(cx, pos, cur));
  }
  return 0;
}

function ignoreClosed(cx: TreeIndentContext) {
  return cx.pos == cx.options.simulateBreak && cx.options.simulateDoubleBreak;
}

function indentStrategy(tree: SyntaxNode): ((context: TreeIndentContext) => number | null) | null {
  let strategy = tree.type.prop(indentNodeProp);
  if (strategy) return strategy;
  let first = tree.firstChild;
  let close: readonly string[] | undefined;
  if (first && (close = first.type.prop(NodeProp.closedBy))) {
    let last = tree.lastChild;
    let closed = last && close.includes(last.name);
    return (cx) =>
      delimitedStrategy(
        cx,
        true,
        1,
        undefined,
        closed && !ignoreClosed(cx) ? last!.from : undefined,
      );
  }
  return tree.parent == null ? topIndent : null;
}

function topIndent() {
  return 0;
}

export class TreeIndentContext extends IndentContext {
  private constructor(
    private base: IndentContext,
    readonly pos: number,
    readonly context: NodeIterator,
  ) {
    super(base.state, base.options);
  }

  get node(): SyntaxNode {
    return this.context.node;
  }

  static create(base: IndentContext, pos: number, context: NodeIterator) {
    return new TreeIndentContext(base, pos, context);
  }

  get textAfter() {
    return this.textAfterPos(this.pos);
  }

  get baseIndent() {
    return this.baseIndentFor(this.node);
  }

  baseIndentFor(node: SyntaxNode) {
    let line = this.state.doc.lineAt(node.from);
    for (;;) {
      let atBreak = node.tree.resolve(line.from);
      while (atBreak.parent && atBreak.parent.from == atBreak.from) atBreak = atBreak.parent;
      if (isParent(atBreak, node)) break;
      let next = this.state.doc.lineAt(atBreak.from);
      if (next.from == line.from) break;
      line = next;
    }
    return this.lineIndent(line.from);
  }

  continue() {
    return indentFor(this.context.next, this.base, this.pos);
  }
}

function isParent(parent: SyntaxNode, of: SyntaxNode) {
  for (let cur: SyntaxNode | null = of; cur; cur = cur.parent) {
    if (parent.equals(cur)) return true;
  }
  return false;
}

function bracketedAligned(context: TreeIndentContext) {
  let tree = context.node;
  let openToken = tree.childAfter(tree.from);
  let last = tree.lastChild;
  if (!openToken) return null;
  let sim = context.options.simulateBreak;
  let openLine = context.state.doc.lineAt(openToken.from);
  let lineEnd = sim == null || sim <= openLine.from ? openLine.to : Math.min(openLine.to, sim);
  for (let pos = openToken.to; ; ) {
    let next = tree.childAfter(pos);
    if (!next || next == last) return null;
    if (!next.type.isSkipped) {
      if (next.from >= lineEnd) return null;
      let space = /^ */.exec(openLine.text.slice(openToken.to - openLine.from))![0].length;
      return { from: openToken.from, to: openToken.to + space };
    }
    pos = next.to;
  }
}

export function delimitedIndent({
  closing,
  align = true,
  units = 1,
}: {
  closing: string;
  align?: boolean;
  units?: number;
}) {
  return (context: TreeIndentContext) => delimitedStrategy(context, align, units, closing);
}

function delimitedStrategy(
  context: TreeIndentContext,
  align: boolean,
  units: number,
  closing?: string,
  closedAt?: number,
) {
  let after = context.textAfter;
  let space = after.match(/^\s*/)![0].length;
  let closed =
    (closing && after.slice(space, space + closing.length) == closing) ||
    closedAt == context.pos + space;
  let aligned = align ? bracketedAligned(context) : null;
  if (aligned) return closed ? context.column(aligned.from) : context.column(aligned.to);
  return context.baseIndent + (closed ? 0 : context.unit * units);
}

export const flatIndent = (context: TreeIndentContext) => context.baseIndent;

export function continuedIndent({ except, units = 1 }: { except?: RegExp; units?: number } = {}) {
  return (context: TreeIndentContext) => {
    let matchExcept = except && except.test(context.textAfter);
    return context.baseIndent + (matchExcept ? 0 : units * context.unit);
  };
}

const DontIndentBeyond = 200;

export function indentOnInput(): Extension {
  return EditorState.transactionFilter.of((tr) => {
    if (!tr.docChanged || (!tr.isUserEvent("input.type") && !tr.isUserEvent("input.complete")))
      return tr;
    let rules = tr.startState.languageDataAt<RegExp>(
      "indentOnInput",
      tr.startState.selection.main.head,
    );
    if (!rules.length) return tr;
    let doc = tr.newDoc;
    let { head } = tr.newSelection.main;
    let line = doc.lineAt(head);
    if (head > line.from + DontIndentBeyond) return tr;
    let lineStart = doc.sliceString(line.from, head);
    if (!rules.some((rule) => rule.test(lineStart))) return tr;
    let { state } = tr;
    let last = -1;
    let changes: ChangeSpec[] = [];
    for (let range of state.selection.ranges) {
      let line = state.doc.lineAt(range.head);
      if (line.from == last) continue;
      last = line.from;
      let indent = getIndentation(state, line.from);
      if (indent == null) continue;
      let cur = /^\s*/.exec(line.text)![0];
      let norm = indentString(state, indent);
      if (cur != norm) changes.push({ from: line.from, to: line.from + cur.length, insert: norm });
    }
    return changes.length ? [tr, { changes, sequential: true }] : tr;
  });
}
