import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Plugin } from "vite-plus";

const buildPrecachePlaceholder = "/* __GROVE_BUILD_PRECACHE__ */";
const shellCacheKeyPlaceholder = "__GROVE_SHELL_CACHE_KEY__";

const collaborationRootSuffixes = [
  "/src/components/SharedFileEditor.tsx",
  "/src/lib/collaboration/markdown-document-runtime.ts",
  "/src/lib/collaboration/share-relay-connection.ts",
];
const criticalWorkspaceAssetPatterns = [
  [/(?:^|\/)web-tree-sitter-[^/]+\.wasm$/, "Tree-sitter runtime"],
  [/(?:^|\/)tree-sitter-markdown-(?!inline-)[^/]+\.wasm$/, "Markdown parser"],
  [/(?:^|\/)tree-sitter-markdown-inline-[^/]+\.wasm$/, "Markdown inline parser"],
] as const;
const highlightQueryChunkPattern = /(?:^|\/)highlights-[^/]+\.js$/;

type BuildChunk = {
  fileName: string;
  imports: string[];
  isEntry: boolean;
  moduleIds: string[];
  type: "chunk";
  viteMetadata?: {
    importedAssets?: Iterable<string>;
    importedCss?: Iterable<string>;
  };
};

export function serviceWorkerPrecachePlugin(serviceWorkerPath: string): Plugin {
  return {
    name: "grove-collaboration-precache",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      let chunks: BuildChunk[] = Object.values(bundle).flatMap((item) => {
        if (item.type != "chunk") return [];
        let chunk = item as typeof item & { viteMetadata?: BuildChunk["viteMetadata"] };
        return [
          {
            fileName: chunk.fileName,
            imports: chunk.imports,
            isEntry: chunk.isEntry,
            moduleIds: chunk.moduleIds,
            type: "chunk" as const,
            viteMetadata: chunk.viteMetadata,
          },
        ];
      });
      let urls: string[];

      try {
        urls = collectWorkspacePrecacheUrls(chunks, Object.keys(bundle));
      } catch (error) {
        this.error(error instanceof Error ? error.message : String(error));
      }

      let serviceWorker = readFileSync(serviceWorkerPath, "utf8");
      requireSinglePlaceholder(serviceWorker, buildPrecachePlaceholder);
      requireSinglePlaceholder(serviceWorker, shellCacheKeyPlaceholder);

      let injectedUrls = urls.map((url) => JSON.stringify(url)).join(",\n  ");
      let cacheKey = createHash("sha256")
        .update(Object.keys(bundle).sort().join("\n"))
        .digest("hex")
        .slice(0, 16);

      this.emitFile({
        type: "asset",
        fileName: "service-worker.js",
        source: serviceWorker
          .replace(buildPrecachePlaceholder, injectedUrls)
          .replace(shellCacheKeyPlaceholder, cacheKey),
      });
    },
  };
}

export function collectCollaborationPrecacheUrls(chunks: BuildChunk[]) {
  let chunksByFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  let initialFiles = collectStaticChunkFiles(
    chunks.filter((chunk) => chunk.isEntry),
    chunksByFileName,
  );
  let rootChunks = collaborationRootSuffixes.map((suffix) => {
    let chunk = chunks.find((candidate) =>
      candidate.moduleIds.some((id) => normalizeModuleId(id).endsWith(suffix)),
    );
    if (!chunk) throw new Error(`The production bundle is missing collaboration root ${suffix}.`);
    if (initialFiles.has(chunk.fileName)) {
      throw new Error(`Collaboration root ${suffix} is still part of the launcher bundle.`);
    }
    return chunk;
  });

  let visited = new Set<string>();
  let urls = new Set<string>();
  let pending = [...rootChunks];

  while (pending.length) {
    let chunk = pending.pop();
    if (!chunk || visited.has(chunk.fileName) || initialFiles.has(chunk.fileName)) continue;
    visited.add(chunk.fileName);
    urls.add(toRootUrl(chunk.fileName));
    for (let asset of chunk.viteMetadata?.importedAssets ?? []) urls.add(toRootUrl(asset));
    for (let css of chunk.viteMetadata?.importedCss ?? []) urls.add(toRootUrl(css));

    for (let importedFile of chunk.imports) {
      let importedChunk = chunksByFileName.get(importedFile);
      if (importedChunk) pending.push(importedChunk);
    }
  }

  let loroChunks = chunks.filter((chunk) =>
    chunk.moduleIds.some((id) => isLoroModuleId(normalizeModuleId(id))),
  );
  if (!loroChunks.length) throw new Error("The production bundle does not contain Loro.");
  for (let chunk of loroChunks) {
    if (!visited.has(chunk.fileName)) {
      throw new Error(`Loro chunk ${chunk.fileName} escaped the collaboration lazy closure.`);
    }
  }

  let loroWasmUrls = Array.from(urls).filter((url) => /\/loro_wasm_bg-[^/]+\.wasm$/.test(url));
  if (loroWasmUrls.length != 1) {
    throw new Error(
      `Expected exactly one Loro WASM asset in the lazy closure, found ${loroWasmUrls.length}.`,
    );
  }

  let treeSitterUrls = Array.from(urls).filter((url) =>
    /\/(?:web-)?tree-sitter[^/]*\.wasm$/.test(url),
  );
  if (treeSitterUrls.length) {
    throw new Error(
      `The collaboration precache unexpectedly contains Tree-sitter assets: ${treeSitterUrls.join(", ")}`,
    );
  }

  return Array.from(urls).sort();
}

export function collectWorkspacePrecacheUrls(
  chunks: BuildChunk[],
  bundleFileNames: readonly string[],
) {
  let chunksByFileName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
  let urls = new Set(collectCollaborationPrecacheUrls(chunks));

  collectChunkPrecacheUrls(
    chunks.filter((chunk) => chunk.isEntry),
    chunksByFileName,
    urls,
  );
  collectChunkPrecacheUrls(
    chunks.filter((chunk) => highlightQueryChunkPattern.test(chunk.fileName)),
    chunksByFileName,
    urls,
  );

  for (let [pattern, label] of criticalWorkspaceAssetPatterns) {
    urls.add(toRootUrl(requireSingleBundleFile(bundleFileNames, pattern, label)));
  }

  let eagerCodeFenceGrammars = Array.from(urls).filter(isDemandLoadedGrammarUrl);
  if (eagerCodeFenceGrammars.length) {
    throw new Error(
      `Demand-loaded code-fence grammars entered the offline precache: ${eagerCodeFenceGrammars.join(", ")}`,
    );
  }

  return Array.from(urls).sort();
}

function collectChunkPrecacheUrls(
  seeds: BuildChunk[],
  chunksByFileName: ReadonlyMap<string, BuildChunk>,
  urls: Set<string>,
) {
  let visited = new Set<string>();
  let pending = [...seeds];
  while (pending.length) {
    let chunk = pending.pop();
    if (!chunk || visited.has(chunk.fileName)) continue;
    visited.add(chunk.fileName);
    urls.add(toRootUrl(chunk.fileName));
    for (let asset of chunk.viteMetadata?.importedAssets ?? []) {
      let url = toRootUrl(asset);
      if (!isDemandLoadedGrammarUrl(url)) urls.add(url);
    }
    for (let css of chunk.viteMetadata?.importedCss ?? []) urls.add(toRootUrl(css));
    for (let importedFile of chunk.imports) {
      let importedChunk = chunksByFileName.get(importedFile);
      if (importedChunk) pending.push(importedChunk);
    }
  }
}

function requireSingleBundleFile(
  bundleFileNames: readonly string[],
  pattern: RegExp,
  label: string,
) {
  let matches = bundleFileNames.filter((fileName) => pattern.test(fileName));
  if (matches.length != 1) {
    throw new Error(`Expected exactly one ${label} asset, found ${matches.length}.`);
  }
  return matches[0];
}

function isDemandLoadedGrammarUrl(url: string) {
  let name = url.split("/").at(-1) ?? "";
  return (
    name.startsWith("tree-sitter-") &&
    name.endsWith(".wasm") &&
    !/^tree-sitter-markdown(?:-inline)?-/.test(name)
  );
}

function collectStaticChunkFiles(
  seeds: BuildChunk[],
  chunksByFileName: ReadonlyMap<string, BuildChunk>,
) {
  let files = new Set<string>();
  let pending = [...seeds];
  while (pending.length) {
    let chunk = pending.pop();
    if (!chunk || files.has(chunk.fileName)) continue;
    files.add(chunk.fileName);
    for (let importedFile of chunk.imports) {
      let importedChunk = chunksByFileName.get(importedFile);
      if (importedChunk) pending.push(importedChunk);
    }
  }
  return files;
}

function isLoroModuleId(id: string) {
  return id.includes("/node_modules/loro-crdt/") || id.includes("/packages/live-md-loro/");
}

function normalizeModuleId(id: string) {
  return id.replaceAll("\\", "/");
}

function toRootUrl(fileName: string) {
  return `/${fileName.replace(/^\/+/, "")}`;
}

function requireSinglePlaceholder(source: string, placeholder: string) {
  if (
    source.indexOf(placeholder) < 0 ||
    source.indexOf(placeholder) != source.lastIndexOf(placeholder)
  ) {
    throw new Error(`Expected exactly one ${placeholder} service-worker placeholder.`);
  }
}
