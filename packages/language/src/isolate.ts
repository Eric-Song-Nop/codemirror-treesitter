import {
  Facet,
  Prec,
  RangeSetBuilder,
  type ChangeSet,
  type Extension,
  type Range,
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
import { syntaxTree, syntaxTreeChangedRanges } from "./language.js";
import { type DocRange, NodeProp, Tree } from "./tree.js";

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
      if (always != this.always || update.viewportChanged || !canPatchIsolates(update)) {
        this.tree = tree;
        this.always = always;
        this.decorations = buildDeco(update.view, tree, always);
      } else if (tree != this.tree || update.docChanged) {
        let dirtyRanges = isolateDirtyRanges(update);
        this.tree = tree;
        this.always = always;
        this.decorations = patchDecorations(
          this.decorations.map(update.changes),
          dirtyRanges,
          buildDecoRanges(update.view, tree, always, dirtyRanges),
        );
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
  let ranges = buildDecoRanges(view, tree, always, view.visibleRanges);
  let deco = new RangeSetBuilder<Decoration>();
  for (let range of ranges) deco.add(range.from, range.to, range.value);
  return deco.finish();
}

function buildDecoRanges(
  view: EditorView,
  tree: Tree,
  always: boolean,
  ranges: readonly DocRange[],
) {
  let decorations: Range<Decoration>[] = [];
  if (!always) ranges = clipRTLLines(ranges, view.state.doc);
  for (let { from, to } of ranges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        let iso = node.type.prop(NodeProp.isolate);
        if (iso) decorations.push(marks[iso].range(node.from, node.to));
      },
    });
  }
  return decorations;
}

function canPatchIsolates(update: ViewUpdate) {
  return update.transactions.length == 1;
}

function isolateDirtyRanges(update: ViewUpdate) {
  let transaction = update.transactions[0];
  if (!transaction) return [];
  let ranges: DocRange[] = [];
  update.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
    addTouchedLineRange(update.state, ranges, fromB, toB);
  });
  for (let range of syntaxTreeChangedRanges(transaction)) {
    addTouchedLineRange(update.state, ranges, range.from, range.to);
  }
  return mergeDocRanges(ranges);
}

function addTouchedLineRange(
  state: EditorView["state"],
  ranges: DocRange[],
  rangeFrom: number,
  rangeTo: number,
) {
  let from = clamp(rangeFrom, 0, state.doc.length);
  let to = clamp(rangeTo, 0, state.doc.length);
  let firstLine = state.doc.lineAt(from);
  let lastLine = state.doc.lineAt(Math.max(from, to - 1));
  ranges.push({ from: firstLine.from, to: lastLine.to });
}

function mergeDocRanges(ranges: readonly DocRange[]) {
  let sorted = ranges.slice().sort((left, right) => left.from - right.from || left.to - right.to);
  let merged: DocRange[] = [];
  for (let range of sorted) {
    let last = merged[merged.length - 1];
    if (last && range.from <= last.to) {
      last.to = Math.max(last.to, range.to);
    } else {
      merged.push({ from: range.from, to: range.to });
    }
  }
  return merged;
}

function patchDecorations(
  current: DecorationSet,
  dirtyRanges: readonly DocRange[],
  additions: readonly Range<Decoration>[],
) {
  let next = current;
  for (let range of dirtyRanges) {
    next = next.update({
      filter: (from, to) => !rangesTouch(from, to, range.from, range.to),
      filterFrom: range.from,
      filterTo: range.to,
    });
  }
  return additions.length ? next.update({ add: additions, sort: true }) : next;
}

function rangesTouch(from: number, to: number, rangeFrom: number, rangeTo: number) {
  if (from == to && rangeFrom == rangeTo) return from == rangeFrom;
  if (from == to) return from >= rangeFrom && from < rangeTo;
  if (rangeFrom == rangeTo) return from <= rangeFrom && to >= rangeFrom;
  return from < rangeTo && to > rangeFrom;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
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
