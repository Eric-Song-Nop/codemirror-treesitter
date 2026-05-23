import {
  EditorSelection,
  EditorState,
  Facet,
  MapMode,
  RangeSet,
  RangeValue,
  StateEffect,
  StateField,
  CharCategory,
  codePointAt,
  codePointSize,
  fromCodePoint,
  type Extension,
  type StateCommand,
  type Text,
  type Transaction,
} from "@codemirror/state";
import { EditorView, type KeyBinding } from "@codemirror/view";

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
  type?: string;
  detail?: string;
  info?: string;
  apply?: string | ((view: EditorView, completion: Completion, from: number, to: number) => void);
}

export interface CompletionResult {
  from: number;
  to?: number;
  options: readonly Completion[];
  validFor?: RegExp | ((text: string, from: number, to: number, state: EditorState) => boolean);
}

export class CompletionContext {
  constructor(
    readonly state: EditorState,
    readonly pos: number,
    readonly explicit: boolean,
  ) {}

  matchBefore(expr: RegExp) {
    let line = this.state.doc.lineAt(this.pos);
    let token = line.text.slice(0, this.pos - line.from).match(ensureAnchor(expr));
    return token ? { from: this.pos - token[0].length, to: this.pos, text: token[0] } : null;
  }
}

function ensureAnchor(expr: RegExp) {
  return new RegExp(`${expr.source}$`, expr.flags);
}

export type CompletionSource = (
  context: CompletionContext,
) => CompletionResult | null | Promise<CompletionResult | null>;

export interface CompletionConfig {
  override?: readonly CompletionSource[] | null;
}

export const completionSource = Facet.define<CompletionSource>();
const completionConfig = Facet.define<CompletionConfig>();

export function autocompletion(config: CompletionConfig = {}): Extension {
  let extensions: Extension[] = [completionConfig.of(config)];
  if (config.override)
    extensions.push(...config.override.map((source) => completionSource.of(source)));
  return extensions;
}

export const startCompletion: StateCommand = () => false;
export const acceptCompletion: StateCommand = () => false;
export const closeCompletion: StateCommand = () => false;
export const moveCompletionSelection: (forward: boolean) => StateCommand = () => () => false;

export const completionKeymap: readonly KeyBinding[] = [
  { key: "Ctrl-Space", run: startCompletion },
  { key: "Escape", run: closeCompletion },
  { key: "Enter", run: acceptCompletion },
];
