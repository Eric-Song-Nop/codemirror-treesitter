import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import {
  StreamLanguage,
  ensureSyntaxTree,
  getIndentation,
  syntaxTree,
  tagHighlighter,
  tags,
  type StreamParser,
} from "../src/index.js";
import { __testHighlightTree } from "../src/highlight.js";
import { legacy } from "../src/stream-parser.js";

type DemoState = {
  indent: number;
};

const demoParser: StreamParser<DemoState> = {
  name: "demo-stream",
  startState: () => ({ indent: 0 }),
  token(stream, state) {
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("{")) {
      state.indent++;
      return "bracket";
    }
    if (stream.match("}")) {
      state.indent = Math.max(0, state.indent - 1);
      return "bracket";
    }
    if (stream.match(/"(?:[^"\\]|\\.)*"/)) return "string";
    if (stream.match(/\d+/)) return "number";
    if (stream.match(/\b(?:if|let|return)\b/)) return "keyword";
    if (stream.match(/[A-Za-z_]\w*/)) return "variable";
    stream.next();
    return null;
  },
  indent(state, textAfter, context) {
    let depth = textAfter.startsWith("}") ? Math.max(0, state.indent - 1) : state.indent;
    return depth * context.unit;
  },
  languageData: {
    commentTokens: { line: "//" },
  },
};

describe("stream parser compatibility", () => {
  it("defines a usable Lezer-free stream language", () => {
    let language = StreamLanguage.define(demoParser);
    let doc = 'let value = "ok";\n// comment\n';
    let state = EditorState.create({
      doc,
      extensions: [language.extension],
    });
    let tree = ensureSyntaxTree(state, state.doc.length)!;

    expect(language.name).toBe("demo-stream");
    expect(tree.topNode.name).toBe("Document");
    expect(tree.resolveInner(doc.indexOf("let")).name).toBe("keyword");
    expect(tree.resolveInner(doc.indexOf('"ok"')).name).toBe("string");
    expect(state.languageDataAt("commentTokens", 0)).toEqual([{ line: "//" }]);
  });

  it("highlights stream parser token tags", () => {
    let language = StreamLanguage.define(demoParser);
    let doc = 'let value = "ok";\n';
    let state = EditorState.create({
      doc,
      extensions: [language.extension],
    });
    let highlighter = tagHighlighter([
      { tag: tags.keyword, class: "kw" },
      { tag: tags.string, class: "str" },
    ]);
    let spans = __testHighlightTree(syntaxTree(state), [highlighter]);

    expect(spans).toContainEqual({ from: 0, to: 3, class: "kw" });
    expect(spans).toContainEqual({
      from: doc.indexOf('"ok"'),
      to: doc.indexOf('"ok"') + 4,
      class: "str",
    });
  });

  it("uses stream parser indentation and legacy support", () => {
    let support = legacy(demoParser);
    let doc = "{\nvalue\n}\n";
    let state = EditorState.create({
      doc,
      extensions: [support.extension],
    });

    expect(getIndentation(state, state.doc.line(2).from)).toBe(2);
    expect(getIndentation(state, state.doc.line(3).from)).toBe(0);
    expect(support.language.name).toBe("demo-stream");
  });
});
