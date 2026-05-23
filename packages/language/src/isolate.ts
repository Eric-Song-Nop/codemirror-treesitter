import {
  Facet,
  Prec,
  RangeSetBuilder,
  type ChangeSet,
  type Extension,
  type Text,
} from "@codemirror/state";
import {
  Decoration,
  Direction,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { syntaxTree } from "./language.js";
import { NodeProp, Tree } from "./tree.js";

function buildForLine(line: string) {
  return line.length <= 4096 && /[\u0590-\u05f4\u0600-\u06ff\u0700-\u08ac\ufb50-\ufdff]/.test(line);
}

function textHasRTL(text: Text) {
  for (let iter = text.iter(); !iter.next().done; ) {
    if (buildForLine(iter.value)) return true;
  }
  return false;
}

function changeAddsRTL(change: ChangeSet) {
  let added = false;
  change.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    if (!added && textHasRTL(inserted)) added = true;
  });
  return added;
}

const alwaysIsolate = Facet.define<boolean, boolean>({
  combine: (values) => values.some((value) => value),
});

export function bidiIsolates(options: { alwaysIsolate?: boolean } = {}): Extension {
  let extensions: Extension[] = [isolateMarks];
  if (options.alwaysIsolate) extensions.push(alwaysIsolate.of(true));
  return extensions;
}

const isolateMarks = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    tree: Tree;
    hasRTL: boolean;
    always: boolean;

    constructor(view: EditorView) {
      this.always =
        view.state.facet(alwaysIsolate) ||
        view.textDirection != Direction.LTR ||
        view.state.facet(EditorView.perLineTextDirection);
      this.hasRTL = !this.always && textHasRTL(view.state.doc);
      this.tree = syntaxTree(view.state);
      this.decorations =
        this.always || this.hasRTL ? buildDeco(view, this.tree, this.always) : Decoration.none;
    }

    update(update: ViewUpdate) {
      let always =
        update.state.facet(alwaysIsolate) ||
        update.view.textDirection != Direction.LTR ||
        update.state.facet(EditorView.perLineTextDirection);
      if (!always && !this.hasRTL && changeAddsRTL(update.changes)) this.hasRTL = true;
      if (!always && !this.hasRTL) return;

      let tree = syntaxTree(update.state);
      if (
        always != this.always ||
        tree != this.tree ||
        update.docChanged ||
        update.viewportChanged
      ) {
        this.tree = tree;
        this.always = always;
        this.decorations = buildDeco(update.view, tree, always);
      }
    }
  },
  {
    provide: (plugin) => {
      function access(view: EditorView) {
        return view.plugin(plugin)?.decorations ?? Decoration.none;
      }
      return [
        EditorView.outerDecorations.of(access),
        Prec.lowest(EditorView.bidiIsolatedRanges.of(access)),
      ];
    },
  },
);

function buildDeco(view: EditorView, tree: Tree, always: boolean) {
  let deco = new RangeSetBuilder<Decoration>();
  let ranges: readonly { from: number; to: number }[] = view.visibleRanges;
  if (!always) ranges = clipRTLLines(ranges, view.state.doc);
  for (let { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        let iso = node.type.prop(NodeProp.isolate);
        if (iso) deco.add(node.from, node.to, marks[iso]);
      },
    });
  }
  return deco.finish();
}

function clipRTLLines(ranges: readonly { from: number; to: number }[], doc: Text) {
  let cur = doc.iter();
  let pos = 0;
  let result: { from: number; to: number }[] = [];
  let last: { from: number; to: number } | null = null;
  for (let { from, to } of ranges) {
    if (last && last.to > from) {
      from = last.to;
      if (from >= to) continue;
    }
    if (pos + cur.value.length < from) {
      cur.next(from - (pos + cur.value.length));
      pos = from;
    }
    for (;;) {
      let start = pos;
      let end = pos + cur.value.length;
      if (!cur.lineBreak && buildForLine(cur.value)) {
        if (last && last.to > start - 10) last.to = Math.min(to, end);
        else result.push((last = { from: start, to: Math.min(to, end) }));
      }
      if (end >= to) break;
      pos = end;
      cur.next();
    }
  }
  return result;
}

const marks = {
  rtl: Decoration.mark({
    class: "cm-iso",
    inclusive: true,
    attributes: { dir: "rtl" },
    bidiIsolate: Direction.RTL,
  }),
  ltr: Decoration.mark({
    class: "cm-iso",
    inclusive: true,
    attributes: { dir: "ltr" },
    bidiIsolate: Direction.LTR,
  }),
  auto: Decoration.mark({
    class: "cm-iso",
    inclusive: true,
    attributes: { dir: "auto" },
    bidiIsolate: null,
  }),
};
