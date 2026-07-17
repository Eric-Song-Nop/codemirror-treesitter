import {
  LanguageDescription,
  LanguageSupport,
  NodeProp,
  TreeSitterLanguage,
  TreeSitterParser,
  continuedIndent,
  delimitedIndent,
  foldInside,
  foldNodeProp,
  indentNodeProp,
  queryTreeCaptures,
  tags,
  type DocRange,
  type NestedParserSource,
  type NodePropSource,
  type Tag,
  type Tree,
  type TreeSitterQueryCapture,
} from "@codemirror-treesitter/language";
import {
  collectMarkdownInlineRangeGroups,
  iterateMarkdownInlineRangeGroups,
} from "./markdown-inline-ranges.js";
import rawTextQuerySource from "./queries/raw-text.scm?raw";

type AssetLoader = () => Promise<string>;
type AssetModule = { default: string };
type NodeRequire = { resolve: (specifier: string) => string };

export type MarkdownParserService = {
  blockLanguage: LanguageSupport;
  blockParser: TreeSitterParser;
  inlineParser: TreeSitterParser;
  inlineRanges: (tree: Tree, within?: DocRange) => DocRange[][];
};

const packageUrlAsset =
  (specifier: string, load: () => Promise<AssetModule>): AssetLoader =>
  async () =>
    isBrowserLike() ? (await load()).default : resolveNodeAsset(specifier);

const packageRawAsset =
  (specifier: string, load: () => Promise<AssetModule>): AssetLoader =>
  async () =>
    isBrowserLike() ? (await load()).default : readNodeAsset(specifier);

const localAsset =
  (url: URL): AssetLoader =>
  async () => {
    if (url.protocol == "file:") return url.pathname;
    if (!isBrowserLike()) return viteFsPath(url) ?? url.href;
    return url.href;
  };

let nodeRequire: NodeRequire | null = null;

async function resolveNodeAsset(specifier: string) {
  if (!nodeRequire) {
    let { createRequire } = (await import(/* @vite-ignore */ nodeModuleSpecifier)) as {
      createRequire: (filename: string | URL) => NodeRequire;
    };
    nodeRequire = createRequire(import.meta.url);
  }
  return nodeRequire.resolve(specifier);
}

async function readNodeAsset(specifier: string) {
  let { readFile } = (await import(/* @vite-ignore */ nodeFsSpecifier)) as {
    readFile: (path: string, encoding: "utf8") => Promise<string>;
  };
  return readFile(await resolveNodeAsset(specifier), "utf8");
}

function isBrowserLike() {
  return (
    typeof globalThis.location == "object" &&
    typeof (globalThis as typeof globalThis & { document?: unknown }).document == "object"
  );
}

function viteFsPath(url: URL) {
  if (url.pathname.startsWith("/@fs/")) return decodeURIComponent(url.pathname.slice(4));
  let cwd = (
    globalThis as typeof globalThis & { process?: { cwd?: () => string } }
  ).process?.cwd?.();
  if (cwd && isViteLocalhost(url) && url.pathname.startsWith("/")) {
    return `${cwd}${decodeURIComponent(url.pathname)}`;
  }
  return null;
}

function isViteLocalhost(url: URL) {
  return (
    (url.protocol == "http:" || url.protocol == "https:") &&
    (url.hostname == "localhost" || url.hostname == "127.0.0.1" || url.hostname == "[::1]")
  );
}

const nodeModuleSpecifier = "node:module";
const nodeFsSpecifier = "node:fs/promises";

const dartWasm = packageUrlAsset(
  "@repomix/tree-sitter-wasms/out/tree-sitter-dart.wasm",
  () => import("@repomix/tree-sitter-wasms/out/tree-sitter-dart.wasm?url"),
);
const swiftWasm = packageUrlAsset(
  "@repomix/tree-sitter-wasms/out/tree-sitter-swift.wasm",
  () => import("@repomix/tree-sitter-wasms/out/tree-sitter-swift.wasm?url"),
);
const vueWasm = packageUrlAsset(
  "@repomix/tree-sitter-wasms/out/tree-sitter-vue.wasm",
  () => import("@repomix/tree-sitter-wasms/out/tree-sitter-vue.wasm?url"),
);
const kotlinWasm = packageUrlAsset(
  "@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm",
  () => import("@tree-sitter-grammars/tree-sitter-kotlin/tree-sitter-kotlin.wasm?url"),
);
const lessWasm = localAsset(new URL("./wasm/tree-sitter-less.wasm", import.meta.url));
const liquidWasm = localAsset(new URL("./wasm/tree-sitter-liquid.wasm", import.meta.url));
const luaWasm = packageUrlAsset(
  "@tree-sitter-grammars/tree-sitter-lua/tree-sitter-lua.wasm",
  () => import("@tree-sitter-grammars/tree-sitter-lua/tree-sitter-lua.wasm?url"),
);
const luaHighlights = packageRawAsset(
  "@tree-sitter-grammars/tree-sitter-lua/queries/highlights.scm",
  () => import("@tree-sitter-grammars/tree-sitter-lua/queries/highlights.scm?raw"),
);
const tomlWasm = packageUrlAsset(
  "@tree-sitter-grammars/tree-sitter-toml/tree-sitter-toml.wasm",
  () => import("@tree-sitter-grammars/tree-sitter-toml/tree-sitter-toml.wasm?url"),
);
const tomlHighlights = packageRawAsset(
  "@tree-sitter-grammars/tree-sitter-toml/queries/highlights.scm",
  () => import("@tree-sitter-grammars/tree-sitter-toml/queries/highlights.scm?raw"),
);
const yamlWasm = packageUrlAsset(
  "@tree-sitter-grammars/tree-sitter-yaml/tree-sitter-yaml.wasm",
  () => import("@tree-sitter-grammars/tree-sitter-yaml/tree-sitter-yaml.wasm?url"),
);
const yamlHighlights = packageRawAsset(
  "@tree-sitter-grammars/tree-sitter-yaml/queries/highlights.scm",
  () => import("@tree-sitter-grammars/tree-sitter-yaml/queries/highlights.scm?raw"),
);
const iniWasm = packageUrlAsset(
  "@vscode/tree-sitter-wasm/wasm/tree-sitter-ini.wasm",
  () => import("@vscode/tree-sitter-wasm/wasm/tree-sitter-ini.wasm?url"),
);
const powershellWasm = packageUrlAsset(
  "@vscode/tree-sitter-wasm/wasm/tree-sitter-powershell.wasm",
  () => import("@vscode/tree-sitter-wasm/wasm/tree-sitter-powershell.wasm?url"),
);
const aplWasm = localAsset(new URL("./wasm/tree-sitter-apl.wasm", import.meta.url));
const asn1Wasm = localAsset(new URL("./wasm/tree-sitter-asn1.wasm", import.meta.url));
const asteriskWasm = localAsset(new URL("./wasm/tree-sitter-asterisk.wasm", import.meta.url));
const asmWasm = localAsset(new URL("./wasm/tree-sitter-asm.wasm", import.meta.url));
const bashWasm = packageUrlAsset(
  "tree-sitter-bash/tree-sitter-bash.wasm",
  () => import("tree-sitter-bash/tree-sitter-bash.wasm?url"),
);
const bashHighlights = packageRawAsset(
  "tree-sitter-bash/queries/highlights.scm",
  () => import("tree-sitter-bash/queries/highlights.scm?raw"),
);
const brainfuckWasm = localAsset(new URL("./wasm/tree-sitter-brainfuck.wasm", import.meta.url));
const cWasm = packageUrlAsset(
  "tree-sitter-c/tree-sitter-c.wasm",
  () => import("tree-sitter-c/tree-sitter-c.wasm?url"),
);
const cHighlights = packageRawAsset(
  "tree-sitter-c/queries/highlights.scm",
  () => import("tree-sitter-c/queries/highlights.scm?raw"),
);
const cSharpWasm = packageUrlAsset(
  "tree-sitter-c-sharp/tree-sitter-c_sharp.wasm",
  () => import("tree-sitter-c-sharp/tree-sitter-c_sharp.wasm?url"),
);
const cSharpHighlights = packageRawAsset(
  "tree-sitter-c-sharp/queries/highlights.scm",
  () => import("tree-sitter-c-sharp/queries/highlights.scm?raw"),
);
const cmakeWasm = localAsset(new URL("./wasm/tree-sitter-cmake.wasm", import.meta.url));
const cobolWasm = localAsset(new URL("./wasm/tree-sitter-cobol.wasm", import.meta.url));
const coffeescriptWasm = localAsset(
  new URL("./wasm/tree-sitter-coffeescript.wasm", import.meta.url),
);
const commonLispWasm = localAsset(new URL("./wasm/tree-sitter-commonlisp.wasm", import.meta.url));
const cppWasm = packageUrlAsset(
  "tree-sitter-cpp/tree-sitter-cpp.wasm",
  () => import("tree-sitter-cpp/tree-sitter-cpp.wasm?url"),
);
const cppHighlights = packageRawAsset(
  "tree-sitter-cpp/queries/highlights.scm",
  () => import("tree-sitter-cpp/queries/highlights.scm?raw"),
);
const crystalWasm = localAsset(new URL("./wasm/tree-sitter-crystal.wasm", import.meta.url));
const cssWasm = packageUrlAsset(
  "tree-sitter-css/tree-sitter-css.wasm",
  () => import("tree-sitter-css/tree-sitter-css.wasm?url"),
);
const cssHighlights = packageRawAsset(
  "tree-sitter-css/queries/highlights.scm",
  () => import("tree-sitter-css/queries/highlights.scm?raw"),
);
const clojureWasm = localAsset(new URL("./wasm/tree-sitter-clojure.wasm", import.meta.url));
const cypherWasm = localAsset(new URL("./wasm/tree-sitter-cypher.wasm", import.meta.url));
const cypherHighlights = packageRawAsset(
  "tree-sitter-cypher/queries/highlights.scm",
  () => import("tree-sitter-cypher/queries/highlights.scm?raw"),
);
const cythonWasm = localAsset(new URL("./wasm/tree-sitter-cython.wasm", import.meta.url));
const dWasm = localAsset(new URL("./wasm/tree-sitter-d.wasm", import.meta.url));
const dHighlights = packageRawAsset(
  "tree-sitter-d/queries/highlights.scm",
  () => import("tree-sitter-d/queries/highlights.scm?raw"),
);
const diffWasm = localAsset(new URL("./wasm/tree-sitter-diff.wasm", import.meta.url));
const dockerfileWasm = localAsset(new URL("./wasm/tree-sitter-dockerfile.wasm", import.meta.url));
const dtdWasm = localAsset(new URL("./wasm/tree-sitter-dtd.wasm", import.meta.url));
const dylanWasm = localAsset(new URL("./wasm/tree-sitter-dylan.wasm", import.meta.url));
const eclWasm = localAsset(new URL("./wasm/tree-sitter-ecl.wasm", import.meta.url));
const ebnfWasm = localAsset(new URL("./wasm/tree-sitter-ebnf.wasm", import.meta.url));
const eiffelWasm = localAsset(new URL("./wasm/tree-sitter-eiffel.wasm", import.meta.url));
const elixirWasm = packageUrlAsset(
  "tree-sitter-elixir/tree-sitter-elixir.wasm",
  () => import("tree-sitter-elixir/tree-sitter-elixir.wasm?url"),
);
const elixirHighlights = packageRawAsset(
  "tree-sitter-elixir/queries/highlights.scm",
  () => import("tree-sitter-elixir/queries/highlights.scm?raw"),
);
const elmWasm = localAsset(new URL("./wasm/tree-sitter-elm.wasm", import.meta.url));
const elmHighlights = packageRawAsset(
  "@elm-tooling/tree-sitter-elm/queries/highlights.scm",
  () => import("@elm-tooling/tree-sitter-elm/queries/highlights.scm?raw"),
);
const embeddedTemplateWasm = packageUrlAsset(
  "tree-sitter-embedded-template/tree-sitter-embedded_template.wasm",
  () => import("tree-sitter-embedded-template/tree-sitter-embedded_template.wasm?url"),
);
const embeddedTemplateHighlights = packageRawAsset(
  "tree-sitter-embedded-template/queries/highlights.scm",
  () => import("tree-sitter-embedded-template/queries/highlights.scm?raw"),
);
const erlangWasm = localAsset(new URL("./wasm/tree-sitter-erlang.wasm", import.meta.url));
const factorWasm = localAsset(new URL("./wasm/tree-sitter-factor.wasm", import.meta.url));
const fclWasm = localAsset(new URL("./wasm/tree-sitter-fcl.wasm", import.meta.url));
const forthWasm = localAsset(new URL("./wasm/tree-sitter-forth.wasm", import.meta.url));
const fortranWasm = localAsset(new URL("./wasm/tree-sitter-fortran.wasm", import.meta.url));
const fsharpWasm = packageUrlAsset(
  "tree-sitter-fsharp/tree-sitter-fsharp.wasm",
  () => import("tree-sitter-fsharp/tree-sitter-fsharp.wasm?url"),
);
const fsharpHighlights = packageRawAsset(
  "tree-sitter-fsharp/queries/highlights.scm",
  () => import("tree-sitter-fsharp/queries/highlights.scm?raw"),
);
const gasWasm = localAsset(new URL("./wasm/tree-sitter-gas.wasm", import.meta.url));
const gherkinWasm = localAsset(new URL("./wasm/tree-sitter-gherkin.wasm", import.meta.url));
const goWasm = packageUrlAsset(
  "tree-sitter-go/tree-sitter-go.wasm",
  () => import("tree-sitter-go/tree-sitter-go.wasm?url"),
);
const goHighlights = packageRawAsset(
  "tree-sitter-go/queries/highlights.scm",
  () => import("tree-sitter-go/queries/highlights.scm?raw"),
);
const groovyWasm = localAsset(new URL("./wasm/tree-sitter-groovy.wasm", import.meta.url));
const haxeWasm = localAsset(new URL("./wasm/tree-sitter-haxe.wasm", import.meta.url));
const haskellWasm = packageUrlAsset(
  "tree-sitter-haskell/tree-sitter-haskell.wasm",
  () => import("tree-sitter-haskell/tree-sitter-haskell.wasm?url"),
);
const haskellHighlights = packageRawAsset(
  "tree-sitter-haskell/queries/highlights.scm",
  () => import("tree-sitter-haskell/queries/highlights.scm?raw"),
);
const htmlWasm = packageUrlAsset(
  "tree-sitter-html/tree-sitter-html.wasm",
  () => import("tree-sitter-html/tree-sitter-html.wasm?url"),
);
const htmlHighlights = packageRawAsset(
  "tree-sitter-html/queries/highlights.scm",
  () => import("tree-sitter-html/queries/highlights.scm?raw"),
);
const httpWasm = localAsset(new URL("./wasm/tree-sitter-http.wasm", import.meta.url));
const hxmlWasm = localAsset(new URL("./wasm/tree-sitter-hxml.wasm", import.meta.url));
const idlWasm = localAsset(new URL("./wasm/tree-sitter-idl.wasm", import.meta.url));
const javaWasm = packageUrlAsset(
  "tree-sitter-java/tree-sitter-java.wasm",
  () => import("tree-sitter-java/tree-sitter-java.wasm?url"),
);
const javaHighlights = packageRawAsset(
  "tree-sitter-java/queries/highlights.scm",
  () => import("tree-sitter-java/queries/highlights.scm?raw"),
);
const javascriptHighlights = packageRawAsset(
  "tree-sitter-javascript/queries/highlights.scm",
  () => import("tree-sitter-javascript/queries/highlights.scm?raw"),
);
const javascriptWasm = packageUrlAsset(
  "tree-sitter-javascript/tree-sitter-javascript.wasm",
  () => import("tree-sitter-javascript/tree-sitter-javascript.wasm?url"),
);
const jinjaWasm = packageUrlAsset(
  "tree-sitter-jinja-dialects/tree-sitter-jinja.wasm",
  () => import("tree-sitter-jinja-dialects/tree-sitter-jinja.wasm?url"),
);
const jinjaHighlights = packageRawAsset(
  "tree-sitter-jinja-dialects/queries/highlights.scm",
  () => import("tree-sitter-jinja-dialects/queries/highlights.scm?raw"),
);
const jsonWasm = packageUrlAsset(
  "tree-sitter-json/tree-sitter-json.wasm",
  () => import("tree-sitter-json/tree-sitter-json.wasm?url"),
);
const jsonHighlights = packageRawAsset(
  "tree-sitter-json/queries/highlights.scm",
  () => import("tree-sitter-json/queries/highlights.scm?raw"),
);
const juliaWasm = localAsset(new URL("./wasm/tree-sitter-julia.wasm", import.meta.url));
const juliaHighlights = packageRawAsset(
  "tree-sitter-julia/queries/highlights.scm",
  () => import("tree-sitter-julia/queries/highlights.scm?raw"),
);
const latexWasm = localAsset(new URL("./wasm/tree-sitter-latex.wasm", import.meta.url));
const livescriptWasm = localAsset(new URL("./wasm/tree-sitter-livescript.wasm", import.meta.url));
const markdownWasm = localAsset(new URL("./wasm/tree-sitter-markdown.wasm", import.meta.url));
const markdownHighlights = packageRawAsset(
  "@tree-sitter-grammars/tree-sitter-markdown/tree-sitter-markdown/queries/highlights.scm",
  () =>
    import("@tree-sitter-grammars/tree-sitter-markdown/tree-sitter-markdown/queries/highlights.scm?raw"),
);
const markdownInlineWasm = localAsset(
  new URL("./wasm/tree-sitter-markdown-inline.wasm", import.meta.url),
);
const markdownInlineHighlights = packageRawAsset(
  "@tree-sitter-grammars/tree-sitter-markdown/tree-sitter-markdown-inline/queries/highlights.scm",
  () =>
    import("@tree-sitter-grammars/tree-sitter-markdown/tree-sitter-markdown-inline/queries/highlights.scm?raw"),
);
const mathematicaWasm = localAsset(new URL("./wasm/tree-sitter-wolfram.wasm", import.meta.url));
const mboxWasm = localAsset(new URL("./wasm/tree-sitter-mbox.wasm", import.meta.url));
const mircWasm = localAsset(new URL("./wasm/tree-sitter-mirc.wasm", import.meta.url));
const modelicaWasm = localAsset(new URL("./wasm/tree-sitter-modelica.wasm", import.meta.url));
const msgennyWasm = localAsset(new URL("./wasm/tree-sitter-msgenny.wasm", import.meta.url));
const mscgenWasm = localAsset(new URL("./wasm/tree-sitter-mscgen.wasm", import.meta.url));
const mumpsWasm = localAsset(new URL("./wasm/tree-sitter-mumps.wasm", import.meta.url));
const nginxWasm = localAsset(new URL("./wasm/tree-sitter-nginx.wasm", import.meta.url));
const nginxHighlights = packageRawAsset(
  "tree-sitter-nginx/queries/highlights.scm",
  () => import("tree-sitter-nginx/queries/highlights.scm?raw"),
);
const nsisWasm = localAsset(new URL("./wasm/tree-sitter-nsis.wasm", import.meta.url));
const objectiveCWasm = packageUrlAsset(
  "tree-sitter-objc/tree-sitter-objc.wasm",
  () => import("tree-sitter-objc/tree-sitter-objc.wasm?url"),
);
const objectiveCHighlights = packageRawAsset(
  "tree-sitter-objc/queries/highlights.scm",
  () => import("tree-sitter-objc/queries/highlights.scm?raw"),
);
const ocamlWasm = packageUrlAsset(
  "tree-sitter-ocaml/tree-sitter-ocaml.wasm",
  () => import("tree-sitter-ocaml/tree-sitter-ocaml.wasm?url"),
);
const ocamlHighlights = packageRawAsset(
  "tree-sitter-ocaml/queries/highlights.scm",
  () => import("tree-sitter-ocaml/queries/highlights.scm?raw"),
);
const octaveWasm = localAsset(new URL("./wasm/tree-sitter-octave.wasm", import.meta.url));
const ozWasm = localAsset(new URL("./wasm/tree-sitter-oz.wasm", import.meta.url));
const pascalWasm = localAsset(new URL("./wasm/tree-sitter-pascal.wasm", import.meta.url));
const pascalHighlights = packageRawAsset(
  "tree-sitter-pascal/queries/highlights.scm",
  () => import("tree-sitter-pascal/queries/highlights.scm?raw"),
);
const pgpWasm = localAsset(new URL("./wasm/tree-sitter-pgp.wasm", import.meta.url));
const perlWasm = localAsset(new URL("./wasm/tree-sitter-perl.wasm", import.meta.url));
const perlHighlights = packageRawAsset(
  "tree-sitter-perl/queries/highlights.scm",
  () => import("tree-sitter-perl/queries/highlights.scm?raw"),
);
const phpWasm = packageUrlAsset(
  "tree-sitter-php/tree-sitter-php.wasm",
  () => import("tree-sitter-php/tree-sitter-php.wasm?url"),
);
const phpHighlights = packageRawAsset(
  "tree-sitter-php/queries/highlights.scm",
  () => import("tree-sitter-php/queries/highlights.scm?raw"),
);
const pigWasm = localAsset(new URL("./wasm/tree-sitter-pig.wasm", import.meta.url));
const protoWasm = localAsset(new URL("./wasm/tree-sitter-proto.wasm", import.meta.url));
const pugWasm = localAsset(new URL("./wasm/tree-sitter-pug.wasm", import.meta.url));
const pugHighlights = packageRawAsset(
  "tree-sitter-pug/queries/highlights.scm",
  () => import("tree-sitter-pug/queries/highlights.scm?raw"),
);
const puppetWasm = localAsset(new URL("./wasm/tree-sitter-puppet.wasm", import.meta.url));
const pythonWasm = packageUrlAsset(
  "tree-sitter-python/tree-sitter-python.wasm",
  () => import("tree-sitter-python/tree-sitter-python.wasm?url"),
);
const pythonHighlights = packageRawAsset(
  "tree-sitter-python/queries/highlights.scm",
  () => import("tree-sitter-python/queries/highlights.scm?raw"),
);
const qWasm = localAsset(new URL("./wasm/tree-sitter-q.wasm", import.meta.url));
const rWasm = localAsset(new URL("./wasm/tree-sitter-r.wasm", import.meta.url));
const regexWasm = packageUrlAsset(
  "tree-sitter-regex/tree-sitter-regex.wasm",
  () => import("tree-sitter-regex/tree-sitter-regex.wasm?url"),
);
const regexHighlights = packageRawAsset(
  "tree-sitter-regex/queries/highlights.scm",
  () => import("tree-sitter-regex/queries/highlights.scm?raw"),
);
const rpmChangesWasm = localAsset(new URL("./wasm/tree-sitter-rpm_changes.wasm", import.meta.url));
const rpmSpecWasm = localAsset(new URL("./wasm/tree-sitter-rpm_spec.wasm", import.meta.url));
const rubyWasm = packageUrlAsset(
  "tree-sitter-ruby/tree-sitter-ruby.wasm",
  () => import("tree-sitter-ruby/tree-sitter-ruby.wasm?url"),
);
const rubyHighlights = packageRawAsset(
  "tree-sitter-ruby/queries/highlights.scm",
  () => import("tree-sitter-ruby/queries/highlights.scm?raw"),
);
const rustWasm = packageUrlAsset(
  "tree-sitter-rust/tree-sitter-rust.wasm",
  () => import("tree-sitter-rust/tree-sitter-rust.wasm?url"),
);
const rustHighlights = packageRawAsset(
  "tree-sitter-rust/queries/highlights.scm",
  () => import("tree-sitter-rust/queries/highlights.scm?raw"),
);
const sasWasm = localAsset(new URL("./wasm/tree-sitter-sas.wasm", import.meta.url));
const sassWasm = localAsset(new URL("./wasm/tree-sitter-sass.wasm", import.meta.url));
const scalaWasm = packageUrlAsset(
  "tree-sitter-scala/tree-sitter-scala.wasm",
  () => import("tree-sitter-scala/tree-sitter-scala.wasm?url"),
);
const scalaHighlights = packageRawAsset(
  "tree-sitter-scala/queries/highlights.scm",
  () => import("tree-sitter-scala/queries/highlights.scm?raw"),
);
const schemeWasm = localAsset(new URL("./wasm/tree-sitter-scheme.wasm", import.meta.url));
const scssWasm = localAsset(new URL("./wasm/tree-sitter-scss.wasm", import.meta.url));
const scssHighlights = packageRawAsset(
  "tree-sitter-scss/queries/highlights.scm",
  () => import("tree-sitter-scss/queries/highlights.scm?raw"),
);
const sieveWasm = localAsset(new URL("./wasm/tree-sitter-sieve.wasm", import.meta.url));
const smalltalkWasm = localAsset(new URL("./wasm/tree-sitter-smalltalk.wasm", import.meta.url));
const smlWasm = localAsset(new URL("./wasm/tree-sitter-sml.wasm", import.meta.url));
const solrWasm = localAsset(new URL("./wasm/tree-sitter-solr.wasm", import.meta.url));
const sqlWasm = localAsset(new URL("./wasm/tree-sitter-sql.wasm", import.meta.url));
const sqlHighlights = packageRawAsset(
  "@derekstride/tree-sitter-sql/queries/highlights.scm",
  () => import("@derekstride/tree-sitter-sql/queries/highlights.scm?raw"),
);
const sparqlWasm = localAsset(new URL("./wasm/tree-sitter-sparql.wasm", import.meta.url));
const squirrelWasm = localAsset(new URL("./wasm/tree-sitter-squirrel.wasm", import.meta.url));
const squirrelHighlights = packageRawAsset(
  "tree-sitter-squirrel/queries/highlights.scm",
  () => import("tree-sitter-squirrel/queries/highlights.scm?raw"),
);
const spreadsheetWasm = localAsset(new URL("./wasm/tree-sitter-spreadsheet.wasm", import.meta.url));
const stylusWasm = localAsset(new URL("./wasm/tree-sitter-stylus.wasm", import.meta.url));
const tiddlywikiWasm = localAsset(new URL("./wasm/tree-sitter-tiddlywiki.wasm", import.meta.url));
const tikiWikiWasm = localAsset(new URL("./wasm/tree-sitter-tiki_wiki.wasm", import.meta.url));
const tclWasm = localAsset(new URL("./wasm/tree-sitter-tcl.wasm", import.meta.url));
const textileWasm = localAsset(new URL("./wasm/tree-sitter-textile.wasm", import.meta.url));
const troffWasm = localAsset(new URL("./wasm/tree-sitter-troff.wasm", import.meta.url));
const ttcnCfgWasm = localAsset(new URL("./wasm/tree-sitter-ttcn_cfg.wasm", import.meta.url));
const ttcn3Wasm = localAsset(new URL("./wasm/tree-sitter-ttcn3.wasm", import.meta.url));
const turtleWasm = localAsset(new URL("./wasm/tree-sitter-turtle.wasm", import.meta.url));
const vbnetWasm = localAsset(new URL("./wasm/tree-sitter-vbnet.wasm", import.meta.url));
const vbscriptWasm = localAsset(new URL("./wasm/tree-sitter-vbscript.wasm", import.meta.url));
const velocityWasm = localAsset(new URL("./wasm/tree-sitter-velocity.wasm", import.meta.url));
const verilogWasm = localAsset(new URL("./wasm/tree-sitter-verilog.wasm", import.meta.url));
const vhdlWasm = localAsset(new URL("./wasm/tree-sitter-vhdl.wasm", import.meta.url));
const webIdlWasm = localAsset(new URL("./wasm/tree-sitter-webidl.wasm", import.meta.url));
const xmlWasm = localAsset(new URL("./wasm/tree-sitter-xml.wasm", import.meta.url));
const xmlHighlights = packageRawAsset(
  "@tree-sitter-grammars/tree-sitter-xml/queries/xml/highlights.scm",
  () => import("@tree-sitter-grammars/tree-sitter-xml/queries/xml/highlights.scm?raw"),
);
const xqueryWasm = localAsset(new URL("./wasm/tree-sitter-xquery.wasm", import.meta.url));
const xqueryHighlights = packageRawAsset(
  "tree-sitter-xquery/queries/highlights.scm",
  () => import("tree-sitter-xquery/queries/highlights.scm?raw"),
);
const yacasWasm = localAsset(new URL("./wasm/tree-sitter-yacas.wasm", import.meta.url));
const typescriptHighlights = packageRawAsset(
  "tree-sitter-typescript/queries/highlights.scm",
  () => import("tree-sitter-typescript/queries/highlights.scm?raw"),
);
const tsxWasm = packageUrlAsset(
  "tree-sitter-typescript/tree-sitter-tsx.wasm",
  () => import("tree-sitter-typescript/tree-sitter-tsx.wasm?url"),
);
const typescriptWasm = packageUrlAsset(
  "tree-sitter-typescript/tree-sitter-typescript.wasm",
  () => import("tree-sitter-typescript/tree-sitter-typescript.wasm?url"),
);
const wastWasm = localAsset(new URL("./wasm/tree-sitter-wast.wasm", import.meta.url));

type LanguageSpec = {
  name: string;
  alias?: readonly string[];
  extensions?: readonly string[];
  filename?: RegExp;
  implicitFinalNewline?: boolean;
  wasm: AssetLoader;
  languageData?: { [name: string]: unknown };
  props?: readonly NodePropSource[];
  styleTags?: Record<string, Tag | readonly Tag[]>;
  highlightQuery?: AssetLoader;
  nested?: () => Promise<readonly NestedParserSource[]>;
};

const bracketed = delimitedIndent({ closing: "}" });
const continued = continuedIndent();

const commonProps: readonly NodePropSource[] = [
  indentNodeProp.add({
    array: delimitedIndent({ closing: "]" }),
    array_pattern: delimitedIndent({ closing: "]" }),
    arguments: delimitedIndent({ closing: ")" }),
    formal_parameters: delimitedIndent({ closing: ")" }),
    parameters: delimitedIndent({ closing: ")" }),
    parenthesized_expression: delimitedIndent({ closing: ")" }),
    object: bracketed,
    object_pattern: bracketed,
    statement_block: bracketed,
    class_body: bracketed,
    declaration_list: bracketed,
    compound_statement: bracketed,
    block: bracketed,
    import_statement: continued,
    call_expression: continued,
  }),
  foldNodeProp.add({
    array: foldInside,
    arguments: foldInside,
    formal_parameters: foldInside,
    parameters: foldInside,
    object: foldInside,
    statement_block: foldInside,
    class_body: foldInside,
    declaration_list: foldInside,
    compound_statement: foldInside,
    block: foldInside,
    element: foldInside,
    document: foldInside,
  }),
];

const tagIsolateProps = NodeProp.isolate.add({
  start_tag: "ltr",
  end_tag: "ltr",
  self_closing_tag: "ltr",
});

const commonStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  line_comment: tags.comment,
  block_comment: tags.comment,
  string: tags.string,
  string_fragment: tags.string,
  template_string: tags.string,
  number: [tags.number, tags.literal],
  integer: [tags.number, tags.literal],
  float: [tags.number, tags.literal],
  true: [tags.bool, tags.atom],
  false: [tags.bool, tags.atom],
  null: tags.atom,
  identifier: tags.variableName,
  property_identifier: tags.propertyName,
  field_identifier: tags.propertyName,
  type_identifier: tags.typeName,
  primitive_type: tags.typeName,
  class: tags.keyword,
  function: tags.keyword,
  return: tags.keyword,
  if: tags.keyword,
  else: tags.keyword,
  for: tags.keyword,
  while: tags.keyword,
  import: tags.keyword,
  export: tags.keyword,
  from: tags.keyword,
};

function lineComment(token: string) {
  return {
    commentTokens: { line: token },
    closeBrackets: { brackets: ["(", "[", "{", "'", '"'] },
    indentOnInput: /^\s*[}\])]$/,
  };
}

function blockComment(line = "//", open = "/*", close = "*/") {
  return {
    commentTokens: { line, block: { open, close } },
    closeBrackets: { brackets: ["(", "[", "{", "'", '"'] },
    indentOnInput: /^\s*[}\])]$/,
  };
}

function blockOnlyComment(open: string, close: string) {
  return {
    commentTokens: { block: { open, close } },
    closeBrackets: { brackets: ["(", "[", "{", "'", '"'] },
    indentOnInput: /^\s*[}\])]$/,
  };
}

function noComment() {
  return {
    closeBrackets: { brackets: ["(", "[", "{", "'", '"'] },
    indentOnInput: /^\s*[}\])]$/,
  };
}

const jsonData = {
  closeBrackets: { brackets: ["[", "{", '"'] },
  indentOnInput: /^\s*[}\]]$/,
};

const markdownData = {
  closeBrackets: { brackets: ["(", "[", "{", "'", '"', "`"] },
};

const htmlData = {
  commentTokens: { block: { open: "<!--", close: "-->" } },
  closeBrackets: { brackets: ["<", "'", '"'] },
  indentOnInput: /^\s*<\/[\w-]+>$/,
};

const brainfuckData = {
  closeBrackets: { brackets: ["["] },
  indentOnInput: /^\s*\]$/,
};

const diffData = {
  closeBrackets: { brackets: [] },
};

const coffeeData = {
  commentTokens: { line: "#", block: { open: "###", close: "###" } },
  closeBrackets: { brackets: ["(", "[", "{", "'", '"'] },
  indentOnInput: /^\s*[}\])]$/,
};

const ebnfData = {
  commentTokens: { block: { open: "(*", close: "*)" } },
  closeBrackets: { brackets: ["(", "[", "{", "'", '"'] },
  indentOnInput: /^\s*[}\])]$/,
};

const smalltalkData = {
  commentTokens: { block: { open: '"', close: '"' } },
  closeBrackets: { brackets: ["(", "[", "{", "'"] },
  indentOnInput: /^\s*[\])}]$/,
};

const liquidData = {
  commentTokens: { block: { open: "{% comment %}", close: "{% endcomment %}" } },
  closeBrackets: { brackets: ["(", "[", "{", "'", '"'] },
};

const xqueryData = {
  commentTokens: { block: { open: "(:", close: ":)" } },
  closeBrackets: { brackets: ["(", "[", "{", "'", '"'] },
  indentOnInput: /^\s*[}\])]$/,
};

const stylesheetStyleTags: Record<string, Tag | readonly Tag[]> = {
  tag_name: tags.tagName,
  element_name: tags.tagName,
  class_name: tags.className,
  id_name: tags.labelName,
  property_name: tags.propertyName,
  custom_property_name: tags.definition(tags.propertyName),
  attribute_name: tags.attributeName,
  function_name: tags.function(tags.variableName),
  string_value: tags.string,
  plain_value: tags.atom,
  color_value: tags.color,
  boolean_value: tags.bool,
  null_value: tags.null,
  integer_value: tags.integer,
  float_value: tags.float,
  unit: tags.unit,
  at_keyword: tags.keyword,
  important: tags.modifier,
};

const cythonStyleTags: Record<string, Tag | readonly Tag[]> = {
  decorator: tags.function(tags.variableName),
  attribute: tags.propertyName,
  int_type: tags.typeName,
  c_type: tags.typeName,
  type: tags.typeName,
  none: tags.null,
  true: tags.bool,
  false: tags.bool,
  integer: tags.integer,
  float: tags.float,
};

const fortranStyleTags: Record<string, Tag | readonly Tag[]> = {
  name: tags.variableName,
  module_name: tags.variableName,
  string_literal: tags.string,
  number_literal: tags.number,
  boolean_literal: tags.bool,
  intrinsic_type: tags.typeName,
  type_name: tags.typeName,
  derived_type: tags.typeName,
};

const modelicaStyleTags: Record<string, Tag | readonly Tag[]> = {
  IDENT: tags.variableName,
  STRING: tags.string,
  StringLiteral: tags.string,
  DescriptionString: tags.string,
  UnsignedIntegerLiteral: tags.integer,
  UnsignedRealLiteral: tags.float,
  LogicalLiteral: tags.bool,
  true: tags.bool,
  false: tags.bool,
  ClassDefinition: tags.definitionKeyword,
};

const puppetStyleTags: Record<string, Tag | readonly Tag[]> = {
  class_definition: tags.definitionKeyword,
  function_declaration: tags.definitionKeyword,
  resource_declaration: tags.definitionKeyword,
  class_identifier: tags.typeName,
  builtin_type: tags.typeName,
  attribute: tags.propertyName,
  string_content: tags.string,
};

const liquidStyleTags: Record<string, Tag | readonly Tag[]> = {
  template_content: tags.content,
  comment: tags.comment,
  string: tags.string,
  boolean: tags.bool,
  identifier: tags.variableName,
  assignment_statement: tags.keyword,
  if_statement: tags.controlKeyword,
  for_loop_statement: tags.controlKeyword,
  case_statement: tags.controlKeyword,
};

const forthStyleTags: Record<string, Tag | readonly Tag[]> = {
  line_comment: tags.comment,
  block_comment: tags.comment,
  string: tags.string,
  word_definition: tags.definition(tags.variableName),
  start_definition: tags.definitionKeyword,
  end_definition: tags.definitionKeyword,
  number: tags.number,
  decimal_number: tags.integer,
  hex_number: tags.integer,
  binary_number: tags.integer,
  float_number: tags.float,
  operator: tags.operator,
  builtin: tags.keyword,
  control_flow: tags.controlKeyword,
};

const hxmlStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  file: tags.string,
  directory: tags.string,
  class_path: tags.string,
  library: tags.moduleKeyword,
  main: tags.definitionKeyword,
  target: tags.keyword,
  define: tags.definitionKeyword,
  undefine: tags.definitionKeyword,
  macro: tags.keyword,
  cmd: tags.keyword,
  type_path: tags.typeName,
};

const nsisStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  block_comment: tags.comment,
  string: tags.string,
  raw_string: tags.string,
  backtick_string: tags.string,
  string_content: tags.string,
  number: tags.number,
  command: tags.function(tags.variableName),
  function_definition: tags.definition(tags.variableName),
  macro_definition: tags.definition(tags.variableName),
  section_definition: tags.definitionKeyword,
  section_group: tags.definitionKeyword,
  label: tags.labelName,
  variable_declaration: tags.definition(tags.variableName),
  preproc_directive: tags.meta,
  preproc_keyword: tags.keyword,
  comparison_operator: tags.operator,
};

const pgpStyleTags: Record<string, Tag | readonly Tag[]> = {
  armor_begin: tags.processingInstruction,
  armor_end: tags.processingInstruction,
  header_name: tags.propertyName,
  header_value: tags.string,
  body_line: tags.content,
  checksum: tags.atom,
  text_line: tags.content,
};

const textileStyleTags: Record<string, Tag | readonly Tag[]> = {
  atx_heading: tags.heading,
  atx_h1_marker: tags.heading1,
  atx_h2_marker: tags.heading2,
  atx_h3_marker: tags.heading3,
  atx_h4_marker: tags.heading4,
  atx_h5_marker: tags.heading5,
  atx_h6_marker: tags.heading6,
  code_block: tags.monospace,
  list_marker: tags.punctuation,
};

const vbscriptStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  string_literal: tags.string,
  number: tags.number,
  boolean: tags.bool,
  if_statement: tags.controlKeyword,
  for_statement: tags.controlKeyword,
  while_statement: tags.controlKeyword,
  do_statement: tags.controlKeyword,
  function: tags.definitionKeyword,
  subroutine: tags.definitionKeyword,
  function_call: tags.function(tags.variableName),
  variable_declaration: tags.definition(tags.variableName),
  type: tags.typeName,
  binary_expression: tags.operator,
};

const aplStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  character_vector: tags.string,
  inner_quote: tags.escape,
  number: tags.number,
  zilde: tags.atom,
  system: tags.special(tags.variableName),
  parameter: tags.variableName,
  primitive: tags.function(tags.variableName),
  identifier: tags.variableName,
  colon: tags.punctuation,
  semicolon: tags.punctuation,
};

const asn1StyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  StringValue: tags.string,
  CharacterStringValue: tags.string,
  NumericRealValue: tags.float,
  SignedNumber: tags.number,
  Number: tags.number,
  TRUE: tags.bool,
  FALSE: tags.bool,
  NULL: tags.null,
  Type: tags.typeName,
  BuiltinType: tags.typeName,
  DefinedType: tags.typeName,
  TypeAssignment: tags.definition(tags.typeName),
  ValueAssignment: tags.definition(tags.variableName),
  modulereference: tags.namespace,
  typereference: tags.typeName,
  valuereference: tags.variableName,
};

const asteriskStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  section: tags.heading,
  directive: tags.processingInstruction,
  dialplan: tags.function(tags.variableName),
  assignment: tags.definition(tags.propertyName),
  text_line: tags.content,
};

const dtdStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  declaration: tags.processingInstruction,
  parameter_entity_reference: tags.definition(tags.variableName),
  entity_reference: tags.variableName,
  text_line: tags.content,
};

const cobolStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  section: tags.heading,
  keyword_statement: tags.keyword,
  text_line: tags.content,
};

const eclStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  preprocessor: tags.meta,
  definition: tags.definition(tags.variableName),
  statement: tags.keyword,
  text_line: tags.content,
};

const fclStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  block_header: tags.definitionKeyword,
  keyword_statement: tags.keyword,
  assignment: tags.definition(tags.variableName),
  text_line: tags.content,
};

const pigStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  directive: tags.meta,
  assignment: tags.definition(tags.variableName),
  statement: tags.keyword,
  text_line: tags.content,
};

const qStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  system_command: tags.meta,
  assignment: tags.definition(tags.variableName),
  expression: tags.content,
};

const rpmSpecStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  section: tags.heading,
  macro_definition: tags.definition(tags.macroName),
  conditional: tags.controlKeyword,
  tag: tags.propertyName,
  changelog_entry: tags.heading,
  change: tags.list,
  text_line: tags.content,
};

const solrStyleTags: Record<string, Tag | readonly Tag[]> = {
  field_query: tags.propertyName,
  range_query: tags.string,
  operator: tags.operatorKeyword,
  string: tags.string,
  term: tags.variableName,
  punctuation: tags.punctuation,
};

const spreadsheetStyleTags: Record<string, Tag | readonly Tag[]> = {
  formula: tags.definitionOperator,
  function_call: tags.function(tags.variableName),
  cell_range: tags.special(tags.variableName),
  cell: tags.variableName,
  string: tags.string,
  number: tags.number,
  operator: tags.operator,
  punctuation: tags.punctuation,
};

const stylusStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  import_statement: tags.moduleKeyword,
  variable_assignment: tags.definition(tags.variableName),
  selector: tags.tagName,
  property: tags.propertyName,
  text_line: tags.content,
};

const yacasStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  rule: tags.definitionKeyword,
  assignment: tags.definition(tags.variableName),
  function_call: tags.function(tags.variableName),
  string: tags.string,
  number: tags.number,
  identifier: tags.variableName,
  operator: tags.operator,
  punctuation: tags.punctuation,
};

const legacyLineStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  routine: tags.definition(tags.function(tags.variableName)),
  function_definition: tags.definition(tags.function(tags.variableName)),
  declaration: tags.definitionKeyword,
  control_statement: tags.controlKeyword,
  assignment: tags.definition(tags.variableName),
  keyword_statement: tags.keyword,
  preprocessor: tags.meta,
  section: tags.heading,
  module_parameter: tags.propertyName,
  request: tags.processingInstruction,
  escape_line: tags.escape,
  text_line: tags.content,
};

const wikiStyleTags: Record<string, Tag | readonly Tag[]> = {
  heading: tags.heading,
  macro: tags.processingInstruction,
  plugin: tags.processingInstruction,
  link: tags.link,
  list_item: tags.list,
  text_line: tags.content,
};

const verilogStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  module_header: tags.definitionKeyword,
  declaration: tags.definition(tags.variableName),
  preprocessor: tags.meta,
  keyword_statement: tags.keyword,
  text_line: tags.content,
};

const msgennyStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  entity: tags.variableName,
  arc: tags.operator,
  option: tags.propertyName,
  text_line: tags.content,
};

const eiffelStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  header_comment: tags.docComment,
  basic_manifest_string: tags.string,
  verbatim_string: tags.string,
  character_constant: tags.character,
  integer_constant: tags.integer,
  real_constant: tags.float,
  boolean_constant: tags.bool,
  void: tags.null,
  current: tags.self,
  result: tags.special(tags.variableName),
  class_name: tags.typeName,
  class_declaration: tags.definitionKeyword,
  extended_feature_name: tags.function(tags.variableName),
  identifier: tags.variableName,
  assignment: tags.operator,
};

const dylanStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  string: tags.string,
  character: tags.character,
  number: tags.number,
  boolean: tags.bool,
  identifier: tags.variableName,
  keyword: tags.keyword,
  symbol: tags.atom,
  type_specifier: tags.typeName,
  class_definition: tags.definitionKeyword,
  function_definition: tags.definitionKeyword,
  method_definition: tags.definitionKeyword,
  macro_definition: tags.definitionKeyword,
  module_definition: tags.moduleKeyword,
  variable_definition: tags.definition(tags.variableName),
  constant_definition: tags.definition(tags.variableName),
  slot_definition: tags.definition(tags.propertyName),
  if_statement: tags.controlKeyword,
  case_statement: tags.controlKeyword,
  select_statement: tags.controlKeyword,
  for_statement: tags.controlKeyword,
  while_statement: tags.controlKeyword,
  until_statement: tags.controlKeyword,
  unless_statement: tags.controlKeyword,
};

const factorStyleTags: Record<string, Tag | readonly Tag[]> = {
  string: tags.string,
  string_buffer: tags.string,
  pathname: tags.string,
  char: tags.character,
  integer: tags.integer,
  float: tags.float,
  ratio: tags.number,
  complex: tags.number,
  f: tags.bool,
  t: tags.bool,
  symbol: tags.variableName,
  word: tags.function(tags.variableName),
  colon: tags.definitionKeyword,
};

const gasStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  string: tags.string,
  char: tags.character,
  number: tags.number,
  directive_name: tags.meta,
  instruction_name: tags.function(tags.variableName),
  label: tags.labelName,
  register: tags.special(tags.variableName),
  symbol: tags.variableName,
  type: tags.typeName,
};

const asmStyleTags: Record<string, Tag | readonly Tag[]> = {
  line_comment: tags.comment,
  label: tags.labelName,
  word: tags.function(tags.variableName),
  ident: tags.variableName,
  reg: tags.special(tags.variableName),
  int: tags.integer,
  directive: tags.meta,
  meta: tags.meta,
  meta_ident: tags.meta,
  string: tags.string,
};

const latexStyleTags: Record<string, Tag | readonly Tag[]> = {
  line_comment: tags.comment,
  block_comment: tags.comment,
  comment: tags.comment,
  command_name: tags.function(tags.variableName),
  generic_command: tags.function(tags.variableName),
  begin: tags.keyword,
  end: tags.keyword,
  generic_environment: tags.tagName,
  comment_environment: tags.comment,
  verbatim_environment: tags.monospace,
  section: tags.heading2,
  subsection: tags.heading3,
  subsubsection: tags.heading4,
  paragraph: tags.heading5,
  title_declaration: tags.heading1,
  label_definition: tags.definition(tags.labelName),
  label_reference: tags.labelName,
  citation: tags.labelName,
  inline_formula: tags.atom,
  displayed_equation: tags.atom,
  math_environment: tags.atom,
  operator: tags.operator,
  path: tags.url,
  uri: tags.url,
};

const mscgenStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  comment_arc: tags.comment,
  start_token: tags.keyword,
  entity_identifier: tags.variableName,
  string: tags.string,
  number: tags.number,
  boolean: tags.bool,
  forward_arrow: tags.operator,
  backward_arrow: tags.operator,
  bidirectional_arrow: tags.operator,
  string_arc_attribute_key: tags.propertyName,
  string_entity_attribute_key: tags.propertyName,
  string_option_key: tags.propertyName,
  number_arc_attribute_key: tags.propertyName,
  numerical_option_key: tags.propertyName,
  boolean_arc_attribute_key: tags.propertyName,
  boolean_entity_attribute_key: tags.propertyName,
  boolean_option_key: tags.propertyName,
};

const mboxStyleTags: Record<string, Tag | readonly Tag[]> = {
  from_line: tags.processingInstruction,
  header: tags.propertyName,
  body_line: tags.content,
};

const mircStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  event: tags.controlKeyword,
  alias: tags.definition(tags.function(tags.variableName)),
  menu: tags.definitionKeyword,
  command: tags.function(tags.variableName),
  text_line: tags.content,
};

const mumpsStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  string: tags.string,
  integer: tags.integer,
  float: tags.float,
  boolean: tags.bool,
  label: tags.labelName,
  keyword: tags.keyword,
  command: tags.keyword,
  function_name: tags.function(tags.variableName),
  function_call: tags.function(tags.variableName),
  routine_call: tags.function(tags.variableName),
  routine_definition: tags.definition(tags.function(tags.variableName)),
  local_variable: tags.variableName,
  global_variable: tags.special(tags.variableName),
  global_array: tags.special(tags.variableName),
  local_array: tags.variableName,
  special_variable: tags.special(tags.variableName),
  binary_expression: tags.operator,
  unary_expression: tags.operator,
};

const mathematicaStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  number: tags.number,
  string: tags.string,
  string_char_escape: tags.escape,
  string_char_name_escape: tags.escape,
  user_symbol: tags.variableName,
  builtin_symbol: tags.standard(tags.variableName),
  blank: tags.tagName,
  blank_sequence: tags.tagName,
  blank_null_sequence: tags.tagName,
  set_operator: tags.operator,
  set_delayed_operator: tags.operator,
  rule_ascii_operator: tags.operator,
  rule_delayed_ascii_operator: tags.operator,
  compound_expression_operator: tags.operator,
  power_operator: tags.operator,
  plus_operator: tags.operator,
  minus_operator: tags.operator,
  times_ast_operator: tags.operator,
  divide_operator: tags.operator,
  apply_at_operator: tags.operator,
  map_operator: tags.operator,
};

const rpmChangesStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  entry_header: tags.heading,
  change: tags.list,
  text_line: tags.content,
};

const sasStyleTags: Record<string, Tag | readonly Tag[]> = {
  block_comment: tags.comment,
  line_comment: tags.comment,
  percent_comment: tags.comment,
  string_literal: tags.string,
  macro_name: tags.function(tags.variableName),
  macro_call: tags.function(tags.variableName),
  macro_variable_ref: tags.special(tags.variableName),
  macro_definition: tags.definitionKeyword,
  dataset_name: tags.namespace,
};

const sieveStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  string: tags.string,
  multiline_string: tags.string,
  number: tags.number,
  identifier: tags.variableName,
  require_statement: tags.moduleKeyword,
  if_statement: tags.controlKeyword,
  elsif_clause: tags.controlKeyword,
  else_clause: tags.controlKeyword,
  action_name: tags.function(tags.variableName),
  action_command: tags.function(tags.variableName),
  test_name: tags.function(tags.variableName),
  test_command: tags.function(tags.variableName),
  tagged_argument_no_value: tags.modifier,
  tagged_argument_with_value: tags.modifier,
};

const smlStyleTags: Record<string, Tag | readonly Tag[]> = {
  block_comment: tags.comment,
  line_comment: tags.comment,
  string_scon: tags.string,
  char_scon: tags.character,
  integer_scon: tags.integer,
  real_scon: tags.float,
  word_scon: tags.number,
  vid: tags.variableName,
  tyvar: tags.variableName,
  tycon: tags.typeName,
  longtycon: tags.typeName,
  strid: tags.namespace,
  sigid: tags.namespace,
  fctid: tags.namespace,
  fun: tags.definitionKeyword,
  val: tags.definitionKeyword,
  datatype: tags.definitionKeyword,
  type: tags.definitionKeyword,
  exception: tags.definitionKeyword,
  structure: tags.definitionKeyword,
  signature: tags.definitionKeyword,
  functor: tags.definitionKeyword,
  if: tags.controlKeyword,
  else: tags.controlKeyword,
  case: tags.controlKeyword,
  of: tags.controlKeyword,
  let: tags.controlKeyword,
  in: tags.controlKeyword,
  end: tags.controlKeyword,
};

const ttcnStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  charstring: tags.string,
  bitstring: tags.string,
  hexstring: tags.string,
  octetstring: tags.string,
  number: tags.number,
  boolean_literal: tags.bool,
  verdict_literal: tags.atom,
  _identifier: tags.variableName,
  reference: tags.variableName,
  name: tags.definition(tags.variableName),
  modifier: tags.modifier,
  module: tags.moduleKeyword,
  import_definition: tags.moduleKeyword,
  const_decl: tags.definitionKeyword,
  var_decl: tags.definitionKeyword,
  func: tags.definitionKeyword,
  external_function: tags.definitionKeyword,
  function_type: tags.definitionKeyword,
  testcase: tags.definitionKeyword,
  altstep: tags.definitionKeyword,
  template: tags.definitionKeyword,
  signature: tags.definitionKeyword,
  record_type: tags.definition(tags.typeName),
  set_type: tags.definition(tags.typeName),
  union_type: tags.definition(tags.typeName),
  enumerated_type: tags.definition(tags.typeName),
  component_type: tags.definition(tags.typeName),
  class_type: tags.definition(tags.typeName),
  if_stmt: tags.controlKeyword,
  for_stmt: tags.controlKeyword,
  for_range_stmt: tags.controlKeyword,
  while_stmt: tags.controlKeyword,
  do_while_stmt: tags.controlKeyword,
  select_stmt: tags.controlKeyword,
  return_stmt: tags.controlKeyword,
  break_stmt: tags.controlKeyword,
  continue_stmt: tags.controlKeyword,
};

const vbnetStyleTags: Record<string, Tag | readonly Tag[]> = {
  comment: tags.comment,
  string_literal: tags.string,
  character_literal: tags.character,
  integer_literal: tags.integer,
  floating_point_literal: tags.float,
  boolean_literal: tags.bool,
  nothing_literal: tags.null,
  predefined_type: tags.typeName,
  identifier: tags.variableName,
  member_modifier: tags.modifier,
  preprocessor_directive: tags.meta,
  imports_statement: tags.moduleKeyword,
  namespace_declaration: tags.definitionKeyword,
  class_declaration: tags.definitionKeyword,
  module_declaration: tags.definitionKeyword,
  interface_declaration: tags.definitionKeyword,
  structure_declaration: tags.definitionKeyword,
  enum_declaration: tags.definitionKeyword,
  delegate_declaration: tags.definitionKeyword,
  method_declaration: tags.definition(tags.function(tags.variableName)),
  property_declaration: tags.definition(tags.propertyName),
  field_declaration: tags.definition(tags.propertyName),
  if_statement: tags.controlKeyword,
  for_statement: tags.controlKeyword,
  for_each_statement: tags.controlKeyword,
  while_statement: tags.controlKeyword,
  do_statement: tags.controlKeyword,
  select_statement: tags.controlKeyword,
  try_statement: tags.controlKeyword,
  return_statement: tags.controlKeyword,
  throw_statement: tags.controlKeyword,
};

const velocityStyleTags: Record<string, Tag | readonly Tag[]> = {
  block_comment: tags.comment,
  line_comment: tags.comment,
  directive: tags.controlKeyword,
  variable: tags.variableName,
  text: tags.content,
};

async function load(spec: LanguageSpec) {
  let [wasm, highlightQuery, nested] = await Promise.all([
    spec.wasm(),
    spec.highlightQuery?.(),
    spec.nested?.(),
  ]);
  let parser = await TreeSitterParser.load(wasm, {
    implicitFinalNewline: spec.implicitFinalNewline,
  });
  let language = TreeSitterLanguage.define({
    name: spec.name.toLowerCase(),
    parser,
    languageData: spec.languageData ?? blockComment(),
    props: [...commonProps, ...(spec.props ?? [])],
    styleTags: { ...commonStyleTags, ...spec.styleTags },
    highlightQuery,
    nested,
  });
  return new LanguageSupport(language);
}

async function nestedParser(spec: LanguageSpec) {
  let [wasm, highlightQuery] = await Promise.all([spec.wasm(), spec.highlightQuery?.()]);
  let parser = await TreeSitterParser.load(wasm, {
    implicitFinalNewline: spec.implicitFinalNewline,
  });
  return TreeSitterLanguage.define({
    name: spec.name.toLowerCase(),
    parser,
    languageData: spec.languageData ?? blockComment(),
    props: [...commonProps, ...(spec.props ?? [])],
    styleTags: { ...commonStyleTags, ...spec.styleTags },
    highlightQuery,
  }).parser;
}

function rawTextRanges(parentName: string) {
  return (tree: Tree): DocRange[] => {
    let captureName = rawTextCaptureByParent.get(parentName);
    if (!captureName) return [];
    return queryTreeCaptures(tree, rawTextQuerySource, { includeNested: false })
      .filter((capture) => capture.name == captureName)
      .map(captureRange);
  };
}

const rawTextCaptureByParent = new Map([
  ["script_element", "script.raw"],
  ["style_element", "style.raw"],
]);

function captureRange(capture: TreeSitterQueryCapture): DocRange {
  return { from: capture.node.from, to: capture.node.to };
}

const cssSpec: LanguageSpec = {
  name: "CSS",
  extensions: ["css"],
  wasm: cssWasm,
  languageData: blockComment("", "/*", "*/"),
  highlightQuery: cssHighlights,
  styleTags: stylesheetStyleTags,
};

const javascriptSpec: LanguageSpec = {
  name: "JavaScript",
  alias: ["ecmascript", "js", "node"],
  extensions: ["js", "mjs", "cjs"],
  wasm: javascriptWasm,
  highlightQuery: javascriptHighlights,
};

const sqlSpec: LanguageSpec = {
  name: "SQL",
  extensions: ["sql"],
  wasm: sqlWasm,
  languageData: blockComment("--", "/*", "*/"),
  highlightQuery: sqlHighlights,
};

const markdownInlineSpec: LanguageSpec = {
  name: "Markdown Inline",
  wasm: markdownInlineWasm,
  languageData: markdownData,
  highlightQuery: markdownInlineHighlights,
};

const markdownBlockSpec: LanguageSpec = {
  name: "Markdown",
  extensions: ["md", "markdown", "mkd"],
  implicitFinalNewline: true,
  wasm: markdownWasm,
  languageData: markdownData,
  highlightQuery: markdownHighlights,
};

const markdownSpec: LanguageSpec = {
  ...markdownBlockSpec,
  nested: async () => [
    { parser: await nestedParser(markdownInlineSpec), ranges: iterateMarkdownInlineRangeGroups },
  ],
};

let markdownParserServicePromise: Promise<MarkdownParserService> | null = null;

export function loadMarkdownParserService(): Promise<MarkdownParserService> {
  if (!markdownParserServicePromise) {
    let current = loadMarkdownParserServiceOnce();
    markdownParserServicePromise = current;
    void current.catch(() => {
      if (markdownParserServicePromise === current) markdownParserServicePromise = null;
    });
  }
  return markdownParserServicePromise;
}

async function loadMarkdownParserServiceOnce(): Promise<MarkdownParserService> {
  let [blockLanguage, inlineParser] = await Promise.all([
    load(markdownBlockSpec),
    nestedParser(markdownInlineSpec),
  ]);
  if (!(blockLanguage.language instanceof TreeSitterLanguage)) {
    throw new Error("Markdown block language is not tree-sitter backed");
  }
  return {
    blockLanguage,
    blockParser: blockLanguage.language.parser,
    inlineParser,
    inlineRanges: collectMarkdownInlineRangeGroups,
  };
}

const angularWasm = localAsset(new URL("./wasm/tree-sitter-angular.wasm", import.meta.url));
const angularHighlights = packageRawAsset(
  "tree-sitter-angular/queries/highlights.scm",
  () => import("tree-sitter-angular/queries/highlights.scm?raw"),
);

function desc(spec: LanguageSpec) {
  return LanguageDescription.of({
    name: spec.name,
    alias: spec.alias,
    extensions: spec.extensions,
    filename: spec.filename,
    load: () => load(spec),
  });
}

export const languages = [
  desc({
    name: "Shell",
    alias: ["bash", "sh", "zsh"],
    extensions: ["sh", "ksh", "bash"],
    filename: /^PKGBUILD$/,
    wasm: bashWasm,
    languageData: lineComment("#"),
    highlightQuery: bashHighlights,
  }),
  desc({
    name: "APL",
    extensions: ["dyalog", "apl"],
    wasm: aplWasm,
    languageData: lineComment("⍝"),
    styleTags: aplStyleTags,
  }),
  desc({
    name: "ASN.1",
    extensions: ["asn", "asn1"],
    wasm: asn1Wasm,
    languageData: lineComment("--"),
    styleTags: asn1StyleTags,
  }),
  desc({
    name: "Asterisk",
    filename: /^extensions\.conf$/i,
    wasm: asteriskWasm,
    languageData: lineComment(";"),
    styleTags: asteriskStyleTags,
  }),
  desc({
    name: "Brainfuck",
    extensions: ["b", "bf"],
    wasm: brainfuckWasm,
    languageData: brainfuckData,
    styleTags: {
      memoryadd: tags.arithmeticOperator,
      memorysubtract: tags.arithmeticOperator,
      pointerright: tags.derefOperator,
      pointerleft: tags.derefOperator,
      memoryoutput: tags.operator,
      memoryinput: tags.operator,
      loop: tags.controlKeyword,
      comment: tags.comment,
    },
  }),
  desc({ name: "C", extensions: ["c", "h", "ino"], wasm: cWasm, highlightQuery: cHighlights }),
  desc({
    name: "C++",
    alias: ["cpp"],
    extensions: ["cpp", "c++", "cc", "cxx", "hpp", "h++", "hh", "hxx"],
    wasm: cppWasm,
    highlightQuery: cppHighlights,
  }),
  desc({
    name: "C#",
    alias: ["csharp", "cs"],
    extensions: ["cs"],
    wasm: cSharpWasm,
    highlightQuery: cSharpHighlights,
  }),
  desc({
    ...cssSpec,
    name: "Closure Stylesheets (GSS)",
    extensions: ["gss"],
  }),
  desc({
    name: "Clojure",
    extensions: ["clj", "cljc", "cljx"],
    wasm: clojureWasm,
    languageData: lineComment(";"),
  }),
  desc({
    name: "ClojureScript",
    extensions: ["cljs"],
    wasm: clojureWasm,
    languageData: lineComment(";"),
  }),
  desc({
    name: "CMake",
    extensions: ["cmake", "cmake.in"],
    filename: /^CMakeLists\.txt$/,
    wasm: cmakeWasm,
    languageData: lineComment("#"),
    styleTags: {
      normal_command: tags.function(tags.variableName),
      identifier: tags.function(tags.variableName),
      quoted_argument: tags.string,
      bracket_argument: tags.string,
      line_comment: tags.comment,
      variable_ref: tags.variableName,
    },
  }),
  desc({
    name: "Cobol",
    extensions: ["cob", "cpy"],
    wasm: cobolWasm,
    languageData: lineComment("*"),
    styleTags: cobolStyleTags,
  }),
  desc({
    name: "CoffeeScript",
    alias: ["coffee", "coffee-script"],
    extensions: ["coffee"],
    wasm: coffeescriptWasm,
    languageData: coffeeData,
  }),
  desc({
    name: "Common Lisp",
    alias: ["lisp"],
    extensions: ["cl", "lisp", "el"],
    wasm: commonLispWasm,
    languageData: blockComment(";", "#|", "|#"),
  }),
  desc({
    ...sqlSpec,
    name: "CQL",
    alias: ["cassandra"],
    extensions: ["cql"],
  }),
  desc(cssSpec),
  desc({
    name: "Crystal",
    extensions: ["cr"],
    wasm: crystalWasm,
    languageData: lineComment("#"),
  }),
  desc({
    name: "Cypher",
    extensions: ["cyp", "cypher"],
    wasm: cypherWasm,
    languageData: lineComment("//"),
    highlightQuery: cypherHighlights,
  }),
  desc({
    name: "Cython",
    extensions: ["pyx", "pxd", "pxi"],
    wasm: cythonWasm,
    languageData: lineComment("#"),
    styleTags: cythonStyleTags,
  }),
  desc({
    name: "D",
    extensions: ["d"],
    wasm: dWasm,
    highlightQuery: dHighlights,
  }),
  desc({
    name: "Dart",
    extensions: ["dart"],
    wasm: dartWasm,
  }),
  desc({
    name: "diff",
    extensions: ["diff", "patch"],
    wasm: diffWasm,
    languageData: diffData,
    styleTags: {
      addition: tags.inserted,
      deletion: tags.deleted,
      change: tags.changed,
      hunk: tags.changed,
      location: tags.changed,
      command: tags.documentMeta,
      index: tags.documentMeta,
      old_file: tags.deleted,
      new_file: tags.inserted,
    },
  }),
  desc({
    name: "Dockerfile",
    filename: /^Dockerfile$/,
    wasm: dockerfileWasm,
    languageData: lineComment("#"),
    styleTags: {
      from_instruction: tags.keyword,
      run_instruction: tags.keyword,
      cmd_instruction: tags.keyword,
      copy_instruction: tags.keyword,
      env_instruction: tags.keyword,
      expose_instruction: tags.keyword,
      label_instruction: tags.keyword,
      shell_command: tags.string,
      image_name: tags.typeName,
      image_tag: tags.atom,
    },
  }),
  desc({
    name: "DTD",
    extensions: ["dtd"],
    wasm: dtdWasm,
    languageData: blockOnlyComment("<!--", "-->"),
    styleTags: dtdStyleTags,
  }),
  desc({
    name: "Dylan",
    extensions: ["dylan", "dyl", "intr"],
    wasm: dylanWasm,
    languageData: blockComment("//", "/*", "*/"),
    styleTags: dylanStyleTags,
  }),
  desc({
    name: "ECL",
    extensions: ["ecl"],
    wasm: eclWasm,
    languageData: blockComment("//", "/*", "*/"),
    styleTags: eclStyleTags,
  }),
  desc({
    name: "EBNF",
    wasm: ebnfWasm,
    languageData: ebnfData,
    styleTags: {
      syntax_rule: tags.definition(tags.variableName),
      identifier: tags.variableName,
      terminal: tags.string,
      comment: tags.comment,
    },
  }),
  desc({
    name: "Eiffel",
    extensions: ["e"],
    wasm: eiffelWasm,
    languageData: lineComment("--"),
    styleTags: eiffelStyleTags,
  }),
  desc({
    name: "Go",
    extensions: ["go"],
    wasm: goWasm,
    highlightQuery: goHighlights,
  }),
  desc({
    name: "Groovy",
    extensions: ["groovy", "gradle"],
    filename: /^Jenkinsfile$/,
    wasm: groovyWasm,
  }),
  desc({
    name: "Elixir",
    extensions: ["ex", "exs"],
    wasm: elixirWasm,
    languageData: lineComment("#"),
    highlightQuery: elixirHighlights,
  }),
  desc({ name: "edn", extensions: ["edn"], wasm: clojureWasm, languageData: lineComment(";") }),
  desc({
    name: "Elm",
    extensions: ["elm"],
    wasm: elmWasm,
    languageData: lineComment("--"),
    highlightQuery: elmHighlights,
  }),
  desc({
    name: "Erlang",
    extensions: ["erl"],
    wasm: erlangWasm,
    languageData: lineComment("%"),
  }),
  desc({
    ...sqlSpec,
    name: "Esper",
    extensions: undefined,
  }),
  desc({
    name: "F#",
    alias: ["fsharp"],
    extensions: ["fs"],
    wasm: fsharpWasm,
    highlightQuery: fsharpHighlights,
  }),
  desc({
    name: "FCL",
    wasm: fclWasm,
    languageData: blockComment("//", "/*", "*/"),
    styleTags: fclStyleTags,
  }),
  desc({
    name: "Factor",
    extensions: ["factor"],
    wasm: factorWasm,
    languageData: lineComment("!"),
    styleTags: factorStyleTags,
  }),
  desc({
    name: "Fortran",
    extensions: ["f", "for", "f77", "f90", "f95"],
    wasm: fortranWasm,
    languageData: lineComment("!"),
    styleTags: fortranStyleTags,
  }),
  desc({
    name: "Forth",
    extensions: ["forth", "fth", "4th"],
    wasm: forthWasm,
    languageData: lineComment("\\"),
    styleTags: forthStyleTags,
  }),
  desc({
    name: "Gas",
    extensions: ["s"],
    wasm: gasWasm,
    languageData: blockComment("#", "/*", "*/"),
    styleTags: gasStyleTags,
  }),
  desc({
    name: "Haskell",
    extensions: ["hs"],
    wasm: haskellWasm,
    languageData: blockComment("--", "{-", "-}"),
    highlightQuery: haskellHighlights,
  }),
  desc({
    name: "Haxe",
    extensions: ["hx"],
    wasm: haxeWasm,
  }),
  desc({
    name: "Gherkin",
    extensions: ["feature"],
    wasm: gherkinWasm,
    languageData: lineComment("#"),
    styleTags: {
      feature_kw: tags.keyword,
      scenario_kw: tags.keyword,
      given_kw: tags.keyword,
      when_kw: tags.keyword,
      then_kw: tags.keyword,
      and_kw: tags.keyword,
      but_kw: tags.keyword,
      comment: tags.comment,
    },
  }),
  desc({
    name: "HTML",
    alias: ["xhtml"],
    extensions: ["html", "htm", "handlebars", "hbs"],
    wasm: htmlWasm,
    highlightQuery: htmlHighlights,
    languageData: htmlData,
    props: [tagIsolateProps],
    nested: async () => [
      { parser: await nestedParser(javascriptSpec), ranges: rawTextRanges("script_element") },
      { parser: await nestedParser(cssSpec), ranges: rawTextRanges("style_element") },
    ],
  }),
  desc({
    name: "HTTP",
    wasm: httpWasm,
    languageData: noComment(),
    styleTags: {
      method: tags.keyword,
      target_url: tags.url,
      header: tags.propertyName,
      header_entity: tags.propertyName,
      response_code: tags.number,
    },
  }),
  desc({
    name: "HXML",
    extensions: ["hxml"],
    wasm: hxmlWasm,
    languageData: lineComment("#"),
    styleTags: hxmlStyleTags,
  }),
  desc({
    name: "IDL",
    extensions: ["pro"],
    wasm: idlWasm,
    languageData: lineComment(";"),
    styleTags: legacyLineStyleTags,
  }),
  desc({ name: "Java", extensions: ["java"], wasm: javaWasm, highlightQuery: javaHighlights }),
  desc(javascriptSpec),
  desc({
    name: "Jinja",
    extensions: ["j2", "jinja", "jinja2"],
    wasm: jinjaWasm,
    highlightQuery: jinjaHighlights,
    languageData: {
      commentTokens: { block: { open: "{#", close: "#}" } },
      closeBrackets: { brackets: ["(", "[", "{", "'", '"'] },
      indentOnInput: /^\s*(?:\{% end\w+ %\}|\})$/,
    },
  }),
  desc({
    name: "JSON",
    alias: ["json5"],
    extensions: ["json", "map"],
    wasm: jsonWasm,
    languageData: jsonData,
    highlightQuery: jsonHighlights,
  }),
  desc({
    name: "JSON-LD",
    alias: ["jsonld"],
    extensions: ["jsonld"],
    wasm: jsonWasm,
    languageData: jsonData,
    highlightQuery: jsonHighlights,
  }),
  desc({
    name: "JSX",
    extensions: ["jsx"],
    wasm: tsxWasm,
    highlightQuery: typescriptHighlights,
  }),
  desc({
    name: "Julia",
    extensions: ["jl"],
    wasm: juliaWasm,
    languageData: lineComment("#"),
    highlightQuery: juliaHighlights,
  }),
  desc({
    name: "sTeX",
    wasm: latexWasm,
    languageData: lineComment("%"),
    styleTags: latexStyleTags,
  }),
  desc({
    name: "LaTeX",
    alias: ["tex"],
    extensions: ["text", "ltx", "tex"],
    wasm: latexWasm,
    languageData: lineComment("%"),
    styleTags: latexStyleTags,
  }),
  desc({
    name: "Kotlin",
    extensions: ["kt", "kts"],
    wasm: kotlinWasm,
  }),
  desc({
    name: "LESS",
    extensions: ["less"],
    wasm: lessWasm,
    languageData: blockComment("//", "/*", "*/"),
    styleTags: stylesheetStyleTags,
  }),
  desc({
    name: "Liquid",
    extensions: ["liquid"],
    wasm: liquidWasm,
    languageData: liquidData,
    styleTags: liquidStyleTags,
  }),
  desc({
    name: "LiveScript",
    alias: ["ls"],
    extensions: ["ls"],
    wasm: livescriptWasm,
    languageData: coffeeData,
    styleTags: legacyLineStyleTags,
  }),
  desc({
    name: "Lua",
    extensions: ["lua"],
    wasm: luaWasm,
    languageData: lineComment("--"),
    highlightQuery: luaHighlights,
  }),
  desc({
    ...sqlSpec,
    name: "MariaDB SQL",
    extensions: undefined,
  }),
  desc({
    ...markdownSpec,
  }),
  desc({
    ...sqlSpec,
    name: "MS SQL",
    extensions: undefined,
  }),
  desc({
    ...sqlSpec,
    name: "MySQL",
    extensions: undefined,
  }),
  desc({
    name: "Mbox",
    extensions: ["mbox"],
    wasm: mboxWasm,
    languageData: noComment(),
    styleTags: mboxStyleTags,
  }),
  desc({
    name: "mIRC",
    extensions: ["mrc"],
    wasm: mircWasm,
    languageData: lineComment(";"),
    styleTags: mircStyleTags,
  }),
  desc({
    name: "Mathematica",
    extensions: ["m", "nb", "wl", "wls"],
    wasm: mathematicaWasm,
    languageData: blockOnlyComment("(*", "*)"),
    styleTags: mathematicaStyleTags,
  }),
  desc({
    name: "Modelica",
    extensions: ["mo"],
    wasm: modelicaWasm,
    languageData: blockComment("//", "/*", "*/"),
    styleTags: modelicaStyleTags,
  }),
  desc({
    name: "MscGen",
    extensions: ["mscgen", "mscin", "msc"],
    wasm: mscgenWasm,
    languageData: blockComment("#", "/*", "*/"),
    styleTags: mscgenStyleTags,
  }),
  desc({
    name: "MsGenny",
    extensions: ["msgenny"],
    wasm: msgennyWasm,
    languageData: blockComment("#", "/*", "*/"),
    styleTags: msgennyStyleTags,
  }),
  desc({
    name: "Xù",
    extensions: ["xu"],
    wasm: mscgenWasm,
    languageData: blockComment("#", "/*", "*/"),
    styleTags: mscgenStyleTags,
  }),
  desc({
    name: "MUMPS",
    extensions: ["mps"],
    wasm: mumpsWasm,
    languageData: lineComment(";"),
    styleTags: mumpsStyleTags,
  }),
  desc({
    name: "Nginx",
    filename: /nginx.*\.conf$/i,
    wasm: nginxWasm,
    languageData: lineComment("#"),
    highlightQuery: nginxHighlights,
  }),
  desc({
    name: "NTriples",
    extensions: ["nt", "nq"],
    wasm: turtleWasm,
    languageData: lineComment("#"),
  }),
  desc({
    name: "NSIS",
    extensions: ["nsh", "nsi"],
    wasm: nsisWasm,
    languageData: lineComment(";"),
    styleTags: nsisStyleTags,
  }),
  desc({
    name: "Objective-C",
    alias: ["objective-c", "objc"],
    extensions: ["m"],
    wasm: objectiveCWasm,
    highlightQuery: objectiveCHighlights,
  }),
  desc({
    name: "Objective-C++",
    alias: ["objective-c++", "objc++"],
    extensions: ["mm"],
    wasm: objectiveCWasm,
    highlightQuery: objectiveCHighlights,
  }),
  desc({
    name: "OCaml",
    extensions: ["ml", "mli", "mll", "mly"],
    wasm: ocamlWasm,
    highlightQuery: ocamlHighlights,
    languageData: {
      commentTokens: { block: { open: "(*", close: "*)" } },
      closeBrackets: { brackets: ["(", "[", "{", "'", '"'] },
      indentOnInput: /^\s*[}\])]$/,
    },
  }),
  desc({
    name: "Octave",
    extensions: ["m"],
    wasm: octaveWasm,
    languageData: blockComment("%", "%{", "%}"),
    styleTags: legacyLineStyleTags,
  }),
  desc({
    name: "Oz",
    extensions: ["oz"],
    wasm: ozWasm,
    languageData: lineComment("%"),
    styleTags: legacyLineStyleTags,
  }),
  desc({
    name: "Pascal",
    extensions: ["p", "pas"],
    wasm: pascalWasm,
    languageData: blockComment("//", "{", "}"),
    highlightQuery: pascalHighlights,
  }),
  desc({
    name: "PGP",
    alias: ["asciiarmor"],
    extensions: ["asc", "pgp", "sig"],
    wasm: pgpWasm,
    languageData: noComment(),
    styleTags: pgpStyleTags,
  }),
  desc({
    name: "Perl",
    extensions: ["pl", "pm"],
    wasm: perlWasm,
    languageData: lineComment("#"),
    highlightQuery: perlHighlights,
  }),
  desc({
    name: "PHP",
    extensions: ["php", "php3", "php4", "php5", "php7", "phtml"],
    wasm: phpWasm,
    highlightQuery: phpHighlights,
  }),
  desc({
    name: "Pig",
    extensions: ["pig"],
    wasm: pigWasm,
    languageData: blockComment("--", "/*", "*/"),
    styleTags: pigStyleTags,
  }),
  desc({
    name: "ProtoBuf",
    extensions: ["proto"],
    wasm: protoWasm,
    languageData: blockComment("//", "/*", "*/"),
    styleTags: {
      syntax: tags.keyword,
      package: tags.moduleKeyword,
      import: tags.moduleKeyword,
      message: tags.definitionKeyword,
      enum: tags.definitionKeyword,
      service: tags.definitionKeyword,
      rpc: tags.definitionKeyword,
      message_name: tags.definition(tags.typeName),
      enum_name: tags.definition(tags.typeName),
      service_name: tags.definition(tags.typeName),
      field: tags.definition(tags.propertyName),
      type: tags.typeName,
      int_lit: tags.integer,
    },
  }),
  desc({
    name: "Pug",
    alias: ["jade"],
    extensions: ["pug", "jade"],
    wasm: pugWasm,
    highlightQuery: pugHighlights,
  }),
  desc({
    name: "Puppet",
    extensions: ["pp"],
    wasm: puppetWasm,
    languageData: lineComment("#"),
    styleTags: puppetStyleTags,
  }),
  desc({
    ...sqlSpec,
    name: "PLSQL",
    extensions: ["pls"],
  }),
  desc({
    ...sqlSpec,
    name: "PostgreSQL",
    extensions: undefined,
  }),
  desc({
    name: "PowerShell",
    extensions: ["ps1", "psd1", "psm1"],
    wasm: powershellWasm,
    languageData: lineComment("#"),
  }),
  desc({
    name: "Properties files",
    alias: ["ini", "properties"],
    extensions: ["properties", "ini", "in"],
    wasm: iniWasm,
    languageData: lineComment("#"),
  }),
  desc({
    name: "Python",
    extensions: ["BUILD", "bzl", "py", "pyw"],
    filename: /^(BUCK|BUILD)$/,
    wasm: pythonWasm,
    languageData: lineComment("#"),
    highlightQuery: pythonHighlights,
  }),
  desc({
    name: "Q",
    extensions: ["q"],
    wasm: qWasm,
    languageData: lineComment("/"),
    styleTags: qStyleTags,
  }),
  desc({
    name: "R",
    alias: ["rscript"],
    extensions: ["r", "R"],
    wasm: rWasm,
    languageData: lineComment("#"),
    styleTags: {
      identifier: tags.variableName,
      call: tags.function(tags.variableName),
      function_definition: tags.definitionKeyword,
      binary_operator: tags.operator,
      unary_operator: tags.operator,
      float: tags.float,
      integer: tags.integer,
      string: tags.string,
      comment: tags.comment,
    },
  }),
  desc({
    name: "Regex",
    alias: ["regexp"],
    extensions: ["re"],
    wasm: regexWasm,
    highlightQuery: regexHighlights,
  }),
  desc({
    name: "RPM Changes",
    wasm: rpmChangesWasm,
    languageData: lineComment("#"),
    styleTags: rpmChangesStyleTags,
  }),
  desc({
    name: "RPM Spec",
    extensions: ["spec"],
    wasm: rpmSpecWasm,
    languageData: lineComment("#"),
    styleTags: rpmSpecStyleTags,
  }),
  desc({
    name: "Ruby",
    alias: ["jruby", "macruby", "rake", "rb", "rbx"],
    extensions: ["rb"],
    filename: /^(Gemfile|Rakefile)$/,
    wasm: rubyWasm,
    languageData: lineComment("#"),
    highlightQuery: rubyHighlights,
  }),
  desc({ name: "Rust", extensions: ["rs"], wasm: rustWasm, highlightQuery: rustHighlights }),
  desc({
    name: "SAS",
    extensions: ["sas"],
    wasm: sasWasm,
    languageData: blockOnlyComment("/*", "*/"),
    styleTags: sasStyleTags,
  }),
  desc({
    name: "Sass",
    extensions: ["sass"],
    wasm: sassWasm,
    languageData: blockComment("//", "/*", "*/"),
    styleTags: stylesheetStyleTags,
  }),
  desc({
    name: "Scala",
    extensions: ["scala"],
    wasm: scalaWasm,
    highlightQuery: scalaHighlights,
  }),
  desc({
    name: "Scheme",
    extensions: ["scm", "ss"],
    wasm: schemeWasm,
    languageData: lineComment(";"),
  }),
  desc({
    name: "Smalltalk",
    extensions: ["st"],
    wasm: smalltalkWasm,
    languageData: smalltalkData,
  }),
  desc({
    name: "SML",
    extensions: ["sml", "sig", "fun", "smackspec"],
    wasm: smlWasm,
    languageData: blockOnlyComment("(*", "*)"),
    styleTags: smlStyleTags,
  }),
  desc({
    name: "Solr",
    wasm: solrWasm,
    languageData: noComment(),
    styleTags: solrStyleTags,
  }),
  desc({
    name: "SCSS",
    extensions: ["scss"],
    wasm: scssWasm,
    languageData: blockComment("", "/*", "*/"),
    highlightQuery: scssHighlights,
  }),
  desc({
    name: "Sieve",
    extensions: ["siv", "sieve"],
    wasm: sieveWasm,
    languageData: blockComment("#", "/*", "*/"),
    styleTags: sieveStyleTags,
  }),
  desc({
    name: "Squirrel",
    extensions: ["nut"],
    wasm: squirrelWasm,
    highlightQuery: squirrelHighlights,
  }),
  desc({
    name: "Spreadsheet",
    alias: ["excel", "formula"],
    wasm: spreadsheetWasm,
    languageData: noComment(),
    styleTags: spreadsheetStyleTags,
  }),
  desc({
    name: "SPARQL",
    alias: ["sparul"],
    extensions: ["rq", "sparql"],
    wasm: sparqlWasm,
    languageData: lineComment("#"),
  }),
  desc(sqlSpec),
  desc({
    ...sqlSpec,
    name: "SQLite",
    extensions: undefined,
  }),
  desc({
    name: "Swift",
    extensions: ["swift"],
    wasm: swiftWasm,
  }),
  desc({
    name: "SystemVerilog",
    extensions: ["v", "sv", "svh"],
    wasm: verilogWasm,
    languageData: blockComment("//", "/*", "*/"),
    styleTags: verilogStyleTags,
  }),
  desc({
    name: "Stylus",
    extensions: ["styl"],
    wasm: stylusWasm,
    languageData: blockComment("//", "/*", "*/"),
    styleTags: stylusStyleTags,
  }),
  desc({
    name: "TiddlyWiki",
    wasm: tiddlywikiWasm,
    languageData: markdownData,
    styleTags: wikiStyleTags,
  }),
  desc({
    name: "Tiki wiki",
    wasm: tikiWikiWasm,
    languageData: markdownData,
    styleTags: wikiStyleTags,
  }),
  desc({
    name: "Tcl",
    extensions: ["tcl"],
    wasm: tclWasm,
    languageData: lineComment("#"),
  }),
  desc({
    name: "Textile",
    extensions: ["textile"],
    wasm: textileWasm,
    languageData: markdownData,
    styleTags: textileStyleTags,
  }),
  desc({
    name: "TSX",
    extensions: ["tsx"],
    wasm: tsxWasm,
    highlightQuery: typescriptHighlights,
  }),
  desc({
    name: "TypeScript",
    alias: ["ts"],
    extensions: ["ts", "mts", "cts"],
    wasm: typescriptWasm,
    highlightQuery: typescriptHighlights,
  }),
  desc({
    name: "WebAssembly",
    extensions: ["wat", "wast"],
    wasm: wastWasm,
    languageData: blockComment(";;", "(;", ";)"),
  }),
  desc({
    name: "VB.NET",
    extensions: ["vb"],
    wasm: vbnetWasm,
    languageData: lineComment("'"),
    styleTags: vbnetStyleTags,
  }),
  desc({
    name: "VBScript",
    extensions: ["vbs"],
    wasm: vbscriptWasm,
    languageData: lineComment("'"),
    styleTags: vbscriptStyleTags,
  }),
  desc({
    name: "Velocity",
    extensions: ["vtl"],
    wasm: velocityWasm,
    languageData: blockComment("##", "#*", "*#"),
    styleTags: velocityStyleTags,
  }),
  desc({
    name: "Verilog",
    extensions: ["v"],
    wasm: verilogWasm,
    languageData: blockComment("//", "/*", "*/"),
    styleTags: verilogStyleTags,
  }),
  desc({
    name: "VHDL",
    extensions: ["vhd", "vhdl"],
    wasm: vhdlWasm,
    languageData: lineComment("--"),
  }),
  desc({
    name: "Web IDL",
    extensions: ["webidl"],
    wasm: webIdlWasm,
    languageData: blockComment("//", "/*", "*/"),
  }),
  desc({
    name: "TOML",
    extensions: ["toml"],
    wasm: tomlWasm,
    languageData: noComment(),
    highlightQuery: tomlHighlights,
  }),
  desc({
    name: "Troff",
    extensions: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
    wasm: troffWasm,
    languageData: lineComment('.\\"'),
    styleTags: legacyLineStyleTags,
  }),
  desc({
    name: "TTCN",
    extensions: ["ttcn", "ttcn3", "ttcnpp"],
    wasm: ttcn3Wasm,
    languageData: blockComment("//", "/*", "*/"),
    styleTags: ttcnStyleTags,
  }),
  desc({
    name: "TTCN_CFG",
    extensions: ["cfg"],
    wasm: ttcnCfgWasm,
    languageData: blockComment("#", "/*", "*/"),
    styleTags: legacyLineStyleTags,
  }),
  desc({
    name: "Turtle",
    extensions: ["ttl"],
    wasm: turtleWasm,
    languageData: lineComment("#"),
  }),
  desc({
    name: "XML",
    alias: ["rss", "wsdl", "xsd"],
    extensions: ["xml", "xsl", "xsd", "svg"],
    wasm: xmlWasm,
    languageData: htmlData,
    props: [tagIsolateProps],
    highlightQuery: xmlHighlights,
  }),
  desc({
    name: "XQuery",
    extensions: ["xy", "xquery", "xq", "xqm", "xqy"],
    wasm: xqueryWasm,
    languageData: xqueryData,
    highlightQuery: xqueryHighlights,
  }),
  desc({
    name: "YAML",
    alias: ["yml"],
    extensions: ["yaml", "yml"],
    wasm: yamlWasm,
    languageData: lineComment("#"),
    highlightQuery: yamlHighlights,
  }),
  desc({
    name: "Yacas",
    extensions: ["ys"],
    wasm: yacasWasm,
    languageData: blockComment("//", "/*", "*/"),
    styleTags: yacasStyleTags,
  }),
  desc({
    name: "Z80",
    extensions: ["z80"],
    wasm: asmWasm,
    languageData: lineComment(";"),
    styleTags: asmStyleTags,
  }),
  desc({
    name: "Vue",
    extensions: ["vue"],
    wasm: vueWasm,
    highlightQuery: htmlHighlights,
    languageData: htmlData,
    props: [tagIsolateProps],
    nested: async () => [
      { parser: await nestedParser(javascriptSpec), ranges: rawTextRanges("script_element") },
      { parser: await nestedParser(cssSpec), ranges: rawTextRanges("style_element") },
    ],
  }),
  desc({
    name: "ERB",
    alias: ["embedded template"],
    extensions: ["erb", "ejs"],
    wasm: embeddedTemplateWasm,
    languageData: blockComment("#"),
    highlightQuery: embeddedTemplateHighlights,
  }),
  desc({
    name: "Angular Template",
    wasm: angularWasm,
    languageData: htmlData,
    props: [tagIsolateProps],
    highlightQuery: angularHighlights,
  }),
];
