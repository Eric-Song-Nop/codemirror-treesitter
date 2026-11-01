import type * as lsp from "vscode-languageserver-protocol";
import { Marked } from "marked";
import { EditorView } from "@codemirror/view";
import { Text } from "@codemirror/state";
import {
  Language,
  LanguageDescription,
  language as languageFacet,
  highlightingFor,
  highlightCode,
  type Highlighter,
} from "@codemirror-treesitter/language";

/// What [`highlightLanguage`](#lsp-client.LSPClientConfig.highlightLanguage)
/// may return for a code block's language tag.
export type HighlightLanguageSource = Language | LanguageDescription | null;

type HighlightLanguageLookup = ((name: string) => HighlightLanguageSource) | undefined;

let context: {
  view: EditorView;
  language: HighlightLanguageLookup;
} | null = null;

/// Resolve a highlight language source to a language that can parse right
/// now. A `LanguageDescription` whose grammar has not loaded yet starts
/// loading and yields null, so the code renders as plain text.
export function loadedLanguage(source: HighlightLanguageSource | undefined): Language | null {
  if (!source) return null;
  let lang: Language | null;
  if (source instanceof LanguageDescription) {
    lang = source.support?.language ?? null;
    if (!lang) void source.load().catch(() => {});
  } else {
    lang = source;
  }
  return lang && !lang.parser.isSkippingParser ? lang : null;
}

const fencePattern = /^ {0,3}(?:`{3,}|~{3,})[ \t]*([^\s`{]+)/gm;

/// The language tags of fenced code blocks in a Markdown string.
export function fencedCodeLanguages(markdown: string): string[] {
  let names: string[] = [];
  for (let match of markdown.matchAll(fencePattern)) names.push(match[1]!);
  return names;
}

/// Wait (at most `maxWait` ms) for the grammars of the given language tags
/// to load, so that rendering can highlight them. Failed or slow loads
/// resolve anyway; the affected code then renders as plain text.
export function preloadHighlightLanguages(
  lookup: HighlightLanguageLookup,
  names: Iterable<string>,
  maxWait = 1000,
): Promise<void> {
  if (!lookup) return Promise.resolve();
  let loads: Promise<unknown>[] = [];
  for (let name of new Set(names)) {
    let source = lookup(name);
    if (source instanceof LanguageDescription && !source.support)
      loads.push(source.load().catch(() => null));
  }
  if (!loads.length) return Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.all(loads),
    new Promise((resolve) => (timer = setTimeout(resolve, maxWait))),
  ]).then(() => clearTimeout(timer));
}

export function withContext<T>(view: EditorView, language: HighlightLanguageLookup, f: () => T): T {
  let prev = context;
  try {
    context = { view, language };
    return f();
  } finally {
    context = prev;
  }
}

const marked = new Marked({
  walkTokens(token) {
    if (!context || token.type != "code") return;

    let lang = loadedLanguage(context.language && context.language(token.lang));
    if (!lang) {
      let viewLang = context.view.state.facet(languageFacet);
      if (viewLang && viewLang.name == token.lang) lang = viewLang;
    }
    if (!lang) return;
    let highlighter: Highlighter = { style: (tags) => highlightingFor(context!.view.state, tags) };
    let result = "";
    highlightCode(
      token.text,
      lang.parser.parse(Text.of(token.text.split(/\r?\n/))),
      highlighter,
      (text, cls) => {
        result += cls ? `<span class="${cls}">${escHTML(text)}</span>` : escHTML(text);
      },
      () => {
        result += "<br>";
      },
    );
    token.escaped = true;
    token.text = result;
  },
});

export function escHTML(text: string) {
  return text.replace(/[\n<&]/g, (ch) => (ch == "\n" ? "<br>" : ch == "<" ? "&lt;" : "&amp;"));
}

export function docToHTML(value: string | lsp.MarkupContent, defaultKind: lsp.MarkupKind) {
  let kind = defaultKind,
    text = value;
  if (typeof text != "string") {
    kind = text.kind;
    text = text.value;
  }
  if (kind == "plaintext") {
    return escHTML(text);
  } else {
    return marked.parse(text, { async: false });
  }
}
