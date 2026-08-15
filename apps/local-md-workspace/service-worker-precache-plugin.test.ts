import { describe, expect, it } from "vite-plus/test";
import {
  collectCollaborationPrecacheUrls,
  collectWorkspacePrecacheUrls,
} from "./service-worker-precache-plugin.ts";

describe("collectCollaborationPrecacheUrls", () => {
  it("caches the collaboration static closure without pulling in launcher assets", () => {
    let urls = collectCollaborationPrecacheUrls([
      chunk({ fileName: "assets/index.js", isEntry: true, imports: ["assets/common.js"] }),
      chunk({
        fileName: "assets/common.js",
        importedAssets: ["assets/tree-sitter-markdown.wasm"],
      }),
      chunk({
        fileName: "assets/shared-editor.js",
        moduleIds: ["/project/src/components/SharedFileEditor.tsx"],
        imports: ["assets/loro.js", "assets/common.js"],
      }),
      chunk({
        fileName: "assets/markdown-document.js",
        moduleIds: ["/project/src/lib/collaboration/markdown-document-runtime.ts"],
        imports: ["assets/loro.js"],
      }),
      chunk({
        fileName: "assets/share-relay.js",
        moduleIds: ["/project/src/lib/collaboration/share-relay-connection.ts"],
        imports: ["assets/loro.js"],
      }),
      chunk({
        fileName: "assets/loro.js",
        moduleIds: ["/project/node_modules/loro-crdt/browser/index.js"],
        importedAssets: ["assets/loro_wasm_bg-runtime.wasm"],
      }),
    ]);

    expect(urls).toEqual([
      "/assets/loro.js",
      "/assets/loro_wasm_bg-runtime.wasm",
      "/assets/markdown-document.js",
      "/assets/share-relay.js",
      "/assets/shared-editor.js",
    ]);
  });

  it("rejects a collaboration root that leaks back into the launcher", () => {
    expect(() =>
      collectCollaborationPrecacheUrls([
        chunk({
          fileName: "assets/index.js",
          isEntry: true,
          moduleIds: ["/project/src/components/SharedFileEditor.tsx"],
        }),
      ]),
    ).toThrow("still part of the launcher bundle");
  });

  it("caches the launcher and core Markdown runtime without eager code-fence grammars", () => {
    let urls = collectWorkspacePrecacheUrls(
      [
        chunk({
          fileName: "assets/index.js",
          isEntry: true,
          imports: ["assets/common.js"],
        }),
        chunk({
          fileName: "assets/common.js",
          importedAssets: ["assets/font.woff2"],
        }),
        chunk({
          fileName: "assets/shared-editor.js",
          moduleIds: ["/project/src/components/SharedFileEditor.tsx"],
          imports: ["assets/loro.js", "assets/common.js"],
        }),
        chunk({
          fileName: "assets/markdown-document.js",
          moduleIds: ["/project/src/lib/collaboration/markdown-document-runtime.ts"],
          imports: ["assets/loro.js"],
        }),
        chunk({
          fileName: "assets/share-relay.js",
          moduleIds: ["/project/src/lib/collaboration/share-relay-connection.ts"],
          imports: ["assets/loro.js"],
        }),
        chunk({
          fileName: "assets/loro.js",
          moduleIds: ["/project/node_modules/loro-crdt/browser/index.js"],
          importedAssets: ["assets/loro_wasm_bg-runtime.wasm"],
        }),
        chunk({
          fileName: "assets/highlights-python.js",
          importedAssets: ["assets/tree-sitter-python-runtime.wasm"],
          imports: ["assets/query-runtime.js"],
        }),
        chunk({ fileName: "assets/query-runtime.js" }),
      ],
      [
        "assets/font.woff2",
        "assets/loro_wasm_bg-runtime.wasm",
        "assets/tree-sitter-markdown-inline-runtime.wasm",
        "assets/tree-sitter-markdown-runtime.wasm",
        "assets/tree-sitter-python-runtime.wasm",
        "assets/web-tree-sitter-runtime.wasm",
      ],
    );

    expect(urls).toEqual([
      "/assets/common.js",
      "/assets/font.woff2",
      "/assets/highlights-python.js",
      "/assets/index.js",
      "/assets/loro.js",
      "/assets/loro_wasm_bg-runtime.wasm",
      "/assets/markdown-document.js",
      "/assets/query-runtime.js",
      "/assets/share-relay.js",
      "/assets/shared-editor.js",
      "/assets/tree-sitter-markdown-inline-runtime.wasm",
      "/assets/tree-sitter-markdown-runtime.wasm",
      "/assets/web-tree-sitter-runtime.wasm",
    ]);
    expect(urls).not.toContain("/assets/tree-sitter-python-runtime.wasm");
  });
});

function chunk({
  fileName,
  importedAssets = [],
  imports = [],
  isEntry = false,
  moduleIds = [],
}: {
  fileName: string;
  importedAssets?: string[];
  imports?: string[];
  isEntry?: boolean;
  moduleIds?: string[];
}) {
  return {
    fileName,
    imports,
    isEntry,
    moduleIds,
    type: "chunk" as const,
    viteMetadata: { importedAssets },
  };
}
