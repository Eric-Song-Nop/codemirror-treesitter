import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import {
  ParseContext,
  StreamLanguage,
  type TreeSitterParser,
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
    expect(tree.resolveInner(doc.indexOf("let"), 1).name).toBe("keyword");
    expect(tree.resolveInner(doc.indexOf('"ok"'), 1).name).toBe("string");
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

  it("reparses stream languages after document edits", () => {
    let language = StreamLanguage.define(demoParser);
    let state = EditorState.create({
      doc: "let value = 1;\n",
      extensions: [language.extension],
    });
    let transaction = state.update({
      changes: { from: state.doc.toString().indexOf("1"), to: 13, insert: '"ok"' },
    });
    let tree = ensureSyntaxTree(transaction.state, transaction.state.doc.length)!;

    expect(tree.resolveInner(transaction.state.doc.toString().indexOf('"ok"'), 1).name).toBe(
      "string",
    );
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

  it("resumes long stream parses across work slices and reuses the unchanged prefix", () => {
    let tokenizedLines = 0;
    let countingParser: StreamParser<DemoState> = {
      ...demoParser,
      token(stream, state) {
        if (stream.sol()) tokenizedLines++;
        return demoParser.token(stream, state);
      },
    };
    let language = StreamLanguage.define(countingParser);
    let lines = Array.from({ length: 2_000 }, (_, index) =>
      index % 10 == 0 ? "{" : index % 10 == 9 ? "}" : `let v${index} = ${index};`,
    );
    let state = EditorState.create({ doc: lines.join("\n") });
    let parser = language.parser as unknown as TreeSitterParser;
    let context = ParseContext.create(parser, state);

    // At most 300 lines per slice: the parse needs several slices.
    let slices = 0;
    let done = false;
    while (!done) {
      let budget = 300;
      done = context.work(() => budget-- <= 0);
      slices++;
      expect(slices).toBeLessThan(20);
    }
    expect(slices).toBeGreaterThan(5);
    expect(tokenizedLines).toBe(state.doc.lines);
    expect(context.tree.length).toBe(state.doc.length);

    // Editing the last line only re-tokenizes from that line.
    tokenizedLines = 0;
    let last = state.doc.line(state.doc.lines);
    let transaction = state.update({ changes: { from: last.from, insert: "  " } });
    let next = context.changes(transaction.changes, state, transaction.state);
    expect(next.work(() => false)).toBe(true);
    expect(tokenizedLines).toBe(1);
    expect(next.tree.resolveInner(transaction.state.doc.line(5).from + 4, 1).name).toBe("variable");
  });

  it("answers stream indentation from cached line states", () => {
    let tokenizedLines = 0;
    let language = StreamLanguage.define<DemoState>({
      ...demoParser,
      token(stream, state) {
        if (stream.sol()) tokenizedLines++;
        return demoParser.token(stream, state);
      },
    });
    let doc = Array.from({ length: 200 }, (_, index) => (index < 3 ? "{" : "value")).join("\n");
    let state = EditorState.create({ doc, extensions: [language.extension] });
    expect(ensureSyntaxTree(state, state.doc.length, 5_000)).not.toBeNull();

    tokenizedLines = 0;
    expect(getIndentation(state, state.doc.line(150).from)).toBe(6);
    expect(getIndentation(state, state.doc.line(199).from)).toBe(6);
    expect(tokenizedLines).toBe(0);
  });
});
