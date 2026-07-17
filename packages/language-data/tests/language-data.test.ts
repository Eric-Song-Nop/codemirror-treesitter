import { EditorState, Text } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import {
  LanguageDescription,
  NodeProp,
  Tree,
  defineLanguageFacet,
  ensureSyntaxTree,
  queryTreeCaptures,
  sublanguageProp,
  syntaxTree,
  syntaxTreeAvailable,
  tagHighlighter,
  tags,
  type SyntaxNode,
  type TreeSitterLanguage,
} from "@codemirror-treesitter/language";
import { __testHighlightTree } from "../../language/src/highlight.js";
import { languages, loadMarkdownParserService } from "../src/index.js";
import codeFenceDelimiterQuerySource from "./queries/code-fence-delimiters.scm?raw";

function ancestorNames(node: SyntaxNode) {
  let names: string[] = [];
  for (let cur: SyntaxNode | null = node; cur; cur = cur.parent) names.push(cur.name);
  return names;
}

function hasAncestorNamed(tree: Tree, position: number, name: string) {
  return ancestorNames(tree.resolveInner(position)).includes(name);
}

describe("tree-sitter language data", () => {
  it("matches upstream filenames, aliases, and extensions for tree-sitter-backed entries", () => {
    expect(LanguageDescription.matchFilename(languages, "PKGBUILD")?.name).toBe("Shell");
    expect(LanguageDescription.matchFilename(languages, "Gemfile")?.name).toBe("Ruby");
    expect(LanguageDescription.matchFilename(languages, "template.hbs")?.name).toBe("HTML");
    expect(LanguageDescription.matchFilename(languages, "program.apl")?.name).toBe("APL");
    expect(LanguageDescription.matchFilename(languages, "schema.asn1")?.name).toBe("ASN.1");
    expect(LanguageDescription.matchFilename(languages, "extensions.conf")?.name).toBe("Asterisk");
    expect(LanguageDescription.matchFilename(languages, "context.jsonld")?.name).toBe("JSON-LD");
    expect(LanguageDescription.matchFilename(languages, "README.md")?.name).toBe("Markdown");
    expect(LanguageDescription.matchFilename(languages, "program.bf")?.name).toBe("Brainfuck");
    expect(LanguageDescription.matchFilename(languages, "core.clj")?.name).toBe("Clojure");
    expect(LanguageDescription.matchFilename(languages, "view.cljs")?.name).toBe("ClojureScript");
    expect(LanguageDescription.matchFilename(languages, "CMakeLists.txt")?.name).toBe("CMake");
    expect(LanguageDescription.matchFilename(languages, "program.cob")?.name).toBe("Cobol");
    expect(LanguageDescription.matchFilename(languages, "script.coffee")?.name).toBe(
      "CoffeeScript",
    );
    expect(LanguageDescription.matchFilename(languages, "main.cr")?.name).toBe("Crystal");
    expect(LanguageDescription.matchFilename(languages, "data.edn")?.name).toBe("edn");
    expect(LanguageDescription.matchFilename(languages, "init.lisp")?.name).toBe("Common Lisp");
    expect(LanguageDescription.matchFilename(languages, "graph.cypher")?.name).toBe("Cypher");
    expect(LanguageDescription.matchFilename(languages, "module.pyx")?.name).toBe("Cython");
    expect(LanguageDescription.matchFilename(languages, "change.diff")?.name).toBe("diff");
    expect(LanguageDescription.matchFilename(languages, "Dockerfile")?.name).toBe("Dockerfile");
    expect(LanguageDescription.matchFilename(languages, "schema.dtd")?.name).toBe("DTD");
    expect(LanguageDescription.matchFilename(languages, "module.dylan")?.name).toBe("Dylan");
    expect(LanguageDescription.matchFilename(languages, "cluster.ecl")?.name).toBe("ECL");
    expect(LanguageDescription.matchFilename(languages, "class.e")?.name).toBe("Eiffel");
    expect(LanguageDescription.matchFilename(languages, "theme.gss")?.name).toBe(
      "Closure Stylesheets (GSS)",
    );
    expect(LanguageDescription.matchFilename(languages, "script.pl")?.name).toBe("Perl");
    expect(LanguageDescription.matchFilename(languages, "app.vue")?.name).toBe("Vue");
    expect(LanguageDescription.matchFilename(languages, "main.elm")?.name).toBe("Elm");
    expect(LanguageDescription.matchFilename(languages, "module.erl")?.name).toBe("Erlang");
    expect(LanguageDescription.matchFilename(languages, "program.fs")?.name).toBe("F#");
    expect(LanguageDescription.matchFilename(languages, "script.factor")?.name).toBe("Factor");
    expect(LanguageDescription.matchFilename(languages, "program.f90")?.name).toBe("Fortran");
    expect(LanguageDescription.matchFilename(languages, "words.fth")?.name).toBe("Forth");
    expect(LanguageDescription.matchFilename(languages, "startup.s")?.name).toBe("Gas");
    expect(LanguageDescription.matchFilename(languages, "demo.feature")?.name).toBe("Gherkin");
    expect(LanguageDescription.matchFilename(languages, "Main.hx")?.name).toBe("Haxe");
    expect(LanguageDescription.matchFilename(languages, "build.hxml")?.name).toBe("HXML");
    expect(LanguageDescription.matchFilename(languages, "routine.pro")?.name).toBe("IDL");
    expect(LanguageDescription.matchFilename(languages, "script.ps1")?.name).toBe("PowerShell");
    expect(LanguageDescription.matchFilename(languages, "source.mm")?.name).toBe("Objective-C++");
    expect(LanguageDescription.matchFilename(languages, "program.oz")?.name).toBe("Oz");
    expect(LanguageDescription.matchFilename(languages, "program.pas")?.name).toBe("Pascal");
    expect(LanguageDescription.matchFilename(languages, "schema.proto")?.name).toBe("ProtoBuf");
    expect(LanguageDescription.matchFilename(languages, "template.pug")?.name).toBe("Pug");
    expect(LanguageDescription.matchFilename(languages, "analysis.R")?.name).toBe("R");
    expect(LanguageDescription.matchFilename(languages, "manifest.pp")?.name).toBe("Puppet");
    expect(LanguageDescription.matchFilename(languages, "report.sas")?.name).toBe("SAS");
    expect(LanguageDescription.matchFilename(languages, "theme.sass")?.name).toBe("Sass");
    expect(LanguageDescription.matchFilename(languages, "method.st")?.name).toBe("Smalltalk");
    expect(LanguageDescription.matchFilename(languages, "basis.sml")?.name).toBe("SML");
    expect(LanguageDescription.matchFilename(languages, "filter.sieve")?.name).toBe("Sieve");
    expect(LanguageDescription.matchFilename(languages, "script.nut")?.name).toBe("Squirrel");
    expect(LanguageDescription.matchFilename(languages, "query.sql")?.name).toBe("SQL");
    expect(LanguageDescription.matchFilename(languages, "schema.cql")?.name).toBe("CQL");
    expect(LanguageDescription.matchFilename(languages, "app.d")?.name).toBe("D");
    expect(LanguageDescription.matchFilename(languages, "Jenkinsfile")?.name).toBe("Groovy");
    expect(LanguageDescription.matchFilename(languages, "plot.jl")?.name).toBe("Julia");
    expect(LanguageDescription.matchFilename(languages, "paper.tex")?.name).toBe("LaTeX");
    expect(LanguageDescription.matchFilename(languages, "theme.less")?.name).toBe("LESS");
    expect(LanguageDescription.matchFilename(languages, "script.ls")?.name).toBe("LiveScript");
    expect(LanguageDescription.matchFilename(languages, "template.liquid")?.name).toBe("Liquid");
    expect(LanguageDescription.matchFilename(languages, "notebook.wl")?.name).toBe("Mathematica");
    expect(LanguageDescription.matchFilename(languages, "notebook.nb")?.name).toBe("Mathematica");
    expect(LanguageDescription.matchFilename(languages, "archive.mbox")?.name).toBe("Mbox");
    expect(LanguageDescription.matchFilename(languages, "script.mrc")?.name).toBe("mIRC");
    expect(LanguageDescription.matchFilename(languages, "model.mo")?.name).toBe("Modelica");
    expect(LanguageDescription.matchFilename(languages, "chart.msc")?.name).toBe("MscGen");
    expect(LanguageDescription.matchFilename(languages, "chart.msgenny")?.name).toBe("MsGenny");
    expect(LanguageDescription.matchFilename(languages, "diagram.xu")?.name).toBe("Xù");
    expect(LanguageDescription.matchFilename(languages, "routine.mps")?.name).toBe("MUMPS");
    expect(LanguageDescription.matchFilename(languages, "nginx.conf")?.name).toBe("Nginx");
    expect(LanguageDescription.matchFilename(languages, "installer.nsi")?.name).toBe("NSIS");
    expect(LanguageDescription.matchFilename(languages, "data.nt")?.name).toBe("NTriples");
    expect(LanguageDescription.matchFilename(languages, "procedure.pls")?.name).toBe("PLSQL");
    expect(LanguageDescription.matchFilename(languages, "message.asc")?.name).toBe("PGP");
    expect(LanguageDescription.matchFilename(languages, "message.sig")?.name).toBe("PGP");
    expect(LanguageDescription.matchFilename(languages, "script.pig")?.name).toBe("Pig");
    expect(LanguageDescription.matchFilename(languages, "program.q")?.name).toBe("Q");
    expect(LanguageDescription.matchFilename(languages, "package.spec")?.name).toBe("RPM Spec");
    expect(LanguageDescription.matchFilename(languages, "theme.scss")?.name).toBe("SCSS");
    expect(LanguageDescription.matchFilename(languages, "query.rq")?.name).toBe("SPARQL");
    expect(LanguageDescription.matchFilename(languages, "module.sv")?.name).toBe("SystemVerilog");
    expect(LanguageDescription.matchFilename(languages, "module.v")?.name).toBe("SystemVerilog");
    expect(LanguageDescription.matchFilename(languages, "script.tcl")?.name).toBe("Tcl");
    expect(LanguageDescription.matchFilename(languages, "page.textile")?.name).toBe("Textile");
    expect(LanguageDescription.matchFilename(languages, "manual.1")?.name).toBe("Troff");
    expect(LanguageDescription.matchFilename(languages, "module.ttcn")?.name).toBe("TTCN");
    expect(LanguageDescription.matchFilename(languages, "suite.cfg")?.name).toBe("TTCN_CFG");
    expect(LanguageDescription.matchFilename(languages, "module.wat")?.name).toBe("WebAssembly");
    expect(LanguageDescription.matchFilename(languages, "spec.wast")?.name).toBe("WebAssembly");
    expect(LanguageDescription.matchFilename(languages, "module.vb")?.name).toBe("VB.NET");
    expect(LanguageDescription.matchFilename(languages, "legacy.vbs")?.name).toBe("VBScript");
    expect(LanguageDescription.matchFilename(languages, "template.vtl")?.name).toBe("Velocity");
    expect(LanguageDescription.matchFilename(languages, "design.vhdl")?.name).toBe("VHDL");
    expect(LanguageDescription.matchFilename(languages, "api.webidl")?.name).toBe("Web IDL");
    expect(LanguageDescription.matchFilename(languages, "document.xml")?.name).toBe("XML");
    expect(LanguageDescription.matchFilename(languages, "vector.svg")?.name).toBe("XML");
    expect(LanguageDescription.matchFilename(languages, "data.ttl")?.name).toBe("Turtle");
    expect(LanguageDescription.matchFilename(languages, "query.xq")?.name).toBe("XQuery");
    expect(LanguageDescription.matchFilename(languages, "style.styl")?.name).toBe("Stylus");
    expect(LanguageDescription.matchFilename(languages, "rules.ys")?.name).toBe("Yacas");
    expect(LanguageDescription.matchFilename(languages, "boot.z80")?.name).toBe("Z80");
    expect(LanguageDescription.matchFilename(languages, "settings.ini")?.name).toBe(
      "Properties files",
    );
    expect(LanguageDescription.matchFilename(languages, "worksheet.sc")).toBe(null);
    expect(LanguageDescription.matchLanguageName(languages, "cs")?.name).toBe("C#");
    expect(LanguageDescription.matchLanguageName(languages, "bash")?.name).toBe("Shell");
    expect(LanguageDescription.matchLanguageName(languages, "properties")?.name).toBe(
      "Properties files",
    );
    expect(LanguageDescription.matchLanguageName(languages, "objc++")?.name).toBe("Objective-C++");
    expect(LanguageDescription.matchLanguageName(languages, "fsharp")?.name).toBe("F#");
    expect(LanguageDescription.matchLanguageName(languages, "jade")?.name).toBe("Pug");
    expect(LanguageDescription.matchLanguageName(languages, "cassandra")?.name).toBe("CQL");
    expect(LanguageDescription.matchLanguageName(languages, "coffee")?.name).toBe("CoffeeScript");
    expect(LanguageDescription.matchLanguageName(languages, "EBNF")?.name).toBe("EBNF");
    expect(LanguageDescription.matchLanguageName(languages, "HTTP")?.name).toBe("HTTP");
    expect(LanguageDescription.matchLanguageName(languages, "postgresql")?.name).toBe("PostgreSQL");
    expect(LanguageDescription.matchLanguageName(languages, "rscript")?.name).toBe("R");
    expect(LanguageDescription.matchLanguageName(languages, "sparul")?.name).toBe("SPARQL");
    expect(LanguageDescription.matchLanguageName(languages, "rss")?.name).toBe("XML");
    expect(LanguageDescription.matchLanguageName(languages, "markdown")?.name).toBe("Markdown");
    expect(LanguageDescription.matchLanguageName(languages, "scss")?.name).toBe("SCSS");
    expect(LanguageDescription.matchLanguageName(languages, "lisp")?.name).toBe("Common Lisp");
    expect(LanguageDescription.matchLanguageName(languages, "scheme")?.name).toBe("Scheme");
    expect(LanguageDescription.matchLanguageName(languages, "Angular Template")?.name).toBe(
      "Angular Template",
    );
    expect(LanguageDescription.matchLanguageName(languages, "macruby")?.name).toBe("Ruby");
    expect(LanguageDescription.matchLanguageName(languages, "tex")?.name).toBe("LaTeX");
    expect(LanguageDescription.matchLanguageName(languages, "stex")?.name).toBe("sTeX");
    expect(LanguageDescription.matchLanguageName(languages, "mirc")?.name).toBe("mIRC");
    expect(LanguageDescription.matchLanguageName(languages, "RPM Changes")?.name).toBe(
      "RPM Changes",
    );
    expect(LanguageDescription.matchLanguageName(languages, "Esper")?.name).toBe("Esper");
    expect(LanguageDescription.matchLanguageName(languages, "FCL")?.name).toBe("FCL");
    expect(LanguageDescription.matchLanguageName(languages, "Solr")?.name).toBe("Solr");
    expect(LanguageDescription.matchLanguageName(languages, "excel")?.name).toBe("Spreadsheet");
    expect(LanguageDescription.matchLanguageName(languages, "formula")?.name).toBe("Spreadsheet");
    expect(LanguageDescription.matchLanguageName(languages, "Octave")?.name).toBe("Octave");
    expect(LanguageDescription.matchLanguageName(languages, "TiddlyWiki")?.name).toBe("TiddlyWiki");
    expect(LanguageDescription.matchLanguageName(languages, "Tiki wiki")?.name).toBe("Tiki wiki");
    expect(LanguageDescription.matchLanguageName(languages, "Verilog")?.name).toBe("Verilog");
  });

  it("loads JavaScript as a tree-sitter language support", async () => {
    let desc = languages.find((lang) => lang.name == "JavaScript")!;
    let support = await desc.load();
    let state = EditorState.create({
      doc: "function f() {\n  return 1\n}\n",
      extensions: [support.extension],
    });

    let tree = ensureSyntaxTree(state, state.doc.length);
    expect(tree?.topNode.name).toBe("program");
    expect(support.language.name).toBe("javascript");
  });

  it("uses tree-sitter grammar highlight queries from language data", async () => {
    let desc = languages.find((lang) => lang.name == "JavaScript")!;
    let support = await desc.load();
    let doc = "function demo() {\n  console.log(1);\n}\n";
    let state = EditorState.create({ doc, extensions: [support.extension] });
    let highlighter = tagHighlighter([{ tag: tags.function(tags.variableName), class: "fn" }]);
    let spans = __testHighlightTree(syntaxTree(state), [highlighter]);
    let classAt = (text: string) =>
      spans.find(
        (span) => span.from == doc.indexOf(text) && span.to == doc.indexOf(text) + text.length,
      )?.class;

    expect(classAt("demo")).toContain("fn");
  });

  it("uses published grammar highlight queries beyond JavaScript", async () => {
    let desc = languages.find((lang) => lang.name == "CSS")!;
    let support = await desc.load();
    let doc = ".title { color: red; }\n";
    let state = EditorState.create({ doc, extensions: [support.extension] });
    let highlighter = tagHighlighter([{ tag: tags.propertyName, class: "property" }]);
    let spans = __testHighlightTree(syntaxTree(state), [highlighter]);

    expect(spans).toContainEqual({
      from: doc.indexOf("title"),
      to: doc.indexOf("title") + "title".length,
      class: "property",
    });
  });

  it("loads all tree-sitter-backed language-data entries", async () => {
    for (let { name, doc, top } of [
      { name: "Shell", doc: "echo hello\n", top: "program" },
      { name: "APL", doc: "1 2 3\n", top: "source_file" },
      {
        name: "ASN.1",
        doc: "Example DEFINITIONS ::= BEGIN\nValue ::= INTEGER\nEND\n",
        top: "source_file",
      },
      {
        name: "Asterisk",
        doc: "; inbound calls\n[default]\nexten => 100,1,NoOp(hello)\nsame => n,Dial(PJSIP/alice)\ninclude => internal\n",
        top: "source_file",
      },
      { name: "C", doc: "int main(void) { return 0; }\n", top: "translation_unit" },
      {
        name: "C++",
        doc: "#include <vector>\nint main() { return 0; }\n",
        top: "translation_unit",
      },
      {
        name: "C#",
        doc: "class Program { static void Main() { } }\n",
        top: "compilation_unit",
      },
      { name: "Brainfuck", doc: "++[>++<-].\n", top: "source_file" },
      { name: "Clojure", doc: "(defn value [] 1)\n", top: "program" },
      { name: "ClojureScript", doc: "(defn value [] 1)\n", top: "program" },
      {
        name: "CMake",
        doc: "cmake_minimum_required(VERSION 3.20)\nproject(App)\n",
        top: "source_file",
      },
      {
        name: "Cobol",
        doc: "IDENTIFICATION DIVISION.\nPROGRAM-ID. HELLO.\nPROCEDURE DIVISION.\nDISPLAY 'HELLO'.\nSTOP RUN.\n",
        top: "source_file",
      },
      { name: "CoffeeScript", doc: "square = -> 4\n", top: "source_file" },
      { name: "Common Lisp", doc: "(defun value () 1)\n", top: "source" },
      { name: "CQL", doc: "select value from table_name;\n", top: "program" },
      { name: "CSS", doc: ".title { color: red; }\n", top: "stylesheet" },
      {
        name: "Closure Stylesheets (GSS)",
        doc: ".title { color: red; }\n",
        top: "stylesheet",
      },
      { name: "Crystal", doc: 'puts "hi"\n', top: "expressions" },
      { name: "Cypher", doc: "MATCH (n) RETURN n\n", top: "source_file" },
      { name: "Cython", doc: "def f(int x):\n    return x + 1\n", top: "module" },
      { name: "D", doc: 'void main() { writeln("hi"); }\n', top: "source_file" },
      { name: "Dart", doc: 'void main() {\n  print("hi");\n}\n', top: "program" },
      {
        name: "diff",
        doc: "--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n",
        top: "source",
      },
      { name: "Dockerfile", doc: "FROM node:22\nRUN echo hello\n", top: "source_file" },
      {
        name: "DTD",
        doc: '<!-- note document -->\n<!ELEMENT note (to,from,body)>\n<!ATTLIST note id ID #REQUIRED>\n<!ENTITY writer "Ada">\n%inline;\n',
        top: "source_file",
      },
      {
        name: "Dylan",
        doc: "define function square (x)\n  x * x\nend function;\n",
        top: "source_file",
      },
      {
        name: "ECL",
        doc: "EXPORT People := DATASET([{1,'Ada'}], {INTEGER id, STRING name});\nOUTPUT(People);\n",
        top: "source_file",
      },
      { name: "EBNF", doc: 'grammar = { rule } ;\nrule = "a" | "b" ;\n', top: "syntax" },
      {
        name: "Eiffel",
        doc: "class HELLO\nfeature\n    value: INTEGER\n        do\n            Result := 1\n        end\nend\n",
        top: "source_file",
      },
      { name: "Go", doc: 'package main\nfunc main() { println("hi") }\n', top: "source_file" },
      { name: "Groovy", doc: 'def value = "hi"\nprintln(value)\n', top: "program" },
      { name: "Elixir", doc: "defmodule Example do\n  def value, do: 1\nend\n", top: "source" },
      { name: "edn", doc: '{:name "value"}\n', top: "program" },
      { name: "Elm", doc: 'module Main exposing (main)\nmain = text "hi"\n', top: "file" },
      {
        name: "Erlang",
        doc: "-module(demo).\n-export([hello/0]).\nhello() -> ok.\n",
        top: "source_file",
      },
      { name: "Esper", doc: "select value from Event;\n", top: "program" },
      { name: "F#", doc: 'let value = 1\nprintfn "%d" value\n', top: "file" },
      {
        name: "FCL",
        doc: "FUNCTION_BLOCK tipper\nVAR_INPUT\n  service : REAL;\nEND_VAR\nEND_FUNCTION_BLOCK\n",
        top: "source_file",
      },
      {
        name: "Factor",
        doc: "USING: kernel math ;\nIN: demo\n: square ( x -- y ) dup * ;\n",
        top: "source_file",
      },
      {
        name: "Fortran",
        doc: 'program hello\n  print *, "hi"\nend program hello\n',
        top: "translation_unit",
      },
      { name: "Forth", doc: ": square dup * ;\n5 square .\n", top: "source_file" },
      {
        name: "Gas",
        doc: ".globl _start\n_start:\n  mov $1, %eax\n",
        top: "source_file",
      },
      {
        name: "Gherkin",
        doc: "Feature: Demo\n  Scenario: Parse\n    Given a tree-sitter grammar\n",
        top: "document",
      },
      { name: "Haskell", doc: 'main = putStrLn "hi"\n', top: "haskell" },
      {
        name: "Haxe",
        doc: 'class Main { static function main() { trace("hi"); } }\n',
        top: "module",
      },
      { name: "HTML", doc: "<main><p>text</p></main>\n", top: "document" },
      {
        name: "HTTP",
        doc: "GET http://example.com/users\nAccept: application/json\n\n",
        top: "document",
      },
      { name: "HXML", doc: "common.hxml\n--main Main\n--js app.js\n", top: "hxml" },
      {
        name: "IDL",
        doc: "; comment\npro demo, value\n  result = value + 1\nend\n",
        top: "source_file",
      },
      { name: "Java", doc: "class Main { int value() { return 1; } }\n", top: "program" },
      { name: "JavaScript", doc: "let value = 1;\n", top: "program" },
      { name: "Jinja", doc: "{% for item in items %}{{ item }}{% endfor %}\n", top: "source_file" },
      { name: "JSON", doc: '{"name": "value"}\n', top: "document" },
      { name: "JSON-LD", doc: '{"@context": "https://schema.org"}\n', top: "document" },
      { name: "JSX", doc: "let view = <main>{value}</main>;\n", top: "program" },
      { name: "Julia", doc: 'value = "hi"\nprintln(value)\n', top: "source_file" },
      {
        name: "sTeX",
        doc: "\\documentclass{article}\n\\begin{document}\nHello \\textbf{world}.\n\\end{document}\n",
        top: "source_file",
      },
      {
        name: "LaTeX",
        doc: "\\documentclass{article}\n\\begin{document}\nHello \\textbf{world}.\n\\end{document}\n",
        top: "source_file",
      },
      {
        name: "Kotlin",
        doc: "fun main() {\n  val value = 1\n  println(value)\n}\n",
        top: "source_file",
      },
      {
        name: "LESS",
        doc: "@color: red;\n.title { color: @color; }\n",
        top: "stylesheet",
      },
      {
        name: "Liquid",
        doc: '{% assign name = "world" %}\nHello {{ name }}\n',
        top: "program",
      },
      {
        name: "LiveScript",
        doc: "square = (x) -> x * x\nconsole.log square 4\n",
        top: "source_file",
      },
      { name: "Lua", doc: "local value = 1\nprint(value)\n", top: "chunk" },
      { name: "MariaDB SQL", doc: "select value from table_name;\n", top: "program" },
      { name: "Markdown", doc: "# Title\n\nText with *emphasis*.\n", top: "document" },
      { name: "MS SQL", doc: "select value from table_name;\n", top: "program" },
      { name: "MySQL", doc: "select value from table_name;\n", top: "program" },
      {
        name: "Mbox",
        doc: "From alice@example.com Sat Jan 01 00:00:00 2024\nSubject: Tree-sitter\nFrom: Alice <alice@example.com>\n\nBody line\n",
        top: "mailbox",
      },
      {
        name: "mIRC",
        doc: "; greet users\non *:TEXT:!hello:#:{ msg # Hello $nick }\nalias hi { echo -a Hello }\n",
        top: "source_file",
      },
      {
        name: "Mathematica",
        doc: "square[x_] := x^2\nPlot[square[x], {x, 0, 10}]\n",
        top: "source_file",
      },
      { name: "Modelica", doc: "model Hello\n  Real x;\nend Hello;\n", top: "StoredDefinition" },
      { name: "MscGen", doc: 'msc { a,b; a=>b [label="hi"]; }\n', top: "sequence_chart" },
      { name: "MsGenny", doc: 'a,b;\na => b [label="hello"];\n', top: "source_file" },
      { name: "Xù", doc: 'xu { a,b; a=>b [label="hi"]; }\n', top: "sequence_chart" },
      {
        name: "MUMPS",
        doc: 'HELLO ; comment\n WRITE "tree-sitter"\n QUIT\n',
        top: "program",
      },
      { name: "Nginx", doc: "events {}\nhttp { server { listen 80; } }\n", top: "source_file" },
      { name: "NSIS", doc: 'Name "Demo"\nSection "Main"\nSectionEnd\n', top: "source_file" },
      {
        name: "NTriples",
        doc: '<http://example.com/s> <http://example.com/p> "o" .\n',
        top: "turtle_doc",
      },
      {
        name: "Objective-C",
        doc: "#import <Foundation/Foundation.h>\nint main() { return 0; }\n",
        top: "translation_unit",
      },
      {
        name: "Objective-C++",
        doc: "#import <Foundation/Foundation.h>\nint main() { return 0; }\n",
        top: "translation_unit",
      },
      { name: "OCaml", doc: "let value = 1\n", top: "compilation_unit" },
      {
        name: "Octave",
        doc: "% comment\nfunction y = square(x)\n  y = x ^ 2;\nendfunction\n",
        top: "source_file",
      },
      { name: "Oz", doc: "% comment\ndeclare\nfun {Square X}\n  X * X\nend\n", top: "source_file" },
      {
        name: "Pascal",
        doc: "program Hello;\nbegin\n  writeln('hi');\nend.\n",
        top: "root",
      },
      {
        name: "PGP",
        doc: "-----BEGIN PGP MESSAGE-----\nVersion: Demo\n\nyDgBAAAAAAACA6wAAAAAAAAAAAAAAAA=\n=ABCD\n-----END PGP MESSAGE-----\n",
        top: "document",
      },
      { name: "Perl", doc: "my $value = 1;\nprint $value;\n", top: "source_file" },
      { name: "PHP", doc: "<?php echo $value;\n", top: "program" },
      {
        name: "Pig",
        doc: "records = LOAD 'input' USING PigStorage(',');\nfiltered = FILTER records BY score > 10;\nDUMP filtered;\n",
        top: "source_file",
      },
      { name: "PLSQL", doc: "select value from table_name;\n", top: "program" },
      {
        name: "ProtoBuf",
        doc: 'syntax = "proto3";\nmessage User { string name = 1; }\n',
        top: "source_file",
      },
      { name: "Pug", doc: "main\n  h1 Hello\n", top: "source_file" },
      { name: "Puppet", doc: 'class demo {\n  notify { "hello": }\n}\n', top: "source_file" },
      { name: "PostgreSQL", doc: "select value from table_name;\n", top: "program" },
      { name: "PowerShell", doc: "$value = 1\nWrite-Output $value\n", top: "program" },
      { name: "Properties files", doc: "name=value\n[server]\nport=8080\n", top: "document" },
      { name: "Python", doc: "value = 1\nprint(value)\n", top: "module" },
      {
        name: "Q",
        doc: "/ q comment\ntrade:([] sym:`AAPL`MSFT; price:150 310)\nselect avg price by sym from trade\n",
        top: "source_file",
      },
      { name: "R", doc: "value <- mean(c(1, 2, 3))\nprint(value)\n", top: "program" },
      { name: "Regex", doc: "^[a-z]+$\n", top: "pattern" },
      {
        name: "RPM Changes",
        doc: "* Tue May 21 2024 Ada <ada@example.com> - 1.0-1\n- Initial package\n- Rebuild for tree-sitter\n",
        top: "source_file",
      },
      {
        name: "RPM Spec",
        doc: "Name: demo\nVersion: 1.0\n%description\nDemo package\n%files\n/usr/bin/demo\n%changelog\n* Tue May 21 2024 Ada <ada@example.com> - 1.0-1\n- Initial package\n",
        top: "source_file",
      },
      { name: "Ruby", doc: "value = 1\nputs value\n", top: "program" },
      { name: "Rust", doc: 'fn main() { println!("hi"); }\n', top: "source_file" },
      {
        name: "SAS",
        doc: "data work.test;\n  x = 1;\nrun;\n",
        top: "program",
      },
      { name: "Sass", doc: "$primary: red\n.title\n  color: $primary\n", top: "stylesheet" },
      { name: "Scala", doc: "object Main { def value = 1 }\n", top: "compilation_unit" },
      { name: "Scheme", doc: "(define value 1)\n", top: "source_file" },
      { name: "Smalltalk", doc: "hello [ ^ 'hello' ]\n", top: "method" },
      {
        name: "SML",
        doc: "fun square x = x * x\nval y = square 3\n",
        top: "source_file",
      },
      {
        name: "Solr",
        doc: 'title:"tree sitter" AND date:[2024-01-01 TO 2024-12-31]\n',
        top: "source_file",
      },
      { name: "SCSS", doc: "$primary: red;\n.title { color: $primary; }\n", top: "stylesheet" },
      {
        name: "Sieve",
        doc: 'require ["fileinto"];\nif header :contains "Subject" "tree-sitter" {\n  fileinto "INBOX";\n}\n',
        top: "source_file",
      },
      { name: "SPARQL", doc: "SELECT ?s WHERE { ?s ?p ?o . }\n", top: "unit" },
      { name: "SQL", doc: "select value from table_name;\n", top: "program" },
      { name: "SQLite", doc: "select value from table_name;\n", top: "program" },
      { name: "Squirrel", doc: "function main() { local value = 1; }\n", top: "script" },
      {
        name: "Spreadsheet",
        doc: '=SUM(A1:B2) + IF(C1>10, "yes", "no")\n',
        top: "source_file",
      },
      { name: "TOML", doc: 'name = "value"\n[server]\nport = 8080\n', top: "document" },
      {
        name: "Turtle",
        doc: '@prefix ex: <http://example.com/> .\nex:s ex:p "o" .\n',
        top: "turtle_doc",
      },
      { name: "Swift", doc: 'let message = "hi"\nprint(message)\n', top: "source_file" },
      {
        name: "SystemVerilog",
        doc: "module demo(input logic clk);\n  always_ff @(posedge clk) begin\n  end\nendmodule\n",
        top: "source_file",
      },
      {
        name: "Stylus",
        doc: "$primary = #268bd2\n.button\n  color $primary\n  padding 8px\n",
        top: "source_file",
      },
      {
        name: "TiddlyWiki",
        doc: "! Heading\nThis is [[WikiText]].\n* item\n<<macro value>>\n",
        top: "source_file",
      },
      {
        name: "Tiki wiki",
        doc: "! Heading\nThis is ((WikiText)).\n* item\n{CODE()}value{CODE}\n",
        top: "source_file",
      },
      { name: "Tcl", doc: 'proc greet {name} { puts "Hello $name" }\n', top: "source_file" },
      {
        name: "Textile",
        doc: "h1. Heading\n\nParagraph with *strong* text.\n",
        top: "section",
      },
      { name: "TSX", doc: "let view = <main>{value}</main>;\n", top: "program" },
      {
        name: "TTCN",
        doc: "module Demo {\n  testcase tc_demo() runs on MTC {\n    setverdict(pass);\n  }\n}\n",
        top: "source_file",
      },
      { name: "Troff", doc: ".TH DEMO 1\n.SH NAME\ndemo \\\\- tree-sitter\n", top: "source_file" },
      {
        name: "TTCN_CFG",
        doc: '[LOGGING]\nLogFile := "demo.log"\n[MODULE_PARAMETERS]\nDemo.value := 1\n',
        top: "source_file",
      },
      { name: "TypeScript", doc: "type Point = { x: number }\n", top: "program" },
      { name: "WebAssembly", doc: "(module (func (result i32) i32.const 1))\n", top: "ROOT" },
      {
        name: "VB.NET",
        doc: "Module Program\n  Sub Main()\n    Dim value As Integer = 1\n  End Sub\nEnd Module\n",
        top: "source_file",
      },
      { name: "VBScript", doc: 'If value = 1 Then\n  MsgBox "hi"\nEnd If\n', top: "source_file" },
      {
        name: "Velocity",
        doc: '## greeting\n#set($name = "Ada")\nHello $name\n#foreach($item in $items)\n$item\n#end\n',
        top: "source_file",
      },
      {
        name: "Verilog",
        doc: "module demo(input clk);\n  assign out = clk;\nendmodule\n",
        top: "source_file",
      },
      {
        name: "VHDL",
        doc: "entity demo is\nend entity;\narchitecture rtl of demo is\nbegin\nend architecture;\n",
        top: "design_file",
      },
      {
        name: "Web IDL",
        doc: "interface Example {\n  attribute DOMString name;\n};\n",
        top: "source_file",
      },
      { name: "XML", doc: '<root><child name="value" /></root>\n', top: "document" },
      { name: "XQuery", doc: 'for $x in doc("a")//item return $x/title\n', top: "module" },
      { name: "YAML", doc: "name: value\nlist:\n  - one\n", top: "stream" },
      { name: "Yacas", doc: "Square(x) := x^2;\nD(x) <-- Deriv(x);\n", top: "source_file" },
      { name: "Z80", doc: "start:\n  ld a, 1\n  jp nz, start\n", top: "program" },
      { name: "Vue", doc: "<template><main>{{ value }}</main></template>\n", top: "document" },
      { name: "ERB", doc: "<%= value %>\n", top: "template" },
      {
        name: "Angular Template",
        doc: '<button (click)="save(item)">{{ item.name | uppercase }}</button>\n',
        top: "document",
      },
    ]) {
      let support = await languages.find((lang) => lang.name == name)!.load();
      let state = EditorState.create({ doc, extensions: [support.extension] });

      expect(ensureSyntaxTree(state, state.doc.length)?.topNode.name).toBe(top);
      expect(support.language.name).toBe(name.toLowerCase());
    }
  }, 20_000);

  it("parses HTML script and style blocks with nested tree-sitter grammars", async () => {
    let support = await languages.find((lang) => lang.name == "HTML")!.load();
    let doc = "<main><style>body { color: red }</style><script>let value = 1;</script></main>";
    let state = EditorState.create({ doc, extensions: [support.extension] });
    let tree = syntaxTree(state);

    expect(tree.resolveInner(doc.indexOf("color")).name).toBe("property_name");
    expect(tree.resolveInner(doc.indexOf("value")).name).toBe("identifier");
    expect(
      state.languageDataAt<{ line?: string; block?: { open: string; close: string } }>(
        "commentTokens",
        doc.indexOf("value"),
      ),
    ).toEqual([{ line: "//", block: { open: "/*", close: "*/" } }]);
    expect(
      state.languageDataAt<{ block?: { open: string; close: string } }>(
        "commentTokens",
        doc.indexOf("main"),
      )[0]?.block,
    ).toEqual({ open: "<!--", close: "-->" });
  });

  it("reparses an HTML script group when one included range is deleted", async () => {
    let support = await languages.find((lang) => lang.name == "HTML")!.load();
    let doc =
      "<script>let keep=1;</script>\n" + "<div>x</div>\n" + "<script>let gone=2;</script>\n";
    let state = EditorState.create({ doc, extensions: [support.extension] });
    expect(ensureSyntaxTree(state, state.doc.length, 5_000)).not.toBeNull();

    let removeFrom = doc.lastIndexOf("<script>");
    let transaction = state.update({ changes: { from: removeFrom, to: doc.length } });
    let tree = ensureSyntaxTree(transaction.state, transaction.state.doc.length, 5_000);
    let scriptTree = tree?.nested.find((nested) => nested.tree.topNode.name == "program")?.tree;

    expect(scriptTree).toBeDefined();
    expect(scriptTree!.tree!.rootNode.toString().match(/lexical_declaration/g)).toHaveLength(1);
  });

  it("marks HTML tag nodes as bidi isolates", async () => {
    let support = await languages.find((lang) => lang.name == "HTML")!.load();
    let doc = 'النص <span class="blue">الأزرق</span>\n';
    let state = EditorState.create({ doc, extensions: [support.extension] });
    let tree = syntaxTree(state);
    let isolated: string[] = [];

    tree.iterate({
      enter(node) {
        if (node.type.prop(NodeProp.isolate)) isolated.push(node.name);
      },
    });

    expect(isolated).toContain("start_tag");
    expect(isolated).toContain("end_tag");
  });

  it("parses Vue script and style blocks with nested tree-sitter grammars", async () => {
    let support = await languages.find((lang) => lang.name == "Vue")!.load();
    let doc = [
      "<template><h1>{{ message }}</h1></template>",
      "<script setup>const message = 'hello';</script>",
      "<style>.title { color: red }</style>",
    ].join("\n");
    let state = EditorState.create({ doc, extensions: [support.extension] });
    let tree = syntaxTree(state);

    expect(tree.topNode.name).toBe("document");
    expect(tree.resolveInner(doc.indexOf("message =")).name).toBe("identifier");
    expect(tree.resolveInner(doc.indexOf("color")).name).toBe("property_name");
    expect(
      state.languageDataAt<{ line?: string; block?: { open: string; close: string } }>(
        "commentTokens",
        doc.indexOf("message ="),
      ),
    ).toEqual([{ line: "//", block: { open: "/*", close: "*/" } }]);
  });

  it("parses Angular template syntax with the Angular tree-sitter grammar", async () => {
    let support = await languages.find((lang) => lang.name == "Angular Template")!.load();
    let doc =
      '<button [disabled]="saving" (click)="save(item)">{{ item.name | uppercase }}</button>';
    let state = EditorState.create({ doc, extensions: [support.extension] });
    let tree = syntaxTree(state);

    expect(tree.topNode.name).toBe("document");
    expect(tree.tree!.rootNode.toString()).toContain("event_binding");
    expect(tree.tree!.rootNode.toString()).toContain("property_binding");
    expect(tree.tree!.rootNode.toString()).toContain("interpolation");
    expect(
      state.languageDataAt<{ block?: { open: string; close: string } }>(
        "commentTokens",
        doc.indexOf("save"),
      )[0]?.block,
    ).toEqual({ open: "<!--", close: "-->" });
  });

  it("parses Markdown inline syntax with nested tree-sitter grammars", async () => {
    let support = await languages.find((lang) => lang.name == "Markdown")!.load();
    let doc = "# Title\n\nText with *emphasis* and `code`.\n";
    let state = EditorState.create({ doc, extensions: [support.extension] });
    let tree = ensureSyntaxTree(state, doc.length, 5_000);
    expect(tree).not.toBeNull();
    let highlighter = tagHighlighter([
      { tag: tags.heading, class: "heading" },
      { tag: tags.emphasis, class: "emphasis" },
      { tag: tags.monospace, class: "monospace" },
    ]);
    let spans = __testHighlightTree(tree!, [highlighter]);

    expect(tree!.topNode.name).toBe("document");
    expect(tree!.resolveInner(doc.indexOf("emphasis")).name).toBe("emphasis");
    expect(tree!.resolveInner(doc.indexOf("code")).name).toBe("code_span");
    expect(
      spans.some(
        (span) =>
          span.from <= doc.indexOf("Title") &&
          span.to >= doc.indexOf("Title") + "Title".length &&
          span.class.includes("heading"),
      ),
    ).toBe(true);
    expect(
      spans.some(
        (span) =>
          span.from <= doc.indexOf("*emphasis*") &&
          span.to >= doc.indexOf("*emphasis*") + "*emphasis*".length &&
          span.class.includes("emphasis"),
      ),
    ).toBe(true);
    expect(
      spans.some(
        (span) =>
          span.from <= doc.indexOf("`code`") &&
          span.to >= doc.indexOf("`code`") + "`code`".length &&
          span.class.includes("monospace"),
      ),
    ).toBe(true);
  });

  it("parses whole-paragraph Markdown delimiter spans independently", async () => {
    let support = await languages.find((lang) => lang.name == "Markdown")!.load();
    let target = "The editor keeps Markdown as the source while the page reads like composed text.";
    let delimiters = [
      { source: `_${target}_`, node: "emphasis" },
      { source: `*${target}*`, node: "emphasis" },
      { source: `__${target}__`, node: "strong_emphasis" },
      { source: `**${target}**`, node: "strong_emphasis" },
      { source: `~~${target}~~`, node: "strikethrough" },
    ];
    let followers = ["\n\nNext paragraph\n", "\n\n> Next quote\n", "\n\n- Next list item\n"];

    for (let delimiter of delimiters) {
      for (let follower of followers) {
        let doc = delimiter.source + follower;
        let state = EditorState.create({ doc, extensions: [support.extension] });
        let tree = ensureSyntaxTree(state, doc.length, 5_000);
        expect(tree).not.toBeNull();
        let node = tree!.resolveInner(doc.indexOf(target));

        expect(
          ancestorNames(node),
          `${delimiter.source.slice(0, 2)}… followed by ${JSON.stringify(follower)}`,
        ).toContain(delimiter.node);
      }
    }
  });

  it("parses Markdown delimiter spans inside pipe table cells", async () => {
    let support = await languages.find((lang) => lang.name == "Markdown")!.load();
    let target = "cell text";
    let doc = `| _${target}_ | next |\n| --- | --- |\n| value | next |\n`;
    let state = EditorState.create({ doc, extensions: [support.extension] });
    let tree = ensureSyntaxTree(state, doc.length, 5_000);
    expect(tree).not.toBeNull();
    let node = tree!.resolveInner(doc.indexOf(target));

    expect(ancestorNames(node)).toContain("emphasis");
  });

  it("builds Markdown inline injections without the allocating Tree.iterate helper", async () => {
    let support = await languages.find((lang) => lang.name == "Markdown")!.load();
    let doc =
      "Text with *emphasis* and `code`.\n\n" + "| _cell text_ | next |\n" + "| --- | --- |\n";
    let iterateDescriptor = Object.getOwnPropertyDescriptor(Tree.prototype, "iterate")!;
    Object.defineProperty(Tree.prototype, "iterate", {
      configurable: true,
      value: () => {
        throw new Error("Markdown injections should use the cursor range producer");
      },
    });

    try {
      let state = EditorState.create({ doc, extensions: [support.extension] });
      let tree = ensureSyntaxTree(state, doc.length, 5_000);
      expect(tree).not.toBeNull();

      expect(ancestorNames(tree!.resolveInner(doc.indexOf("emphasis")))).toContain("emphasis");
      expect(ancestorNames(tree!.resolveInner(doc.indexOf("cell text")))).toContain("emphasis");
    } finally {
      Object.defineProperty(Tree.prototype, "iterate", iterateDescriptor);
    }
  });

  it("exposes block-only Markdown parser service without changing generic Markdown nesting", async () => {
    let service = await loadMarkdownParserService();
    let generic = await languages.find((lang) => lang.name == "Markdown")!.load();

    expect(service.blockLanguage.language.allowsNesting).toBe(false);
    expect(service.blockParser.nestedParsers).toHaveLength(0);
    expect(service.inlineParser.nestedParsers).toHaveLength(0);
    expect(generic.language.allowsNesting).toBe(true);

    let doc =
      "Text with *emphasis*.\n\n" +
      "- list **bold**\n\n" +
      "> quote `code`\n\n" +
      "| _cell text_ | next |\n" +
      "| --- | --- |\n";
    let text = Text.of(doc.split("\n"));
    let blockTree = service.blockParser.parse(text);

    expect(blockTree.nested).toHaveLength(0);
    expect(service.inlineRanges(blockTree, { from: 0, to: doc.indexOf("\n\n") })).toHaveLength(1);
    expect(
      service.inlineRanges(blockTree, {
        from: doc.indexOf("list"),
        to: doc.indexOf("list **bold**") + "list **bold**".length,
      }),
    ).toEqual([[{ from: doc.indexOf("list"), to: doc.indexOf("\n\n", doc.indexOf("list")) }]]);
    expect(
      service.inlineRanges(blockTree, {
        from: doc.indexOf("quote"),
        to: doc.indexOf("quote `code`") + "quote `code`".length,
      }),
    ).toEqual([[{ from: doc.indexOf("quote"), to: doc.indexOf("\n\n", doc.indexOf("quote")) }]]);

    let parser = service.inlineParser.createParser();
    let inlineTrees: Tree[] = [];
    try {
      inlineTrees = service.inlineRanges(blockTree).map((ranges) => {
        let parsed = service.inlineParser.parseWith(parser, text, null, undefined, ranges);
        expect(parsed).toBeTruthy();
        return service.inlineParser.wrapTree(parsed!, text)!;
      });

      expect(inlineTrees.length).toBeGreaterThanOrEqual(2);
      expect(
        inlineTrees.some((tree) => hasAncestorNamed(tree, doc.indexOf("emphasis"), "emphasis")),
      ).toBe(true);
      expect(
        inlineTrees.some((tree) => hasAncestorNamed(tree, doc.indexOf("cell text"), "emphasis")),
      ).toBe(true);
    } finally {
      for (let tree of inlineTrees) tree.tree?.delete();
      parser.delete();
    }
  });

  it("parses Markdown closing code fences at EOF", async () => {
    let support = await languages.find((lang) => lang.name == "Markdown")!.load();
    let doc = "```ts\nconst x = 1;\n```";
    let state = EditorState.create({ doc, extensions: [support.extension] });
    let delimiters = queryTreeCaptures(syntaxTree(state), codeFenceDelimiterQuerySource, {
      includeNested: false,
    }).length;

    expect(delimiters).toBe(2);
  });

  it("reuses unchanged tree-sitter nodes after document changes", async () => {
    let support = await languages.find((lang) => lang.name == "JavaScript")!.load();
    let state = EditorState.create({
      doc: "let a = 1;\nlet b = 2;\n",
      extensions: [support.extension],
    });
    let before = syntaxTree(state).tree!.rootNode.namedChild(0)!;

    let tr = state.update({
      changes: { from: state.doc.toString().indexOf("2"), to: state.doc.length - 2, insert: "3" },
    });
    let after = syntaxTree(tr.state).tree!.rootNode.namedChild(0)!;

    expect(after.id).toBe(before.id);
    expect(syntaxTree(tr.state).tree!.rootNode.toString()).toContain("(number)");
  });

  it("keeps syntax node offsets in CodeMirror document coordinates", async () => {
    let support = await languages.find((lang) => lang.name == "JavaScript")!.load();
    let source = 'let 😀 = "𝌆";\n';
    let state = EditorState.create({ doc: source, extensions: [support.extension] });
    let tree = syntaxTree(state);
    let identifier = tree.resolveInner(source.indexOf("😀"));
    let stringFragment = tree.resolveInner(source.indexOf("𝌆"));
    let string = stringFragment.parent!;

    expect(identifier.name).toBe("identifier");
    expect(identifier.from).toBe(source.indexOf("😀"));
    expect(identifier.to).toBe(source.indexOf("😀") + "😀".length);
    expect(stringFragment.name).toBe("string_fragment");
    expect(string.name).toBe("string");
    expect(state.sliceDoc(string.from, string.to)).toBe('"𝌆"');
  });

  it("edits old trees correctly across multiple changed ranges", async () => {
    let support = await languages.find((lang) => lang.name == "JavaScript")!.load();
    let parser = support.language.parser;
    let state = EditorState.create({
      doc: "let a = 1;\nlet b = 2;\nlet c = 3;\n",
      extensions: [support.extension],
    });
    let oldTree = syntaxTree(state).tree!;
    let tr = state.update({
      changes: [
        {
          from: state.doc.toString().indexOf("1"),
          to: state.doc.toString().indexOf("1") + 1,
          insert: "10",
        },
        {
          from: state.doc.toString().indexOf("3"),
          to: state.doc.toString().indexOf("3") + 1,
          insert: "30",
        },
      ],
    });

    let editedOldTree = parser.editTree(oldTree, tr.changes, state.doc, tr.state.doc);
    let newTree = syntaxTree(tr.state).tree!;
    let changed = editedOldTree.getChangedRanges(newTree);

    expect(tr.state.doc.toString()).toBe("let a = 10;\nlet b = 2;\nlet c = 30;\n");
    expect(newTree.rootNode.toString()).toContain("(number)");
    expect(changed.some((range) => range.startIndex <= tr.state.doc.toString().indexOf("b"))).toBe(
      false,
    );
  });

  it("honors parse timeouts and resumes tree-sitter parsing", async () => {
    let support = await languages.find((lang) => lang.name == "JavaScript")!.load();
    let state = EditorState.create({
      doc: "let start = 0;\n",
      extensions: [support.extension],
    });
    let largeProgram = `${"let value = 1;\n".repeat(150_000)}let end = 2;\n`;
    state = state.update({
      changes: { from: 0, to: state.doc.length, insert: largeProgram },
    }).state;

    expect(ensureSyntaxTree(state, state.doc.length, 0)).toBe(null);
    expect(syntaxTreeAvailable(state)).toBe(false);

    let tree = ensureSyntaxTree(state, state.doc.length, 5_000);
    expect(tree?.topNode.name).toBe("program");
    expect(tree?.length).toBe(state.doc.length);
    expect(syntaxTreeAvailable(state)).toBe(true);
  });

  it("uses sublanguage props to vary language data by syntax node", async () => {
    let support = await languages.find((lang) => lang.name == "JavaScript")!.load();
    let stringData = defineLanguageFacet();
    let language = (support.language as TreeSitterLanguage).configure({
      props: [
        sublanguageProp.add((type) =>
          type.isTop
            ? [
                {
                  type: "replace",
                  facet: stringData,
                  test: (node) => node.name == "string" || node.parent?.name == "string",
                },
              ]
            : undefined,
        ),
      ],
    });
    let state = EditorState.create({
      doc: 'let value = "x";',
      extensions: [language.extension, stringData.of({ mode: "string" })],
    });

    expect(state.languageDataAt("mode", state.doc.toString().indexOf("x"))).toEqual(["string"]);
    expect(state.languageDataAt("mode", state.doc.toString().indexOf("value"))).toEqual([]);
  });
});
