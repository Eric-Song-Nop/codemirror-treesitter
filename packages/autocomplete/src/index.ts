import {
  Annotation,
  EditorSelection,
  EditorState,
  Facet,
  MapMode,
  Prec,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  CharCategory,
  codePointAt,
  codePointSize,
  combineConfig,
  fromCodePoint,
  type Extension,
  type StateCommand,
  type Text,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import {
  EditorView,
  ViewPlugin,
  keymap,
  showTooltip,
  type Command,
  type KeyBinding,
  type Tooltip,
  type ViewUpdate,
} from "@codemirror/view";
import { syntaxTree, type NodeType } from "@codemirror-treesitter/language";
import { filterCompletionOptions } from "./filter.js";

export interface CloseBracketConfig {
  brackets?: string[];
  before?: string;
  stringPrefixes?: string[];
}

const defaults: Required<CloseBracketConfig> = {
  brackets: ["(", "[", "{", "'", '"'],
  before: ")]}:;>",
  stringPrefixes: [],
};

const closeBracketEffect = StateEffect.define<number>({
  map(value, mapping) {
    let mapped = mapping.mapPos(value, -1, MapMode.TrackAfter);
    return mapped == null ? undefined : mapped;
  },
});

const closedBracket = new (class extends RangeValue {})();
closedBracket.startSide = 1;
closedBracket.endSide = -1;

const bracketState = StateField.define<RangeSet<typeof closedBracket>>({
  create() {
    return RangeSet.empty;
  },
  update(value, tr) {
    value = value.map(tr.changes);
    if (tr.selection) {
      let line = tr.state.doc.lineAt(tr.selection.main.head);
      value = value.update({ filter: (from) => from >= line.from && from <= line.to });
    }
    for (let effect of tr.effects) {
      if (effect.is(closeBracketEffect)) {
        value = value.update({ add: [closedBracket.range(effect.value, effect.value + 1)] });
      }
    }
    return value;
  },
});

export function closeBrackets(): Extension {
  return [inputHandler, bracketState];
}

const definedClosing = "()[]{}<>«»»«［］｛｝";

function closing(ch: number) {
  for (let i = 0; i < definedClosing.length; i += 2) {
    if (definedClosing.charCodeAt(i) == ch) return definedClosing.charAt(i + 1);
  }
  return fromCodePoint(ch < 128 ? ch : ch + 1);
}

function config(state: EditorState, pos: number) {
  return state.languageDataAt<CloseBracketConfig>("closeBrackets", pos)[0] || defaults;
}

const android = typeof navigator == "object" && /Android\b/.test(navigator.userAgent);

const inputHandler = EditorView.inputHandler.of((view, from, to, insert) => {
  if ((android ? view.composing : view.compositionStarted) || view.state.readOnly) return false;
  let sel = view.state.selection.main;
  if (
    insert.length > 2 ||
    (insert.length == 2 && codePointSize(codePointAt(insert, 0)) == 1) ||
    from != sel.from ||
    to != sel.to
  ) {
    return false;
  }
  let tr = insertBracket(view.state, insert);
  if (!tr) return false;
  view.dispatch(tr);
  return true;
});

export const deleteBracketPair: StateCommand = ({ state, dispatch }) => {
  if (state.readOnly) return false;
  let conf = config(state, state.selection.main.head);
  let tokens = conf.brackets || defaults.brackets;
  let blocked = null;
  let changes = state.changeByRange((range) => {
    if (range.empty) {
      let before = prevChar(state.doc, range.head);
      for (let token of tokens) {
        if (token == before && nextChar(state.doc, range.head) == closing(codePointAt(token, 0))) {
          return {
            changes: { from: range.head - token.length, to: range.head + token.length },
            range: EditorSelection.cursor(range.head - token.length),
          };
        }
      }
    }
    return { range: (blocked = range) };
  });
  if (!blocked)
    dispatch(state.update(changes, { scrollIntoView: true, userEvent: "delete.backward" }));
  return !blocked;
};

export const closeBracketsKeymap: readonly KeyBinding[] = [
  { key: "Backspace", run: deleteBracketPair },
];

export function insertBracket(state: EditorState, bracket: string): Transaction | null {
  let conf = config(state, state.selection.main.head);
  let tokens = conf.brackets || defaults.brackets;
  for (let token of tokens) {
    let closed = closing(codePointAt(token, 0));
    if (bracket == token) {
      return closed == token
        ? handleSame(state, token, tokens.includes(token + token + token), conf)
        : handleOpen(state, token, closed, conf.before || defaults.before);
    }
    if (bracket == closed && closedBracketAt(state, state.selection.main.from)) {
      return handleClose(state, closed);
    }
  }
  return null;
}

function closedBracketAt(state: EditorState, pos: number) {
  let found = false;
  state.field(bracketState).between(0, state.doc.length, (from) => {
    if (from == pos) found = true;
  });
  return found;
}

function nextChar(doc: Text, pos: number) {
  let next = doc.sliceString(pos, pos + 2);
  return next.slice(0, codePointSize(codePointAt(next, 0)));
}

function prevChar(doc: Text, pos: number) {
  let prev = doc.sliceString(pos - 2, pos);
  return codePointSize(codePointAt(prev, 0)) == prev.length ? prev : prev.slice(1);
}

function handleOpen(state: EditorState, open: string, close: string, closeBefore: string) {
  let blocked = null;
  let changes = state.changeByRange((range) => {
    if (!range.empty) {
      return {
        changes: [
          { insert: open, from: range.from },
          { insert: close, from: range.to },
        ],
        effects: closeBracketEffect.of(range.to + open.length),
        range: EditorSelection.range(range.anchor + open.length, range.head + open.length),
      };
    }
    let next = nextChar(state.doc, range.head);
    if (!next || /\s/.test(next) || closeBefore.includes(next)) {
      return {
        changes: { insert: open + close, from: range.head },
        effects: closeBracketEffect.of(range.head + open.length),
        range: EditorSelection.cursor(range.head + open.length),
      };
    }
    return { range: (blocked = range) };
  });
  return blocked ? null : state.update(changes, { scrollIntoView: true, userEvent: "input.type" });
}

function handleClose(state: EditorState, close: string) {
  let blocked = null;
  let changes = state.changeByRange((range) => {
    if (range.empty && nextChar(state.doc, range.head) == close) {
      return {
        changes: { from: range.head, to: range.head + close.length, insert: close },
        range: EditorSelection.cursor(range.head + close.length),
      };
    }
    return (blocked = { range });
  });
  return blocked ? null : state.update(changes, { scrollIntoView: true, userEvent: "input.type" });
}

function handleSame(
  state: EditorState,
  token: string,
  allowTriple: boolean,
  _config: CloseBracketConfig,
) {
  let blocked = null;
  let changes = state.changeByRange((range) => {
    if (!range.empty) {
      return {
        changes: [
          { insert: token, from: range.from },
          { insert: token, from: range.to },
        ],
        effects: closeBracketEffect.of(range.to + token.length),
        range: EditorSelection.range(range.anchor + token.length, range.head + token.length),
      };
    }
    let pos = range.head;
    let next = nextChar(state.doc, pos);
    if (next == token && closedBracketAt(state, pos)) {
      let triple = allowTriple && state.sliceDoc(pos, pos + token.length * 3) == token.repeat(3);
      let content = triple ? token.repeat(3) : token;
      return {
        changes: { from: pos, to: pos + content.length, insert: content },
        range: EditorSelection.cursor(pos + content.length),
      };
    }
    if (state.charCategorizer(pos)(next) != CharCategory.Word) {
      return {
        changes: { insert: token + token, from: pos },
        effects: closeBracketEffect.of(pos + token.length),
        range: EditorSelection.cursor(pos + token.length),
      };
    }
    return { range: (blocked = range) };
  });
  return blocked ? null : state.update(changes, { scrollIntoView: true, userEvent: "input.type" });
}

export interface Completion {
  label: string;
  displayLabel?: string;
  sortText?: string;
  type?: string;
  detail?: string;
  info?: string | ((completion: Completion) => Node | null | Promise<Node | null>);
  apply?: string | ((view: EditorView, completion: Completion, from: number, to: number) => void);
  commitCharacters?: readonly string[];
  boost?: number;
  section?: string;
}

export interface CompletionResult {
  from: number;
  to?: number;
  options: readonly Completion[];
  validFor?: RegExp | ((text: string, from: number, to: number, state: EditorState) => boolean);
  filter?: boolean;
  commitCharacters?: readonly string[];
}

export class CompletionContext {
  constructor(
    readonly state: EditorState,
    readonly pos: number,
    readonly explicit: boolean,
    readonly view?: EditorView,
  ) {}

  tokenBefore(types: readonly string[]): {
    from: number;
    to: number;
    text: string;
    type: NodeType;
  } | null {
    let node = syntaxTree(this.state).resolveInner(this.pos, -1);
    for (let cur: typeof node | null = node; cur; cur = cur.parent) {
      if (types.includes(cur.name) && cur.from <= this.pos && cur.to >= this.pos) {
        return {
          from: cur.from,
          to: this.pos,
          text: this.state.sliceDoc(cur.from, this.pos),
          type: cur.type,
        };
      }
    }
    return null;
  }

  matchBefore(expr: RegExp) {
    let line = this.state.doc.lineAt(this.pos);
    let token = line.text.slice(0, this.pos - line.from).match(ensureAnchor(expr));
    return token ? { from: this.pos - token[0].length, to: this.pos, text: token[0] } : null;
  }

  get aborted() {
    return false;
  }

  addEventListener(_type: "abort", _listener: () => void, _options?: { onDocChange: boolean }) {}
}

function ensureAnchor(expr: RegExp) {
  return new RegExp(`${expr.source}$`, expr.flags);
}

export type CompletionSource = (
  context: CompletionContext,
) => CompletionResult | null | Promise<CompletionResult | null>;

export interface CompletionConfig {
  activateOnTyping?: boolean;
  activateOnTypingDelay?: number;
  override?: readonly CompletionSource[] | null;
  selectOnOpen?: boolean;
  defaultKeymap?: boolean;
  aboveCursor?: boolean;
  maxRenderedOptions?: number;
}

export const completionSource = Facet.define<CompletionSource>();
const completionConfig = Facet.define<CompletionConfig, Required<CompletionConfig>>({
  combine(configs) {
    return combineConfig(configs, {
      activateOnTyping: true,
      activateOnTypingDelay: 100,
      override: undefined,
      selectOnOpen: true,
      defaultKeymap: true,
      aboveCursor: false,
      maxRenderedOptions: 100,
    });
  },
});

type ActiveCompletion = {
  from: number;
  to: number;
  options: readonly Completion[];
  selected: number;
};

const startCompletionEffect = StateEffect.define<boolean>();
const closeCompletionEffect = StateEffect.define<void>();
const setCompletionEffect = StateEffect.define<ActiveCompletion | null>();
const moveSelectionEffect = StateEffect.define<number>();

const completionState = StateField.define<ActiveCompletion | null>({
  create() {
    return null;
  },
  update(value, tr) {
    if (value && tr.docChanged) {
      let from = tr.changes.mapPos(value.from, 1, MapMode.TrackDel);
      let to = tr.changes.mapPos(value.to, -1, MapMode.TrackDel);
      value = from == null || to == null || from > to ? null : { ...value, from, to };
    }
    if (value && tr.selection) {
      let main = tr.state.selection.main;
      if (!main.empty || main.head < value.from || main.head > value.to) value = null;
    }
    for (let effect of tr.effects) {
      if (effect.is(setCompletionEffect)) value = effect.value;
      else if (effect.is(closeCompletionEffect)) value = null;
      else if (effect.is(moveSelectionEffect) && value) {
        let length = value.options.length;
        value = {
          ...value,
          selected: length ? (value.selected + effect.value + length) % length : -1,
        };
      }
    }
    return value;
  },
  provide: (field) =>
    showTooltip.computeN([field, completionConfig], (state): readonly Tooltip[] => {
      let active = state.field(field);
      return active ? [completionTooltip(active, state.facet(completionConfig))] : [];
    }),
});

export const pickedCompletion = Annotation.define<Completion>();

function completionTooltip(active: ActiveCompletion, config: Required<CompletionConfig>): Tooltip {
  return {
    pos: active.from,
    end: active.to,
    above: config.aboveCursor,
    create(view) {
      return new CompletionTooltipView(view);
    },
  };
}

class CompletionTooltipView {
  dom: HTMLElement;

  constructor(readonly view: EditorView) {
    this.dom = document.createElement("div");
    this.dom.className = "cm-tooltip-autocomplete";
    this.render();
  }

  update(update: ViewUpdate) {
    if (
      update.startState.field(completionState, false) != update.state.field(completionState, false)
    ) {
      this.render();
    }
  }

  private render() {
    let active = this.view.state.field(completionState, false);
    this.dom.replaceChildren();
    if (!active) return;
    let max = this.view.state.facet(completionConfig).maxRenderedOptions;
    let list = document.createElement("ul");
    list.setAttribute("role", "listbox");
    for (let i = 0; i < Math.min(active.options.length, max); i++) {
      let option = active.options[i]!;
      let item = document.createElement("li");
      item.setAttribute("role", "option");
      if (i == active.selected) item.setAttribute("aria-selected", "true");
      let label = document.createElement("span");
      label.className = "cm-completionLabel";
      label.textContent = option.displayLabel ?? option.label;
      item.appendChild(label);
      if (option.detail) {
        let detail = document.createElement("span");
        detail.className = "cm-completionDetail";
        detail.textContent = option.detail;
        item.appendChild(detail);
      }
      item.addEventListener("mousedown", (event) => event.preventDefault());
      item.addEventListener("click", () =>
        applyCompletion(this.view, option, active.from, active.to),
      );
      list.appendChild(item);
    }
    this.dom.appendChild(list);
  }
}

function baseTheme() {
  return EditorView.baseTheme({
    ".cm-tooltip-autocomplete": {
      border: "1px solid #bbb",
      background: "white",
      color: "#222",
      borderRadius: "3px",
      boxShadow: "0 2px 8px #0002",
      overflow: "hidden",
      fontFamily: "monospace",
      fontSize: "90%",
    },
    ".cm-tooltip-autocomplete ul": {
      listStyle: "none",
      margin: "0",
      padding: "2px",
      maxHeight: "18em",
      overflowY: "auto",
    },
    ".cm-tooltip-autocomplete li": {
      padding: "2px 6px",
      display: "flex",
      gap: "1em",
      cursor: "default",
    },
    ".cm-tooltip-autocomplete li[aria-selected]": {
      background: "#0366d6",
      color: "white",
    },
    ".cm-completionDetail": {
      marginLeft: "auto",
      opacity: "0.7",
    },
  });
}

const completionKeymapExt = Prec.highest(
  keymap.computeN([completionConfig], (state) =>
    state.facet(completionConfig).defaultKeymap ? [completionKeymap] : [],
  ),
);

export function autocompletion(config: CompletionConfig = {}): Extension {
  let extensions: Extension[] = [
    completionConfig.of(config),
    completionState,
    completionPlugin,
    completionKeymapExt,
    baseTheme(),
  ];
  if (config.override)
    extensions.push(...config.override.map((source) => completionSource.of(source)));
  return extensions;
}

const completionPlugin = ViewPlugin.fromClass(
  class {
    private timeout = 0;
    private request = 0;

    constructor(readonly view: EditorView) {}

    update(update: ViewUpdate) {
      for (let tr of update.transactions) {
        for (let effect of tr.effects) {
          if (effect.is(startCompletionEffect)) void this.start(effect.value);
        }
      }
      let completed = update.transactions.some(
        (tr) =>
          tr.isUserEvent("input.complete") ||
          tr.effects.some((effect) => effect.is(closeCompletionEffect)),
      );
      if (
        update.docChanged &&
        !completed &&
        update.state.facet(completionConfig).activateOnTyping
      ) {
        this.schedule();
      }
    }

    destroy() {
      clearTimeout(this.timeout);
    }

    private schedule() {
      clearTimeout(this.timeout);
      let delay = this.view.state.facet(completionConfig).activateOnTypingDelay;
      this.timeout = setTimeout(() => this.start(false), delay) as unknown as number;
    }

    private async start(explicit: boolean) {
      let request = ++this.request;
      clearTimeout(this.timeout);
      let { state } = this.view;
      let range = state.selection.main;
      if (!range.empty) return this.view.dispatch({ effects: closeCompletionEffect.of() });
      let context = new CompletionContext(state, range.head, explicit, this.view);
      let results = await Promise.all(
        configuredSources(state, range.head).map((source) => Promise.resolve(source(context))),
      );
      if (request != this.request) return;
      let result = results.find((result): result is CompletionResult => !!result?.options.length);
      if (!result) {
        if (explicit) this.view.dispatch({ effects: closeCompletionEffect.of() });
        return;
      }
      let to = result.to ?? range.head;
      let options = filterCompletionOptions(state, result, result.from, to);
      if (!options.length) {
        this.view.dispatch({ effects: closeCompletionEffect.of() });
        return;
      }
      let active: ActiveCompletion = {
        from: result.from,
        to,
        options,
        selected: state.facet(completionConfig).selectOnOpen ? 0 : -1,
      };
      this.view.dispatch({ effects: setCompletionEffect.of(active) });
    }
  },
);

function configuredSources(state: EditorState, pos: number): readonly CompletionSource[] {
  let config = state.facet(completionConfig);
  if (config.override) return config.override;
  if (config.override === null) return [];
  let result = Array.from(state.facet(completionSource));
  for (let value of state.languageDataAt<CompletionSource | readonly (string | Completion)[]>(
    "autocomplete",
    pos,
  )) {
    result.push(
      Array.isArray(value)
        ? completeFromList(value as readonly (string | Completion)[])
        : (value as CompletionSource),
    );
  }
  return result;
}

export function completeFromList(list: readonly (string | Completion)[]): CompletionSource {
  let options = list.map((option) => (typeof option == "string" ? { label: option } : option));
  return (context) => {
    let token = context.matchBefore(/\w*/);
    if (!context.explicit && (!token || !token.text)) return null;
    return { from: token ? token.from : context.pos, options, validFor: /^\w*$/ };
  };
}

export function ifIn(nodes: readonly string[], source: CompletionSource): CompletionSource {
  return (context) =>
    nodeAt(context).some((node) => nodes.includes(node.name)) ? source(context) : null;
}

export function ifNotIn(nodes: readonly string[], source: CompletionSource): CompletionSource {
  return (context) =>
    nodeAt(context).some((node) => nodes.includes(node.name)) ? null : source(context);
}

function nodeAt(context: CompletionContext) {
  let result = [];
  let node = syntaxTree(context.state).resolveInner(context.pos, -1);
  for (let cur: typeof node | null = node; cur; cur = cur.parent) {
    result.push(cur);
  }
  return result;
}

export const startCompletion: Command = (view) => {
  if (view.state.field(completionState, false) === undefined) return false;
  view.dispatch({ effects: startCompletionEffect.of(true) });
  return true;
};

export const closeCompletion: Command = (view) => {
  if (!view.state.field(completionState, false)) return false;
  view.dispatch({ effects: closeCompletionEffect.of() });
  return true;
};

export const acceptCompletion: Command = (view) => {
  let active = view.state.field(completionState, false);
  if (!active || active.selected < 0) return false;
  let option = active.options[active.selected];
  if (!option) return false;
  applyCompletion(view, option, active.from, active.to);
  return true;
};

export const moveCompletionSelection: (forward: boolean, by?: "option" | "page") => Command =
  (forward, by = "option") =>
  (view) => {
    let active = view.state.field(completionState, false);
    if (!active) return false;
    view.dispatch({
      effects: moveSelectionEffect.of((forward ? 1 : -1) * (by == "page" ? 10 : 1)),
    });
    return true;
  };

function applyCompletion(view: EditorView, completion: Completion, from: number, to: number) {
  if (typeof completion.apply == "function") {
    completion.apply(view, completion, from, to);
    return;
  }
  let text = completion.apply || completion.label;
  view.dispatch({
    ...insertCompletionText(view.state, text, from, to),
    annotations: pickedCompletion.of(completion),
    effects: closeCompletionEffect.of(),
    userEvent: "input.complete",
  });
}

export function insertCompletionText(
  state: EditorState,
  text: string,
  from: number,
  to: number,
): TransactionSpec {
  let changes = state.changeByRange((range) => {
    if (range.empty || range.from == from) {
      return {
        changes: { from, to, insert: text },
        range: EditorSelection.cursor(from + text.length),
      };
    }
    return { range };
  });
  return { ...changes, scrollIntoView: true };
}

export function currentCompletions(state: EditorState): readonly Completion[] {
  return state.field(completionState, false)?.options ?? [];
}

export function selectedCompletion(state: EditorState): Completion | null {
  let active = state.field(completionState, false);
  return active && active.selected > -1 ? (active.options[active.selected] ?? null) : null;
}

export function selectedCompletionIndex(state: EditorState): number {
  return state.field(completionState, false)?.selected ?? -1;
}

export function completionStatus(state: EditorState): "active" | null {
  return state.field(completionState, false) ? "active" : null;
}

export const completionKeymap: readonly KeyBinding[] = [
  { key: "Ctrl-Space", run: startCompletion },
  { mac: "Alt-`", run: startCompletion },
  { mac: "Alt-i", run: startCompletion },
  { key: "Escape", run: closeCompletion },
  { key: "ArrowDown", run: moveCompletionSelection(true) },
  { key: "ArrowUp", run: moveCompletionSelection(false) },
  { key: "PageDown", run: moveCompletionSelection(true, "page") },
  { key: "PageUp", run: moveCompletionSelection(false, "page") },
  { key: "Enter", run: acceptCompletion },
];
