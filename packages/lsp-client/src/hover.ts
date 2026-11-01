import type * as lsp from "vscode-languageserver-protocol";
import { EditorView, hoverTooltip, type Tooltip } from "@codemirror/view";
import { Text, type Extension } from "@codemirror/state";
import {
  language as languageFacet,
  highlightingFor,
  highlightCode,
} from "@codemirror-treesitter/language";
import { fromPosition } from "./pos.js";
import { escHTML, fencedCodeLanguages, loadedLanguage, preloadHighlightLanguages } from "./text.js";
import { LSPPlugin } from "./plugin.js";

/// Create an extension that queries the language server for hover
/// tooltips when the user hovers over the code with their pointer,
/// and displays a tooltip when the server provides one.
export function hoverTooltips(config: { hoverTime?: number } = {}): Extension {
  return hoverTooltip(lspTooltipSource, {
    hideOn: (tr) => tr.docChanged,
    hoverTime: config.hoverTime,
  });
}

function hoverRequest(plugin: LSPPlugin, pos: number) {
  if (plugin.client.hasCapability("hoverProvider") === false) return Promise.resolve(null);
  plugin.client.sync();
  return plugin.client.request<lsp.HoverParams, lsp.Hover | null>("textDocument/hover", {
    position: plugin.toPosition(pos),
    textDocument: { uri: plugin.uri },
  });
}

function lspTooltipSource(view: EditorView, pos: number): Promise<Tooltip | null> {
  const plugin = LSPPlugin.get(view);
  if (!plugin) return Promise.resolve(null);
  return hoverRequest(plugin, pos).then(async (result) => {
    if (!result) return null;
    // Give lazily loaded code block grammars a chance to load so the
    // tooltip renders highlighted; otherwise it falls back to plain text.
    await preloadHighlightLanguages(
      plugin.client.config.highlightLanguage,
      hoverCodeLanguages(result.contents),
    );
    return {
      pos: result.range ? fromPosition(view.state.doc, result.range.start) : pos,
      end: result.range ? fromPosition(view.state.doc, result.range.end) : pos,
      create() {
        let elt = document.createElement("div");
        elt.className = "cm-lsp-hover-tooltip cm-lsp-documentation";
        elt.innerHTML = renderTooltipContent(plugin, result.contents);
        return { dom: elt };
      },
      above: true,
    };
  });
}

function hoverCodeLanguages(
  value: string | lsp.MarkupContent | lsp.MarkedString | lsp.MarkedString[],
): string[] {
  if (Array.isArray(value)) return value.flatMap(hoverCodeLanguages);
  if (typeof value == "string") return fencedCodeLanguages(value);
  if ("language" in value) return value.language ? [value.language] : [];
  return value.kind == "markdown" ? fencedCodeLanguages(value.value) : [];
}

function renderTooltipContent(
  plugin: LSPPlugin,
  value: string | lsp.MarkupContent | lsp.MarkedString | lsp.MarkedString[],
) {
  if (Array.isArray(value)) return value.map((m) => renderCode(plugin, m)).join("<br>");
  if (typeof value == "string" || (typeof value == "object" && "language" in value))
    return renderCode(plugin, value);
  return plugin.docToHTML(value);
}

export function __testRenderTooltipContent(
  plugin: LSPPlugin,
  value: string | lsp.MarkupContent | lsp.MarkedString | lsp.MarkedString[],
) {
  return renderTooltipContent(plugin, value);
}

function renderCode(plugin: LSPPlugin, code: lsp.MarkedString) {
  if (typeof code == "string") return plugin.docToHTML(code, "markdown");
  let { language, value } = code;
  let lang = loadedLanguage(
    plugin.client.config.highlightLanguage &&
      plugin.client.config.highlightLanguage(language || ""),
  );
  if (!lang) {
    let viewLang = plugin.view.state.facet(languageFacet);
    if (viewLang && (!language || viewLang.name == language)) lang = viewLang;
  }
  if (!lang) return escHTML(value);
  let result = "";
  highlightCode(
    value,
    lang.parser.parse(Text.of(value.split(/\r?\n/))),
    { style: (tags) => highlightingFor(plugin.view.state, tags) },
    (text, cls) => {
      result += cls ? `<span class="${cls}">${escHTML(text)}</span>` : escHTML(text);
    },
    () => {
      result += "<br>";
    },
  );
  return result;
}
