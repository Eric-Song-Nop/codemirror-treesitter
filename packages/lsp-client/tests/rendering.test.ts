import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import {
  TreeSitterLanguage,
  TreeSitterParser,
  syntaxHighlighting,
  tagHighlighter,
  tags,
  type Language,
} from "@codemirror-treesitter/language";
import { LSPPlugin } from "../src/index.js";
import { __testRenderTooltipContent } from "../src/hover.js";
import { docToHTML, withContext } from "../src/text.js";

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
});
