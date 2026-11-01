import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import {
  LanguageDescription,
  LanguageSupport,
  TreeSitterLanguage,
  TreeSitterParser,
  syntaxHighlighting,
  tagHighlighter,
  tags,
  type Language,
} from "@codemirror-treesitter/language";
import { LSPPlugin } from "../src/index.js";
import { __testRenderTooltipContent } from "../src/hover.js";
import {
  docToHTML,
  fencedCodeLanguages,
  preloadHighlightLanguages,
  withContext,
} from "../src/text.js";

const javascriptWasm = new URL(
  "../../../node_modules/tree-sitter-javascript/tree-sitter-javascript.wasm",
  import.meta.url,
).pathname;

let javascriptParser: Promise<TreeSitterParser> | null = null;

async function javascriptLanguage() {
  javascriptParser ??= TreeSitterParser.load(javascriptWasm);
  return TreeSitterLanguage.define({
    name: "javascript",
    parser: await javascriptParser,
  });
}

function stateWith(language: Language) {
  return EditorState.create({
    doc: "",
    extensions: [
      language.extension,
      syntaxHighlighting(
        tagHighlighter([
          { tag: tags.keyword, class: "kw" },
          { tag: tags.variableName, class: "var" },
          { tag: tags.number, class: "num" },
        ]),
      ),
    ],
  });
}

describe("LSP markdown rendering", () => {
  it("highlights fenced markdown code blocks with tree-sitter", async () => {
    let javascript = await javascriptLanguage();
    let view = { state: stateWith(javascript) } as unknown as LSPPlugin["view"];
    let html = withContext(
      view,
      (name) => (name == "javascript" ? javascript : null),
      () =>
        docToHTML(
          {
            kind: "markdown",
            value: "```javascript\nlet value = 1;\n```",
          },
          "plaintext",
        ),
    );

    expect(html).toContain('class="kw"');
    expect(html).toContain('class="var"');
    expect(html).toContain('class="num"');
  });

  it("highlights hover MarkedString code through the local language package", async () => {
    let javascript = await javascriptLanguage();
    let view = { state: stateWith(javascript) } as unknown as LSPPlugin["view"];
    let plugin = {
      view,
      client: {
        config: {
          highlightLanguage: (name: string) => (name == "javascript" ? javascript : null),
        },
      },
      docToHTML: (value: string, kind: "markdown" | "plaintext" = "plaintext") =>
        docToHTML(value, kind),
    } as unknown as LSPPlugin;
    let html = __testRenderTooltipContent(plugin, {
      language: "javascript",
      value: "let value = 1;\n",
    });

    expect(html).toContain('class="kw"');
    expect(html).toContain('class="var"');
    expect(html).toContain('class="num"');
  });

  it("renders lazily loaded languages as plain text until their grammar loads", async () => {
    let javascript = await javascriptLanguage();
    let plain = stateWith(javascript);
    let view = { state: plain } as unknown as LSPPlugin["view"];
    let loads = 0;
    let description = LanguageDescription.of({
      name: "lazyscript",
      load: async () => {
        loads++;
        return new LanguageSupport(javascript);
      },
    });
    let lookup = (name: string) => (name == "lazyscript" ? description : null);
    let markdown = "```lazyscript\nlet value = 1;\n```";
    let render = () => withContext(view, lookup, () => docToHTML(markdown, "markdown"));

    let before = render();
    expect(before).not.toContain('class="kw"');
    expect(before).toContain("let value = 1;");

    expect(fencedCodeLanguages(markdown)).toEqual(["lazyscript"]);
    await preloadHighlightLanguages(lookup, fencedCodeLanguages(markdown));
    expect(description.support).toBeDefined();
    expect(render()).toContain('class="kw"');
    expect(loads).toBe(1);
  });

  it("stops waiting for a grammar that does not load in time", async () => {
    let never = LanguageDescription.of({ name: "never", load: () => new Promise(() => {}) });
    let failing = LanguageDescription.of({
      name: "failing",
      load: () => Promise.reject(new Error("missing wasm")),
    });
    let lookup = (name: string) => (name == "never" ? never : name == "failing" ? failing : null);
    let started = Date.now();
    await preloadHighlightLanguages(lookup, ["never", "failing", "unknown"], 20);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(never.support).toBeUndefined();
  });
});
