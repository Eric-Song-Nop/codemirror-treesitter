import {
  ChangeDesc,
  EditorState,
  Facet,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  combineConfig,
  type Extension,
  type Range,
} from "@codemirror/state";
import {
  BlockInfo,
  Decoration,
  EditorView,
  GutterMarker,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
  gutter,
  type Command,
  type DecorationSet,
  type KeyBinding,
} from "@codemirror/view";
import {
  addTouchedLineRange,
  changedLineRanges,
  mergeDocRanges,
  patchRangeSet,
  rangesTouch,
} from "./incremental.js";
import { language, syntaxTree } from "./language.js";
import { NodeProp, SyntaxNode, type NodeIterator } from "./tree.js";

export const foldService =
  Facet.define<
    (state: EditorState, lineStart: number, lineEnd: number) => { from: number; to: number } | null
  >();

export const foldNodeProp = new NodeProp<
  (node: SyntaxNode, state: EditorState) => { from: number; to: number } | null
>();

export function foldInside(node: SyntaxNode): { from: number; to: number } | null {
  let first = node.firstChild;
  let last = node.lastChild;
  return first && last && first.to < last.from
    ? { from: first.to, to: last.type.isError ? node.to : last.from }
    : null;
}

function syntaxFolding(state: EditorState, start: number, end: number) {
  let tree = syntaxTree(state);
  if (tree.length < end) return null;
  let stack = tree.resolveStack(end, 1);
  let found: null | { from: number; to: number } = null;
  for (let iter: NodeIterator | null = stack; iter; iter = iter.next) {
    let cur = iter.node;
    if (cur.to <= end || cur.from > end) continue;
    if (found && cur.from < start) break;
    let prop = cur.type.prop(foldNodeProp);
    if (
      prop &&
      (cur.to < tree.length - 50 || tree.length == state.doc.length || !isUnfinished(cur))
    ) {
      let value = prop(cur, state);
      if (value && value.from <= end && value.from >= start && value.to > end) found = value;
    }
  }
  return found;
}

function isUnfinished(node: SyntaxNode) {
  let child = node.lastChild;
  return child && child.to == node.to && child.type.isError;
}

export function foldable(state: EditorState, lineStart: number, lineEnd: number) {
  for (let service of state.facet(foldService)) {
    let result = service(state, lineStart, lineEnd);
    if (result) return result;
  }
  return syntaxFolding(state, lineStart, lineEnd);
}

type DocRange = { from: number; to: number };

function mapRange(range: DocRange, mapping: ChangeDesc) {
  let from = mapping.mapPos(range.from, 1);
  let to = mapping.mapPos(range.to, -1);
  return from >= to ? undefined : { from, to };
}

export const foldEffect = StateEffect.define<DocRange>({ map: mapRange });
export const unfoldEffect = StateEffect.define<DocRange>({ map: mapRange });

function selectedLines(view: EditorView) {
  let lines: BlockInfo[] = [];
  for (let { head } of view.state.selection.ranges) {
    if (lines.some((line) => line.from <= head && line.to >= head)) continue;
    lines.push(view.lineBlockAt(head));
  }
  return lines;
}

export const foldState = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(folded, tr) {
    if (tr.isUserEvent("delete")) {
      tr.changes.iterChangedRanges((fromA, toA) => {
        folded = clearTouchedFolds(folded, fromA, toA);
      });
    }
    folded = folded.map(tr.changes);
    for (let effect of tr.effects) {
      if (effect.is(foldEffect) && !foldExists(folded, effect.value.from, effect.value.to)) {
        let { preparePlaceholder } = tr.state.facet(foldConfig);
        let widget = !preparePlaceholder
          ? foldWidget
          : Decoration.replace({
              widget: new PreparedFoldWidget(preparePlaceholder(tr.state, effect.value)),
            });
        folded = folded.update({ add: [widget.range(effect.value.from, effect.value.to)] });
      } else if (effect.is(unfoldEffect)) {
        folded = folded.update({
          filter: (from, to) => effect.value.from != from || effect.value.to != to,
          filterFrom: effect.value.from,
          filterTo: effect.value.to,
        });
      }
    }
    if (tr.selection) folded = clearTouchedFolds(folded, tr.selection.main.head);
    return folded;
  },
  provide: (field) => EditorView.decorations.from(field),
  toJSON(folded, state) {
    let ranges: number[] = [];
    folded.between(0, state.doc.length, (from, to) => {
      ranges.push(from, to);
    });
    return ranges;
  },
  fromJSON(value) {
    if (!Array.isArray(value) || value.length % 2)
      throw new RangeError("Invalid JSON for fold state");
    let ranges = [];
    for (let i = 0; i < value.length; ) {
      let from = value[i++];
      let to = value[i++];
      if (typeof from != "number" || typeof to != "number")
        throw new RangeError("Invalid JSON for fold state");
      ranges.push(foldWidget.range(from, to));
    }
    return Decoration.set(ranges, true);
  },
});

function clearTouchedFolds(folded: DecorationSet, from: number, to = from) {
  let touched = false;
  folded.between(from, to, (a, b) => {
    if (a < to && b > from) touched = true;
  });
  return !touched
    ? folded
    : folded.update({
        filterFrom: from,
        filterTo: to,
        filter: (a, b) => a >= to || b <= from,
      });
}

export function foldedRanges(state: EditorState): DecorationSet {
  return state.field(foldState, false) || RangeSet.empty;
}

function findFold(state: EditorState, from: number, to: number) {
  let found: { from: number; to: number } | null = null;
  state.field(foldState, false)?.between(from, to, (rangeFrom, rangeTo) => {
    if (!found || found.from > rangeFrom) found = { from: rangeFrom, to: rangeTo };
  });
  return found;
}

function foldExists(folded: DecorationSet, from: number, to: number) {
  let found = false;
  folded.between(from, from, (a, b) => {
    if (a == from && b == to) found = true;
  });
  return found;
}

function maybeEnable(state: EditorState, other: readonly StateEffect<unknown>[]) {
  return state.field(foldState, false)
    ? other
    : other.concat(StateEffect.appendConfig.of(codeFolding()));
}

export const foldCode: Command = (view) => {
  for (let line of selectedLines(view)) {
    let range = foldable(view.state, line.from, line.to);
    if (range) {
      view.dispatch({
        effects: maybeEnable(view.state, [foldEffect.of(range), announceFold(view, range)]),
      });
      return true;
    }
  }
  return false;
};

export const unfoldCode: Command = (view) => {
  if (!view.state.field(foldState, false)) return false;
  let effects = [];
  for (let line of selectedLines(view)) {
    let folded = findFold(view.state, line.from, line.to);
    if (folded) effects.push(unfoldEffect.of(folded), announceFold(view, folded, false));
  }
  if (effects.length) view.dispatch({ effects });
  return effects.length > 0;
};

function announceFold(view: EditorView, range: { from: number; to: number }, fold = true) {
  let lineFrom = view.state.doc.lineAt(range.from).number;
  let lineTo = view.state.doc.lineAt(range.to).number;
  return EditorView.announce.of(
    `${view.state.phrase(fold ? "Folded lines" : "Unfolded lines")} ${lineFrom} ${view.state.phrase("to")} ${lineTo}.`,
  );
}

export const foldAll: Command = (view) => {
  let { state } = view;
  let effects = [];
  for (let pos = 0; pos < state.doc.length; ) {
    let line = view.lineBlockAt(pos);
    let range = foldable(state, line.from, line.to);
    if (range) effects.push(foldEffect.of(range));
    pos = (range ? view.lineBlockAt(range.to) : line).to + 1;
  }
  if (effects.length) view.dispatch({ effects: maybeEnable(view.state, effects) });
  return !!effects.length;
};

export const unfoldAll: Command = (view) => {
  let field = view.state.field(foldState, false);
  if (!field || !field.size) return false;
  let effects: StateEffect<DocRange>[] = [];
  field.between(0, view.state.doc.length, (from, to) => {
    effects.push(unfoldEffect.of({ from, to }));
  });
  view.dispatch({ effects });
  return true;
};

function foldableContainer(view: EditorView, lineBlock: BlockInfo) {
  for (let line = lineBlock; ; ) {
    let foldableRegion = foldable(view.state, line.from, line.to);
    if (foldableRegion && foldableRegion.to > lineBlock.from) return foldableRegion;
    if (!line.from) return null;
    line = view.lineBlockAt(line.from - 1);
  }
}

export const toggleFold: Command = (view) => {
  let effects: StateEffect<unknown>[] = [];
  for (let line of selectedLines(view)) {
    let folded = findFold(view.state, line.from, line.to);
    if (folded) {
      effects.push(unfoldEffect.of(folded), announceFold(view, folded, false));
    } else {
      let foldRange = foldableContainer(view, line);
      if (foldRange) effects.push(foldEffect.of(foldRange), announceFold(view, foldRange));
    }
  }
  if (effects.length > 0) view.dispatch({ effects: maybeEnable(view.state, effects) });
  return effects.length > 0;
};

export const foldKeymap: readonly KeyBinding[] = [
  { key: "Ctrl-Shift-[", mac: "Cmd-Alt-[", run: foldCode },
  { key: "Ctrl-Shift-]", mac: "Cmd-Alt-]", run: unfoldCode },
  { key: "Ctrl-Alt-[", run: foldAll },
  { key: "Ctrl-Alt-]", run: unfoldAll },
];

interface FoldConfig {
  placeholderDOM?:
    | ((view: EditorView, onclick: (event: Event) => void, prepared: unknown) => HTMLElement)
    | null;
  placeholderText?: string;
  preparePlaceholder?: (state: EditorState, range: { from: number; to: number }) => unknown;
}

const defaultConfig: Required<FoldConfig> = {
  placeholderDOM: null,
  preparePlaceholder: null as never,
  placeholderText: "…",
};

const foldConfig = Facet.define<FoldConfig, Required<FoldConfig>>({
  combine(values) {
    return combineConfig(values, defaultConfig);
  },
});

export function codeFolding(config?: FoldConfig): Extension {
  let result: Extension[] = [foldState, baseTheme];
  if (config) result.push(foldConfig.of(config));
  return result;
}

function widgetToDOM(view: EditorView, prepared: unknown) {
  let { state } = view;
  let conf = state.facet(foldConfig);
  let onclick = (event: Event) => {
    let line = view.lineBlockAt(view.posAtDOM(event.target as HTMLElement));
    let folded = findFold(view.state, line.from, line.to);
    if (folded) view.dispatch({ effects: unfoldEffect.of(folded) });
    event.preventDefault();
  };
  if (conf.placeholderDOM) return conf.placeholderDOM(view, onclick, prepared);
  let element = document.createElement("span");
  element.textContent = conf.placeholderText;
  element.setAttribute("aria-label", state.phrase("folded code"));
  element.title = state.phrase("unfold");
  element.className = "cm-foldPlaceholder";
  element.onclick = onclick;
  return element;
}

const foldWidget = Decoration.replace({
  widget: new (class extends WidgetType {
    toDOM(view: EditorView) {
      return widgetToDOM(view, null);
    }
  })(),
});

class PreparedFoldWidget extends WidgetType {
  constructor(readonly value: unknown) {
    super();
  }

  eq(other: PreparedFoldWidget) {
    return this.value == other.value;
  }

  toDOM(view: EditorView) {
    return widgetToDOM(view, this.value);
  }
}

type Handlers = { [event: string]: (view: EditorView, line: BlockInfo, event: Event) => boolean };

interface FoldGutterConfig {
  markerDOM?: ((open: boolean) => HTMLElement) | null;
  openText?: string;
  closedText?: string;
  domEventHandlers?: Handlers;
  foldingChanged?: (update: ViewUpdate) => boolean;
}

const foldGutterDefaults: Required<FoldGutterConfig> = {
  openText: "⌄",
  closedText: "›",
  markerDOM: null,
  domEventHandlers: {},
  foldingChanged: () => false,
};

class FoldMarker extends GutterMarker {
  constructor(
    readonly config: Required<FoldGutterConfig>,
    readonly open: boolean,
  ) {
    super();
  }

  eq(other: FoldMarker) {
    return this.config == other.config && this.open == other.open;
  }

  toDOM(view: EditorView) {
    if (this.config.markerDOM) return this.config.markerDOM(this.open);
    let span = document.createElement("span");
    span.textContent = this.open ? this.config.openText : this.config.closedText;
    span.title = view.state.phrase(this.open ? "Fold line" : "Unfold line");
    return span;
  }
}

export function foldGutter(config: FoldGutterConfig = {}): Extension {
  let fullConfig = { ...foldGutterDefaults, ...config };
  let canFold = new FoldMarker(fullConfig, true);
  let canUnfold = new FoldMarker(fullConfig, false);

  let markers = ViewPlugin.fromClass(
    class {
      markers: RangeSet<FoldMarker>;

      constructor(view: EditorView) {
        this.markers = this.buildMarkers(view);
      }

      update(update: ViewUpdate) {
        if (shouldRebuildFoldMarkers(update, fullConfig)) {
          this.markers = this.buildMarkers(update.view);
        } else {
          let dirtyRanges = foldMarkerDirtyRanges(update);
          if (!dirtyRanges.length) return;
          this.markers = patchRangeSet(
            this.markers.map(update.changes),
            dirtyRanges,
            this.buildMarkerRanges(update.view, dirtyRanges),
          );
        }
      }

      buildMarkers(view: EditorView) {
        let builder = new RangeSetBuilder<FoldMarker>();
        for (let range of this.buildMarkerRanges(view, view.visibleRanges)) {
          builder.add(range.from, range.to, range.value);
        }
        return builder.finish();
      }

      buildMarkerRanges(view: EditorView, ranges: readonly DocRange[]) {
        let markers: Range<FoldMarker>[] = [];
        for (let line of linesInRanges(view, ranges)) {
          let mark = findFold(view.state, line.from, line.to)
            ? canUnfold
            : foldable(view.state, line.from, line.to)
              ? canFold
              : null;
          if (mark) markers.push(mark.range(line.from, line.from));
        }
        return markers;
      }
    },
  );

  let { domEventHandlers } = fullConfig;
  return [
    markers,
    gutter({
      class: "cm-foldGutter",
      markers(view) {
        return view.plugin(markers)?.markers || RangeSet.empty;
      },
      initialSpacer() {
        return new FoldMarker(fullConfig, false);
      },
      domEventHandlers: {
        ...domEventHandlers,
        click: (view, line, event) => {
          if (domEventHandlers.click && domEventHandlers.click(view, line, event)) return true;
          let folded = findFold(view.state, line.from, line.to);
          if (folded) {
            view.dispatch({ effects: unfoldEffect.of(folded) });
            return true;
          }
          let range = foldable(view.state, line.from, line.to);
          if (range) {
            view.dispatch({ effects: foldEffect.of(range) });
            return true;
          }
          return false;
        },
      },
    }),
    codeFolding(),
  ];
}

function shouldRebuildFoldMarkers(update: ViewUpdate, config: Required<FoldGutterConfig>) {
  return (
    (update.viewportChanged &&
      !update.docChanged &&
      syntaxTree(update.startState) == syntaxTree(update.state)) ||
    update.startState.facet(language) != update.state.facet(language) ||
    update.transactions.length != 1 ||
    config.foldingChanged(update)
  );
}

function foldMarkerDirtyRanges(update: ViewUpdate) {
  let ranges = [...changedLineRanges(update)];
  for (let transaction of update.transactions) {
    if (transaction.selection) {
      for (let range of transaction.state.selection.ranges) {
        addTouchedLineRange(update.state, ranges, range.head, range.head);
      }
    }
    for (let effect of transaction.effects) {
      if (effect.is(foldEffect) || effect.is(unfoldEffect)) {
        addTouchedLineRange(update.state, ranges, effect.value.from, effect.value.from);
      }
    }
  }
  return mergeDocRanges(ranges);
}

function linesInRanges(view: EditorView, ranges: readonly DocRange[]) {
  let lines: BlockInfo[] = [];
  for (let line of view.viewportLineBlocks) {
    if (ranges.some((range) => rangesTouch(line.from, line.to, range.from, range.to))) {
      lines.push(line);
    }
  }
  return lines;
}

const baseTheme = EditorView.baseTheme({
  ".cm-foldPlaceholder": {
    backgroundColor: "#eee",
    border: "1px solid #ddd",
    color: "#888",
    borderRadius: ".2em",
    margin: "0 1px",
    padding: "0 1px",
    cursor: "pointer",
  },
  ".cm-foldGutter span": {
    padding: "0 1px",
    cursor: "pointer",
  },
});
