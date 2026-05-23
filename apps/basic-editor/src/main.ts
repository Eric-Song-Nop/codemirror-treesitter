import "./style.css";
import { Compartment, EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTreeAvailable } from "@codemirror-treesitter/language";
import { languages } from "@codemirror-treesitter/language-data";
import { EditorView, basicSetup } from "@codemirror-treesitter/basic-setup";

const samples: Record<string, string> = {
  TypeScript: `type Point = { x: number; y: number };

function distance(a: Point, b: Point) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

console.log(distance({ x: 0, y: 0 }, { x: 4, y: 3 }));
`,
  HTML: `<main>
  <h1>Tree-sitter mixed parsing</h1>
  <style>
    main { display: grid; gap: 1rem; }
    h1 { color: rebeccapurple; }
  </style>
  <script>
    const message = "nested JavaScript";
    console.log(message.toUpperCase());
  </script>
</main>
`,
  Python: `from dataclasses import dataclass

@dataclass
class Point:
    x: float
    y: float

def distance(a: Point, b: Point) -> float:
    return ((a.x - b.x) ** 2 + (a.y - b.y) ** 2) ** 0.5
`,
  JSON: `{
  "name": "codemirror-treesitter",
  "parser": "tree-sitter",
  "incremental": true,
  "languages": ["TypeScript", "HTML", "Python", "JSON", "APL", "ASN.1", "Asterisk", "Brainfuck", "Closure Stylesheets (GSS)", "CMake", "Cobol", "CoffeeScript", "Crystal", "Cython", "diff", "Dockerfile", "DTD", "Dylan", "ECL", "EBNF", "Eiffel", "Erlang", "Esper", "FCL", "Factor", "Forth", "Fortran", "Gas", "Gherkin", "HTTP", "HXML", "IDL", "LaTeX", "LESS", "Liquid", "LiveScript", "Mathematica", "Mbox", "mIRC", "Modelica", "MscGen", "MsGenny", "MUMPS", "NSIS", "Octave", "Oz", "Pascal", "PGP", "Pig", "ProtoBuf", "Puppet", "Q", "R", "RPM Changes", "RPM Spec", "SAS", "Sass", "Sieve", "Smalltalk", "SML", "Solr", "Spreadsheet", "sTeX", "SystemVerilog", "Stylus", "TiddlyWiki", "Tiki wiki", "Tcl", "Textile", "Troff", "TTCN", "TTCN_CFG", "VB.NET", "VBScript", "Velocity", "Verilog", "VHDL", "Web IDL", "SPARQL", "Turtle", "XQuery", "Xù", "Yacas", "Z80", "Squirrel"]
}
`,
  APL: `⍝ Vector values
1 2 3
`,
  "ASN.1": `Example DEFINITIONS ::= BEGIN
Value ::= INTEGER
END
`,
  Asterisk: `; inbound calls
[default]
exten => 100,1,NoOp(hello)
same => n,Dial(PJSIP/alice)
include => internal
`,
  Brainfuck: `++[>++<-]>.
`,
  "Closure Stylesheets (GSS)": `.title {
  color: red;
}
`,
  CMake: `cmake_minimum_required(VERSION 3.20)
project(TreeSitterDemo)
add_executable(app main.cpp)
`,
  Cobol: `IDENTIFICATION DIVISION.
PROGRAM-ID. HELLO.
PROCEDURE DIVISION.
DISPLAY 'HELLO'.
STOP RUN.
`,
  CoffeeScript: `square = -> 4
console.log square()
`,
  Clojure: `(defn distance [a b]
  (let [dx (- (:x a) (:x b))
        dy (- (:y a) (:y b))]
    (Math/sqrt (+ (* dx dx) (* dy dy)))))
`,
  Crystal: `def greet(name : String)
  puts "Hello #{name}"
end
`,
  Cypher: `MATCH (person:Person)-[:KNOWS]->(friend)
WHERE person.name = "Ada"
RETURN friend.name
`,
  Cython: `def add(int left, int right):
    return left + right
`,
  D: `import std.stdio;

void main() {
  writeln("tree-sitter");
}
`,
  diff: `--- a/message.txt
+++ b/message.txt
@@ -1 +1 @@
-old parser
+tree-sitter parser
`,
  Dockerfile: `FROM node:22
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
`,
  DTD: `<!-- note document -->
<!ELEMENT note (to,from,body)>
<!ATTLIST note id ID #REQUIRED>
<!ENTITY writer "Ada">
%inline;
`,
  Dylan: `define function square (x)
  x * x
end function;
`,
  ECL: `EXPORT People := DATASET([{1,'Ada'}], {INTEGER id, STRING name});
OUTPUT(People);
`,
  EBNF: `grammar = { rule } ;
rule = "a" | "b" ;
`,
  Eiffel: `class HELLO
feature
    value: INTEGER
        do
            Result := 1
        end
end
`,
  Elm: `module Main exposing (main)

main =
    text "tree-sitter"
`,
  Erlang: `-module(demo).
-export([hello/0]).
hello() -> ok.
`,
  Esper: `select value from Event;
`,
  "F#": `let value = 1
printfn "%d" value
`,
  FCL: `FUNCTION_BLOCK tipper
VAR_INPUT
  service : REAL;
END_VAR
END_FUNCTION_BLOCK
`,
  Factor: `USING: kernel math ;
IN: demo
: square ( x -- y ) dup * ;
`,
  Forth: `: square dup * ;
5 square .
`,
  Fortran: `program hello
  print *, "tree-sitter"
end program hello
`,
  Gas: `.globl _start
_start:
  mov $1, %eax
`,
  Gherkin: `Feature: Parser workbench
  Scenario: Load a grammar
    Given a tree-sitter language
    Then the syntax tree is ready
`,
  Groovy: `def values = [1, 2, 3]
println(values.collect { it * 2 })
`,
  Haxe: `class Main {
  static function main() {
    trace("tree-sitter");
  }
}
`,
  HTTP: `GET http://example.com/users
Accept: application/json

`,
  HXML: `common.hxml
--main Main
--js app.js
`,
  IDL: `; comment
pro demo, value
  result = value + 1
end
`,
  Julia: `function distance(a, b)
  dx = a[1] - b[1]
  dy = a[2] - b[2]
  sqrt(dx^2 + dy^2)
end
`,
  LaTeX: String.raw`\documentclass{article}
\begin{document}
Hello \textbf{world}.
\end{document}
`,
  LESS: `@primary: steelblue;
.title {
  color: @primary;
}
`,
  Liquid: `{% assign name = "tree-sitter" %}
Hello {{ name }}
`,
  LiveScript: `square = (x) -> x * x
console.log square 4
`,
  Mathematica: `square[x_] := x^2
Plot[square[x], {x, 0, 10}]
`,
  Mbox: `From alice@example.com Sat Jan 01 00:00:00 2024
Subject: Tree-sitter
From: Alice <alice@example.com>

Body line
`,
  mIRC: `; greet users
on *:TEXT:!hello:#:{ msg # Hello $nick }
alias hi { echo -a Hello }
`,
  "Common Lisp": `(defun distance (a b)
  (let ((dx (- (getf a :x) (getf b :x)))
        (dy (- (getf a :y) (getf b :y))))
    (sqrt (+ (* dx dx) (* dy dy)))))
`,
  Nginx: `events {}

http {
  server {
    listen 8080;
    location / {
      proxy_pass http://127.0.0.1:3000;
    }
  }
}
`,
  NTriples: `<http://example.com/s> <http://example.com/p> "object" .
`,
  Octave: `% comment
function y = square(x)
  y = x ^ 2;
endfunction
`,
  Oz: `% comment
declare
fun {Square X}
  X * X
end
`,
  Modelica: `model Hello
  Real x;
end Hello;
`,
  MscGen: `msc { a,b; a=>b [label="hi"]; }
`,
  MsGenny: `a,b;
a => b [label="hello"];
`,
  MUMPS: `HELLO ; comment
 WRITE "tree-sitter"
 QUIT
`,
  NSIS: `Name "TreeSitterDemo"
Section "Main"
SectionEnd
`,
  Pascal: `program Hello;
begin
  writeln('tree-sitter');
end.
`,
  PGP: `-----BEGIN PGP MESSAGE-----
Version: Demo

yDgBAAAAAAACA6wAAAAAAAAAAAAAAAA=
=ABCD
-----END PGP MESSAGE-----
`,
  Perl: `my $value = 1;
print $value;
`,
  Pig: `records = LOAD 'input' USING PigStorage(',');
filtered = FILTER records BY score > 10;
DUMP filtered;
`,
  ProtoBuf: `syntax = "proto3";
package demo;

message User {
  string name = 1;
}
`,
  Pug: `main
  h1 Tree-sitter
  p Mixed language workbench
`,
  Puppet: `class demo {
  notify { "tree-sitter": }
}
`,
  Q: `/ q comment
trade:([] sym:\`AAPL\`MSFT; price:150 310)
select avg price by sym from trade
`,
  R: `value <- mean(c(1, 2, 3))
print(value)
`,
  "RPM Changes": `* Tue May 21 2024 Ada <ada@example.com> - 1.0-1
- Initial package
- Rebuild for tree-sitter
`,
  "RPM Spec": `Name: demo
Version: 1.0
%description
Demo package
%files
/usr/bin/demo
%changelog
* Tue May 21 2024 Ada <ada@example.com> - 1.0-1
- Initial package
`,
  SAS: `data work.test;
  x = 1;
run;
`,
  Sass: `$primary: steelblue
.title
  color: $primary
`,
  Sieve: `require ["fileinto"];
if header :contains "Subject" "tree-sitter" {
  fileinto "INBOX";
}
`,
  Scheme: `(define (distance a b)
  (let ((dx (- (car a) (car b)))
        (dy (- (cadr a) (cadr b))))
    (sqrt (+ (* dx dx) (* dy dy)))))
`,
  Smalltalk: `hello [ ^ 'tree-sitter' ]
`,
  SML: `fun square x = x * x
val y = square 3
`,
  Solr: `title:"tree sitter" AND date:[2024-01-01 TO 2024-12-31]
`,
  Spreadsheet: `=SUM(A1:B2) + IF(C1>10, "yes", "no")
`,
  sTeX: String.raw`\documentclass{article}
\begin{document}
Hello \emph{world}.
\end{document}
`,
  SystemVerilog: `module demo(input logic clk);
  always_ff @(posedge clk) begin
  end
endmodule
`,
  Stylus: `$primary = #268bd2
.button
  color $primary
  padding 8px
`,
  TiddlyWiki: `! Heading
This is [[WikiText]].
* item
<<macro value>>
`,
  "Tiki wiki": `! Heading
This is ((WikiText)).
* item
{CODE()}value{CODE}
`,
  Squirrel: `function main() {
  local value = 1;
  return value;
}
`,
  SPARQL: `PREFIX ex: <http://example.com/>

SELECT ?name WHERE {
  ?person ex:name ?name .
}
`,
  Tcl: `proc greet {name} {
  puts "Hello $name"
}
`,
  Textile: `h1. Tree-sitter

Paragraph with *strong* text.
`,
  TTCN: `module Demo {
  testcase tc_demo() runs on MTC {
    setverdict(pass);
  }
}
`,
  Troff: `.TH DEMO 1
.SH NAME
demo \\- tree-sitter
`,
  TTCN_CFG: `[LOGGING]
LogFile := "demo.log"
[MODULE_PARAMETERS]
Demo.value := 1
`,
  Turtle: `@prefix ex: <http://example.com/> .

ex:person ex:name "Ada" .
`,
  "VB.NET": `Module Program
  Sub Main()
    Dim value As Integer = 1
  End Sub
End Module
`,
  VBScript: `If value = 1 Then
  MsgBox "tree-sitter"
End If
`,
  Velocity: `## greeting
#set($name = "Ada")
Hello $name
#foreach($item in $items)
$item
#end
`,
  Verilog: `module demo(input clk);
  assign out = clk;
endmodule
`,
  VHDL: `entity demo is
end entity;

architecture rtl of demo is
begin
end architecture;
`,
  WebAssembly: `(module
  (func (export "value") (result i32)
    i32.const 1))
`,
  "Web IDL": `interface Example {
  attribute DOMString name;
};
`,
  XQuery: `for $item in doc("catalog.xml")//item
return $item/title
`,
  Xù: `xu { a,b; a=>b [label="hi"]; }
`,
  Yacas: `Square(x) := x^2;
D(x) <-- Deriv(x);
`,
  Z80: `start:
  ld a, 1
  jp nz, start
`,
};

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
<main class="shell">
  <header class="topbar">
    <div>
      <p class="eyebrow">CodeMirror tree-sitter</p>
      <h1>Basic editor</h1>
    </div>
    <label class="picker">
      <span>Language</span>
      <select id="language"></select>
    </label>
  </header>
  <section class="workspace" aria-label="Editor workspace">
    <div id="editor"></div>
    <aside class="panel" aria-live="polite">
      <dl>
        <div>
          <dt>Grammar</dt>
          <dd id="grammar">Loading</dd>
        </div>
        <div>
          <dt>Syntax tree</dt>
          <dd id="tree-status">Pending</dd>
        </div>
        <div>
          <dt>Document</dt>
          <dd id="doc-status">0 lines</dd>
        </div>
      </dl>
    </aside>
  </section>
</main>
`;

const select = document.querySelector<HTMLSelectElement>("#language")!;
const editorParent = document.querySelector<HTMLDivElement>("#editor")!;
const grammarStatus = document.querySelector<HTMLElement>("#grammar")!;
const treeStatus = document.querySelector<HTMLElement>("#tree-status")!;
const docStatus = document.querySelector<HTMLElement>("#doc-status")!;
const languageCompartment = new Compartment();
const sampleNames = Object.keys(samples);

for (let name of sampleNames) {
  let option = document.createElement("option");
  option.value = name;
  option.textContent = name;
  select.append(option);
}

const editor = new EditorView({
  parent: editorParent,
  state: EditorState.create({
    doc: samples.TypeScript,
    extensions: [
      basicSetup,
      EditorView.lineWrapping,
      languageCompartment.of([]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) updateDocumentStatus(update.state);
        updateTreeStatus(update.state);
      }),
    ],
  }),
});

select.value = "TypeScript";
void setLanguage(select.value).catch(showLanguageError);
select.addEventListener("change", () => {
  let nextDoc = samples[select.value];
  void setLanguage(select.value, nextDoc).catch(showLanguageError);
});

async function setLanguage(name: string, nextDoc?: string) {
  let description = languages.find((language) => language.name == name);
  if (!description) throw new RangeError(`Unknown language: ${name}`);

  grammarStatus.textContent = "Loading";
  treeStatus.textContent = "Pending";
  let support = await description.load();
  editor.dispatch({
    changes:
      nextDoc == null ? undefined : { from: 0, to: editor.state.doc.length, insert: nextDoc },
    effects: languageCompartment.reconfigure(support.extension),
  });
  grammarStatus.textContent = description.name;
  updateDocumentStatus(editor.state);
  updateTreeStatus(editor.state);
}

function updateDocumentStatus(state: EditorState) {
  let lines = state.doc.lines;
  docStatus.textContent = `${lines} ${lines == 1 ? "line" : "lines"}`;
}

function updateTreeStatus(state: EditorState) {
  ensureSyntaxTree(state, state.doc.length, 25);
  treeStatus.textContent = syntaxTreeAvailable(state) ? "Ready" : "Parsing";
}

function showLanguageError(error: unknown) {
  console.error(error);
  grammarStatus.textContent = "Failed";
  treeStatus.textContent = error instanceof Error ? error.message : "Unavailable";
}
