import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const upstreamLanguageDataUrl =
  "https://raw.githubusercontent.com/codemirror/language-data/main/src/language-data.ts";
const upstreamLanguageIndexUrl =
  "https://raw.githubusercontent.com/codemirror/language/main/src/index.ts";
const upstreamBasicSetupUrl =
  "https://raw.githubusercontent.com/codemirror/basic-setup/main/src/codemirror.ts";
const upstreamCommandsUrls = [
  "https://raw.githubusercontent.com/codemirror/commands/main/src/commands.ts",
  "https://raw.githubusercontent.com/codemirror/commands/main/src/comment.ts",
  "https://raw.githubusercontent.com/codemirror/commands/main/src/history.ts",
];
const upstreamAutocompleteIndexUrl =
  "https://raw.githubusercontent.com/codemirror/autocomplete/main/src/index.ts";
const upstreamMergeIndexUrl =
  "https://raw.githubusercontent.com/codemirror/merge/main/src/index.ts";
const upstreamLspClientIndexUrl =
  "https://raw.githubusercontent.com/codemirror/lsp-client/main/src/index.ts";
const examplesUrl = "https://codemirror.net/examples/";

const officialPackageNames = new Set([
  "@codemirror/language",
  "@codemirror/language-data",
  "@codemirror/basic-setup",
  "@codemirror/merge",
  "@codemirror/lsp-client",
]);

const requiredExampleSlugs = new Set([
  "basic",
  "config",
  "styling",
  "tab",
  "million",
  "lang-package",
  "mixed-language",
  "decoration",
  "bidi",
  "autocompletion",
  "lint",
]);

const skippedExampleSlugs = new Set([
  "bundle",
  "ie11",
  "selection",
  "change",
  "inverted-effect",
  "split",
  "zebra",
  "translate",
  "gutter",
  "panel",
  "tooltip",
  "readonly",
  "collab",
]);

const allowedLanguageDataExtras = new Set(["Elixir", "Regex", "ERB"]);

let failures = 0;

async function main() {
  await checkPackageNames();
  await checkNoLezerDependencies();
  await checkLanguagePublicExports();
  await checkCommandsPublicExports();
  await checkCommandsHaveNoStubs();
  await checkAutocompletePublicExports();
  await checkAutocompleteHasNoKnownStubs();
  await checkLanguageTreeSitterHighlightHelpers();
  await checkGruvboxThemePackage();
  await checkMergePublicExports();
  await checkMergeUsesLocalHighlighting();
  await checkLspClientPublicExports();
  await checkLspClientUsesLocalHighlighting();
  await checkBuiltStreamLanguageWorks();
  await checkBasicSetupImports();
  await checkBasicSetupParity();
  await checkLanguageDataParity();
  await checkBuiltLanguageDataLoads();
  await checkExamplesCoverage();
  await checkExamplesIncludeMergeAndLspClient();
  await checkExamplesComparisonImplementation();
  await checkExamplesUseGruvboxTheme();
  await checkExamplesBenchmarkIsTabbed();

  if (failures) {
    console.error(`audit failed with ${failures} issue${failures == 1 ? "" : "s"}`);
    process.exitCode = 1;
  } else {
    console.log("audit passed");
  }
}

async function checkLanguagePublicExports() {
  let upstream = parseNamedExports(await fetchText(upstreamLanguageIndexUrl));
  let local = parseNamedExports(await readText("packages/language/src/index.ts"));
  let missing = [...upstream].filter((name) => !local.has(name)).sort(compareString);
  for (let name of missing) fail(`language package is missing upstream export ${String(name)}`);
  pass(`language package exposes all ${upstream.size} upstream exports`);
}

async function checkCommandsPublicExports() {
  let upstreamSources = await Promise.all(upstreamCommandsUrls.map(fetchText));
  let localSources = await Promise.all([
    readText("packages/commands/src/index.ts"),
    readText("packages/commands/src/comment.ts"),
    readText("packages/commands/src/history.ts"),
  ]);
  let upstream = parsePublicExports(upstreamSources);
  let local = parsePublicExports(localSources);
  let missing = [...upstream].filter((name) => !local.has(name)).sort(compareString);
  let extra = [...local].filter((name) => !upstream.has(name)).sort(compareString);

  for (let name of missing) fail(`commands package is missing upstream export ${String(name)}`);
  for (let name of extra) fail(`commands package has unclassified extra export ${String(name)}`);
  pass(`commands package exposes all ${upstream.size} upstream exports`);
}

async function checkCommandsHaveNoStubs() {
  let files = await collectFiles("packages/commands/src", (file) => file.endsWith(".ts"));
  for (let file of files) {
    let text = await readText(file);
    if (/\bconst\s+noOp\s*:/.test(text) || /\bconst\s+noOp\s*=/.test(text)) {
      fail(`${relative(file)} defines a no-op command placeholder`);
    }
    if (/emacsStyleKeymap\s*:\s*readonly\s+KeyBinding\[\]\s*=\s*\[\]/.test(text)) {
      fail(`${relative(file)} leaves emacsStyleKeymap empty`);
    }
  }
  pass("commands package has no known command stubs");
}

async function checkAutocompletePublicExports() {
  let upstream = parsePublicExports([await fetchText(upstreamAutocompleteIndexUrl)]);
  let local = parsePublicExports([await readText("packages/autocomplete/src/index.ts")]);
  let missing = [...upstream].filter((name) => !local.has(name)).sort(compareString);
  let extra = [...local].filter((name) => !upstream.has(name)).sort(compareString);

  for (let name of missing) fail(`autocomplete package is missing upstream export ${String(name)}`);
  for (let name of extra)
    fail(`autocomplete package has unclassified extra export ${String(name)}`);
  pass(`autocomplete package exposes all ${upstream.size} upstream exports`);
}

async function checkIndexPublicExports(packageName, upstreamUrl, localIndexPath) {
  let upstream = parsePublicExports([await fetchText(upstreamUrl)]);
  let local = parsePublicExports([await readText(localIndexPath)]);
  let missing = [...upstream].filter((name) => !local.has(name)).sort(compareString);
  let extra = [...local].filter((name) => !upstream.has(name)).sort(compareString);

  for (let name of missing)
    fail(`${packageName} package is missing upstream export ${String(name)}`);
  for (let name of extra)
    fail(`${packageName} package has unclassified extra export ${String(name)}`);
  pass(`${packageName} package exposes all ${upstream.size} upstream exports`);
}

async function checkAutocompleteHasNoKnownStubs() {
  let files = await collectFiles("packages/autocomplete/src", (file) => file.endsWith(".ts"));
  for (let file of files) {
    let text = await readText(file);
    if (/get\s+aborted\s*\(\)\s*{\s*return\s+false\s*;?\s*}/.test(text)) {
      fail(`${relative(file)} leaves CompletionContext.aborted stubbed`);
    }
    if (/addEventListener\s*\([^)]*_type[^)]*_listener[^)]*\)\s*{\s*}/.test(text)) {
      fail(`${relative(file)} leaves CompletionContext.addEventListener stubbed`);
    }
  }
  pass("autocomplete package has no known completion context stubs");
}

async function checkLanguageTreeSitterHighlightHelpers() {
  let local = parsePublicExports([
    await readText("packages/language/src/index.ts"),
    await readText("packages/language/src/language.ts"),
    await readText("packages/language/src/highlight.ts"),
    await readText("packages/language/src/tags.ts"),
  ]);
  for (let name of ["highlightTree", "highlightCode", "styleTags", "getStyleTags"]) {
    if (!local.has(name)) fail(`language package is missing tree-sitter highlight helper ${name}`);
  }
  pass("language package exposes tree-sitter highlight compatibility helpers");
}

async function checkGruvboxThemePackage() {
  let pkg = JSON.parse(await readText("packages/theme-gruvbox/package.json"));
  if (pkg.dependencies?.["@codemirror-treesitter/language"] == null) {
    fail("theme-gruvbox does not depend on the local tree-sitter language package");
  }
  for (let name of ["@codemirror/language", "@lezer/highlight"]) {
    if (pkg.dependencies?.[name] != null) fail(`theme-gruvbox depends on ${name}`);
  }

  let source = await readText("packages/theme-gruvbox/src/index.ts");
  for (let snippet of [
    'from "@codemirror-treesitter/language"',
    "gruvboxDarkColors",
    "gruvboxDarkTheme",
    "gruvboxDarkHighlightStyle",
    "gruvboxDark",
    "gruvboxLightColors",
    "gruvboxLightTheme",
    "gruvboxLightHighlightStyle",
    "gruvboxLight",
  ]) {
    if (!source.includes(snippet)) fail(`theme-gruvbox source is missing ${snippet}`);
  }
  pass("theme-gruvbox exposes local dark and light Gruvbox themes");
}

async function checkMergePublicExports() {
  await checkIndexPublicExports("merge", upstreamMergeIndexUrl, "packages/merge/src/index.ts");
}

async function checkMergeUsesLocalHighlighting() {
  let source = await readText("packages/merge/src/unified.ts");
  if (!source.includes('from "@codemirror-treesitter/language"')) {
    fail("merge unified view does not import the local tree-sitter language package");
  }
  if (!source.includes("highlightTree")) fail("merge unified view does not highlight deletions");
  if (!source.includes("Text.of(")) {
    fail("merge deletion highlighter does not parse deletion text through CodeMirror Text");
  }
  pass("merge deletion highlighting uses local tree-sitter helpers");
}

async function checkLspClientPublicExports() {
  await checkIndexPublicExports(
    "lsp-client",
    upstreamLspClientIndexUrl,
    "packages/lsp-client/src/index.ts",
  );
}

async function checkLspClientUsesLocalHighlighting() {
  let files = [
    "packages/lsp-client/src/text.ts",
    "packages/lsp-client/src/hover.ts",
    "packages/lsp-client/src/completion.ts",
    "packages/lsp-client/src/client.ts",
    "packages/lsp-client/src/plugin.ts",
    "packages/lsp-client/src/formatting.ts",
  ];
  let sources = await Promise.all(files.map(readText));
  let joined = sources.join("\n");
  for (let name of ["@codemirror/language", "@codemirror/autocomplete", "@lezer/highlight"]) {
    if (joined.includes(name)) fail(`lsp-client source still imports ${name}`);
  }
  if (!joined.includes("@codemirror-treesitter/language")) {
    fail("lsp-client does not import the local tree-sitter language package");
  }
  if (!joined.includes("@codemirror-treesitter/autocomplete")) {
    fail("lsp-client completion does not import the local autocomplete package");
  }
  if (!joined.includes("highlightCode")) fail("lsp-client does not highlight markdown code blocks");
  if (!joined.includes("Text.of(")) {
    fail("lsp-client highlighter does not parse markdown code through CodeMirror Text");
  }
  pass("lsp-client markdown and completion integrations use local tree-sitter packages");
}

async function checkBuiltStreamLanguageWorks() {
  let [{ EditorState }, languagePackage] = await Promise.all([
    import("@codemirror/state"),
    builtLanguagePackage(),
  ]);
  let { StreamLanguage, ensureSyntaxTree, syntaxTree } = languagePackage;
  let language = StreamLanguage.define({
    name: "audit-stream",
    token(stream) {
      if (stream.eatSpace()) return null;
      if (stream.match(/\b(?:let|return)\b/)) return "keyword";
      if (stream.match(/"(?:[^"\\]|\\.)*"/)) return "string";
      if (stream.match(/[A-Za-z_]\w*/)) return "variable";
      stream.next();
      return null;
    },
    languageData: { commentTokens: { line: "//" } },
  });
  let state = EditorState.create({
    doc: 'let value = "ok"\n',
    extensions: [language.extension],
  });
  let tree = ensureSyntaxTree(state, state.doc.length);
  if (!tree) fail("built StreamLanguage did not produce a syntax tree");
  else {
    let doc = state.doc.toString();
    let keyword = syntaxTree(state).resolveInner(doc.indexOf("let")).name;
    let string = syntaxTree(state).resolveInner(doc.indexOf('"ok"')).name;
    if (keyword != "keyword") fail(`built StreamLanguage keyword node was ${keyword}`);
    if (string != "string") fail(`built StreamLanguage string node was ${string}`);
  }
  if (state.languageDataAt("commentTokens", 0)[0]?.line != "//") {
    fail("built StreamLanguage did not expose language data");
  }
  pass("built StreamLanguage defines usable stream-parser languages");
}

async function checkPackageNames() {
  let packages = await workspacePackageJsons("packages");
  for (let file of packages) {
    let pkg = JSON.parse(await readText(file));
    if (!pkg.name?.startsWith("@codemirror-treesitter/")) {
      fail(`${relative(file)} uses non-project package name ${JSON.stringify(pkg.name)}`);
    }
    if (officialPackageNames.has(pkg.name)) {
      fail(`${relative(file)} conflicts with the official CodeMirror package name ${pkg.name}`);
    }
  }
  pass("package names use the @codemirror-treesitter scope");
}

async function checkNoLezerDependencies() {
  let files = ["package.json", ...(await workspacePackageJsons("packages"))];
  for (let file of files) {
    let text = await readText(file);
    if (/@lezer\//.test(text)) fail(`${relative(file)} references @lezer`);
  }

  let sourceFiles = await collectFiles("packages", (file) => /\.(?:[cm]?[jt]s|tsx?)$/.test(file));
  for (let file of sourceFiles) {
    let text = await readText(file);
    if (/(?:from|import)\s*\(?\s*["']@lezer\//.test(text)) {
      fail(`${relative(file)} imports a Lezer package`);
    }
  }
  pass("implementation packages have no Lezer dependencies or source imports");
}

async function checkBasicSetupImports() {
  let source = await readText("packages/codemirror/src/index.ts");
  for (let name of [
    "@codemirror-treesitter/autocomplete",
    "@codemirror-treesitter/commands",
    "@codemirror-treesitter/language",
  ]) {
    if (!source.includes(name)) fail(`basic setup does not import ${name}`);
  }
  for (let name of ["@codemirror/autocomplete", "@codemirror/commands", "@codemirror/language"]) {
    if (source.includes(name)) fail(`basic setup imports official package ${name}`);
  }
  pass("basic setup imports local tree-sitter packages");
}

async function checkBasicSetupParity() {
  let upstream = await fetchText(upstreamBasicSetupUrl);
  let local = await readText("packages/codemirror/src/index.ts");
  let upstreamBasic = extensionSequence(upstream, "basicSetup");
  let localBasic = extensionSequence(local, "basicSetup");
  let upstreamMinimal = extensionSequence(upstream, "minimalSetup");
  let localMinimal = extensionSequence(local, "minimalSetup");
  let upstreamBasicKeymap = keymapSequence(upstream, "basicSetup");
  let localBasicKeymap = variableArraySequence(local, "basicKeymap");

  if (!sameJSON(upstreamBasic, localBasic)) {
    fail(
      `basicSetup extension sequence differs from upstream: expected ${JSON.stringify(
        upstreamBasic,
      )}, got ${JSON.stringify(localBasic)}`,
    );
  }
  if (!sameJSON(upstreamMinimal, localMinimal)) {
    fail(
      `minimalSetup extension sequence differs from upstream: expected ${JSON.stringify(
        upstreamMinimal,
      )}, got ${JSON.stringify(localMinimal)}`,
    );
  }
  if (!sameJSON(upstreamBasicKeymap, localBasicKeymap)) {
    fail(
      `basicSetup keymap sequence differs from upstream: expected ${JSON.stringify(
        upstreamBasicKeymap,
      )}, got ${JSON.stringify(localBasicKeymap)}`,
    );
  }

  pass("basic setup extension and keymap sequences match upstream");
}

async function checkLanguageDataParity() {
  let upstreamSource = await fetchText(upstreamLanguageDataUrl);
  let upstream = parseLanguageDataSource(upstreamSource);
  let { languages } = await builtLanguageData();
  let byName = new Map(languages.map((language) => [language.name, language]));

  for (let spec of upstream) {
    let local = byName.get(spec.name);
    if (!local) {
      fail(`language-data is missing upstream entry ${spec.name}`);
      continue;
    }

    let expectedAlias = [...spec.alias, spec.name]
      .map((name) => name.toLowerCase())
      .sort(compareString);
    let actualAlias = [...local.alias].sort(compareString);
    if (!sameJSON(expectedAlias, actualAlias)) {
      fail(
        `language-data alias mismatch for ${spec.name}: expected ${JSON.stringify(
          expectedAlias,
        )}, got ${JSON.stringify(actualAlias)}`,
      );
    }

    if (!sameJSON(spec.extensions, [...local.extensions])) {
      fail(
        `language-data extension mismatch for ${spec.name}: expected ${JSON.stringify(
          spec.extensions,
        )}, got ${JSON.stringify([...local.extensions])}`,
      );
    }

    let actualFilename = local.filename ? `/${local.filename.source}/${local.filename.flags}` : "";
    if ((spec.filename ?? "") != actualFilename) {
      fail(
        `language-data filename mismatch for ${spec.name}: expected ${spec.filename ?? "<none>"}, got ${
          actualFilename || "<none>"
        }`,
      );
    }
  }

  for (let language of languages) {
    if (
      !upstream.some((spec) => spec.name == language.name) &&
      !allowedLanguageDataExtras.has(language.name)
    ) {
      fail(`language-data has unclassified extra entry ${language.name}`);
    }
  }

  pass(`language-data metadata matches ${upstream.length} upstream entries`);
}

async function checkBuiltLanguageDataLoads() {
  let { languages } = await builtLanguageData();
  let loadFailures = [];
  for (let language of languages) {
    try {
      let support = await language.load();
      if (!support?.language?.parser) {
        loadFailures.push({ name: language.name, message: "missing parser" });
      }
    } catch (error) {
      loadFailures.push({
        name: language.name,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (let failure of loadFailures.slice(0, 20)) {
    fail(`built language-data failed to load ${failure.name}: ${failure.message}`);
  }
  if (loadFailures.length > 20) {
    fail(`built language-data had ${loadFailures.length - 20} additional load failures`);
  }
  if (!loadFailures.length) pass(`built language-data loads all ${languages.length} entries`);
}

async function checkExamplesCoverage() {
  let html = await fetchText(examplesUrl);
  let upstream = new Set(
    [...html.matchAll(new RegExp('href="([^"]+)/"', "g"))]
      .map((match) => match[1])
      .filter((slug) => /^[a-z0-9-]+$/.test(slug)),
  );
  let classified = new Set([...requiredExampleSlugs, ...skippedExampleSlugs]);
  for (let slug of upstream) {
    if (!classified.has(slug)) fail(`official example ${slug}/ is not classified`);
  }

  let source = await readText("apps/examples/src/main.ts");
  let implemented = new Set(
    [
      ...source.matchAll(
        new RegExp('official:\\s*"https://codemirror\\.net/examples/([^/]+)/', "g"),
      ),
    ].map((match) => match[1]),
  );
  for (let slug of requiredExampleSlugs) {
    if (!implemented.has(slug)) fail(`apps/examples is missing required example ${slug}/`);
  }
  pass("parser-relevant CodeMirror examples are implemented or explicitly skipped");
}

async function checkExamplesComparisonImplementation() {
  let pkg = JSON.parse(await readText("apps/examples/package.json"));
  for (let name of [
    "codemirror",
    "@codemirror/language",
    "@codemirror/language-data",
    "@lezer/common",
    "@lezer/highlight",
  ]) {
    if (!pkg.dependencies?.[name])
      fail(`apps/examples is missing original comparison dependency ${name}`);
  }

  let source = await readText("apps/examples/src/main.ts");
  for (let snippet of [
    'from "@codemirror-treesitter/language-data"',
    'from "@codemirror/language-data"',
    'from "codemirror"',
    "CodeMirror + Lezer",
    "Behavior Comparison",
  ]) {
    if (!source.includes(snippet)) fail(`apps/examples comparison source is missing ${snippet}`);
  }
  let comparisons = [...source.matchAll(new RegExp("\\n {4}compare:\\s*\\(", "g"))].length;
  if (comparisons < requiredExampleSlugs.size) {
    fail(
      `apps/examples defines ${comparisons} comparison blocks for ${requiredExampleSlugs.size} required examples`,
    );
  } else {
    pass("examples app implements original Lezer side and per-example comparisons");
  }
}

async function checkExamplesUseGruvboxTheme() {
  let pkg = JSON.parse(await readText("apps/examples/package.json"));
  if (!pkg.dependencies?.["@codemirror-treesitter/theme-gruvbox"]) {
    fail("apps/examples is missing the local Gruvbox theme dependency");
  }

  let config = await readText("apps/examples/vite.config.ts");
  if (!config.includes("../../packages/theme-gruvbox/src/index.ts")) {
    fail("apps/examples does not alias the local Gruvbox theme source");
  }

  let source = await readText("apps/examples/src/main.ts");
  for (let snippet of [
    'from "@codemirror-treesitter/theme-gruvbox"',
    "gruvboxDarkTheme",
    "gruvboxLightTheme",
    "gruvboxDarkHighlightStyle",
    "gruvboxLightHighlightStyle",
    "lezerGruvboxDarkHighlightStyle",
    "lezerGruvboxLightHighlightStyle",
    "treeBaseExtensions",
    "lezerBaseExtensions",
    "data-theme-mode",
  ]) {
    if (!source.includes(snippet)) fail(`apps/examples Gruvbox wiring is missing ${snippet}`);
  }

  let css = await readText("apps/examples/src/style.css");
  for (let snippet of [
    ':root[data-theme="dark"]',
    ':root[data-theme="light"]',
    "--accent-orange",
    ".theme-toggle",
    ".editor-host",
  ]) {
    if (!css.includes(snippet)) fail(`apps/examples Gruvbox UI is missing ${snippet}`);
  }
  pass("examples app uses local Gruvbox themes for both runtimes and UI modes");
}

async function checkExamplesBenchmarkIsTabbed() {
  let source = await readText("apps/examples/src/main.ts");
  for (let snippet of [
    'id = "benchmark-nav"',
    'className = "benchmark-nav"',
    "nav.append(benchmarkNav)",
    'data-view-panel="example"',
    'data-view-panel="benchmark"',
    "setViewMode",
    "syncNavigationState",
    "viewPanels",
  ]) {
    if (!source.includes(snippet)) fail(`apps/examples benchmark tab wiring is missing ${snippet}`);
  }

  let css = await readText("apps/examples/src/style.css");
  for (let snippet of [".benchmark-nav", ".view-panel", ".view-panel[hidden]"]) {
    if (!css.includes(snippet)) fail(`apps/examples benchmark tab CSS is missing ${snippet}`);
  }
  pass("examples app keeps benchmarks as a top-level examples navigation item");
}

async function checkExamplesIncludeMergeAndLspClient() {
  let pkg = JSON.parse(await readText("apps/examples/package.json"));
  for (let name of [
    "@codemirror-treesitter/merge",
    "@codemirror-treesitter/lsp-client",
    "@codemirror/merge",
    "@codemirror/lsp-client",
  ]) {
    if (!pkg.dependencies?.[name]) fail(`apps/examples is missing dependency ${name}`);
  }

  let source = await readText("apps/examples/src/main.ts");
  for (let snippet of [
    'id: "merge-view"',
    'id: "lsp-client"',
    'from "@codemirror-treesitter/merge"',
    'from "@codemirror-treesitter/lsp-client"',
    'from "@codemirror/merge"',
    'from "@codemirror/lsp-client"',
    "treeUnifiedMergeView",
    "treeLanguageServerExtensions",
    "lezerUnifiedMergeView",
    "lezerLanguageServerExtensions",
  ]) {
    if (!source.includes(snippet)) fail(`apps/examples merge/LSP coverage is missing ${snippet}`);
  }
  pass("examples app covers merge and lsp-client comparisons");
}

let builtLanguageDataPromise;
let builtLanguagePackagePromise;

function builtLanguageData() {
  return (builtLanguageDataPromise ??= import(
    pathToFileURL(path.join(root, "packages/language-data/dist/index.mjs")).href
  ));
}

function builtLanguagePackage() {
  return (builtLanguagePackagePromise ??= import(
    pathToFileURL(path.join(root, "packages/language/dist/index.mjs")).href
  ));
}

function parseNamedExports(sourceText) {
  let source = ts.createSourceFile("index.ts", sourceText, ts.ScriptTarget.Latest, true);
  let exports = new Set();
  for (let statement of source.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    let clause = statement.exportClause;
    if (!clause || !ts.isNamedExports(clause)) continue;
    for (let specifier of clause.elements) exports.add(specifier.name.text);
  }
  return exports;
}

function parsePublicExports(sourceTexts) {
  let exports = new Set();
  for (let [index, sourceText] of sourceTexts.entries()) {
    let source = ts.createSourceFile(
      `source-${index}.ts`,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
    );
    for (let statement of source.statements) {
      if (ts.isExportDeclaration(statement)) {
        let clause = statement.exportClause;
        if (!clause || !ts.isNamedExports(clause)) continue;
        for (let specifier of clause.elements) exports.add(specifier.name.text);
      } else if (
        statement.modifiers?.some((modifier) => modifier.kind == ts.SyntaxKind.ExportKeyword)
      ) {
        if (
          (ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement) ||
            ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement) ||
            ts.isEnumDeclaration(statement)) &&
          statement.name
        ) {
          exports.add(statement.name.text);
        } else if (ts.isVariableStatement(statement)) {
          for (let declaration of statement.declarationList.declarations) {
            addBindingExports(declaration.name, exports);
          }
        }
      }
    }
  }
  return exports;
}

function addBindingExports(name, exports) {
  if (ts.isIdentifier(name)) {
    exports.add(name.text);
  } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (let element of name.elements) {
      if (ts.isBindingElement(element)) addBindingExports(element.name, exports);
    }
  }
}

function parseLanguageDataSource(sourceText) {
  let source = ts.createSourceFile("language-data.ts", sourceText, ts.ScriptTarget.Latest, true);
  let specs = [];

  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text == "of" &&
      node.expression.expression.getText(source) == "LanguageDescription" &&
      node.arguments.length &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      let spec = { name: "", alias: [], extensions: [], filename: "" };
      for (let prop of node.arguments[0].properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        let key = propertyName(prop.name);
        if (key == "name" && ts.isStringLiteralLike(prop.initializer))
          spec.name = prop.initializer.text;
        else if (key == "alias") spec.alias = stringArray(prop.initializer);
        else if (key == "extensions") spec.extensions = stringArray(prop.initializer);
        else if (key == "filename" && ts.isRegularExpressionLiteral(prop.initializer)) {
          spec.filename = prop.initializer.text;
        }
      }
      if (spec.name) specs.push(spec);
    }
    ts.forEachChild(node, visit);
  }

  visit(source);
  return specs;
}

function extensionSequence(sourceText, exportName) {
  let array = exportedArray(sourceText, exportName);
  return array ? array.elements.map(extensionName).filter(Boolean) : [];
}

function keymapSequence(sourceText, exportName) {
  let array = exportedArray(sourceText, exportName);
  let keymapCall = array?.elements.find(
    (element) =>
      ts.isCallExpression(element) &&
      ts.isPropertyAccessExpression(element.expression) &&
      element.expression.expression.getText() == "keymap" &&
      element.expression.name.text == "of",
  );
  let keymapArray = keymapCall?.arguments[0];
  return ts.isArrayLiteralExpression(keymapArray)
    ? keymapArray.elements.map(spreadName).filter(Boolean)
    : [];
}

function variableArraySequence(sourceText, variableName) {
  let source = ts.createSourceFile("basic-setup.ts", sourceText, ts.ScriptTarget.Latest, true);
  for (let statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (let declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text == variableName &&
        ts.isArrayLiteralExpression(declaration.initializer)
      ) {
        return declaration.initializer.elements.map(spreadName).filter(Boolean);
      }
    }
  }
  return [];
}

function exportedArray(sourceText, exportName) {
  let source = ts.createSourceFile("basic-setup.ts", sourceText, ts.ScriptTarget.Latest, true);
  for (let statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    let isExported = statement.modifiers?.some(
      (modifier) => modifier.kind == ts.SyntaxKind.ExportKeyword,
    );
    if (!isExported) continue;
    for (let declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text != exportName) continue;
      let initializer = declaration.initializer;
      if (!ts.isCallExpression(initializer)) return null;
      let expression = initializer.expression;
      if (!ts.isParenthesizedExpression(expression) || !ts.isArrowFunction(expression.expression))
        return null;
      let body = expression.expression.body;
      return ts.isArrayLiteralExpression(body) ? body : null;
    }
  }
  return null;
}

function extensionName(node) {
  if (ts.isCallExpression(node)) return expressionName(node.expression);
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.expression.getText() == "keymap"
  ) {
    return "keymap.of";
  }
  if (ts.isPropertyAccessExpression(node)) return node.getText();
  return "";
}

function expressionName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) return node.getText();
  return "";
}

function spreadName(node) {
  return ts.isSpreadElement(node) ? node.expression.getText() : "";
}

function propertyName(name) {
  return name && (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) ? name.text : "";
}

function stringArray(node) {
  if (!ts.isArrayLiteralExpression(node)) return [];
  let values = [];
  for (let element of node.elements) {
    if (!ts.isStringLiteralLike(element)) return [];
    values.push(element.text);
  }
  return values;
}

async function workspacePackageJsons(workspace) {
  let dir = path.join(root, workspace);
  let entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(workspace, entry.name, "package.json"));
}

async function collectFiles(start, include) {
  let result = [];
  async function walk(dir) {
    for (let entry of await readdir(path.join(root, dir), { withFileTypes: true })) {
      let file = path.join(dir, entry.name);
      if (entry.name == "node_modules" || entry.name == "dist") continue;
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile() && include(file)) result.push(file);
    }
  }
  await walk(start);
  return result;
}

async function readText(file) {
  return readFile(path.join(root, file), "utf8");
}

async function fetchText(url) {
  let response = await fetch(url);
  if (!response.ok)
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  return response.text();
}

function sameJSON(a, b) {
  return JSON.stringify(a) == JSON.stringify(b);
}

function compareString(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function relative(file) {
  return typeof file == "string" ? file : path.relative(root, file);
}

function pass(message) {
  console.log(`pass: ${message}`);
}

function fail(message) {
  failures++;
  console.error(`fail: ${message}`);
}

await main();
