import { describe, expect, it } from "vite-plus/test";
import {
  collectStaticManifestClosure,
  requireLazyManifestRoot,
} from "./check-production-bundle.mjs";

const agentRuntimeRoot = "src/lib/agent/ai-sdk-runtime.ts";

describe("production bundle manifest graph", () => {
  it("accepts the Agent runtime as a dynamic root outside the initial static closure", () => {
    const manifest = createManifest();
    const initialKeys = collectStaticManifestClosure(manifest, ["index.html"]);

    expect(initialKeys).toEqual(new Set(["index.html", "_shared.js"]));
    expect(
      requireLazyManifestRoot({
        initialKeys,
        label: "Agent AI runtime",
        manifest,
        root: agentRuntimeRoot,
      }),
    ).toEqual({
      file: "assets/ai-sdk-runtime.js",
      key: agentRuntimeRoot,
    });
  });

  it("rejects a dynamic Agent root that becomes a static entry dependency", () => {
    const manifest = createManifest();
    manifest["index.html"].imports.push(agentRuntimeRoot);
    const initialKeys = collectStaticManifestClosure(manifest, ["index.html"]);

    expect(() =>
      requireLazyManifestRoot({
        initialKeys,
        label: "Agent AI runtime",
        manifest,
        root: agentRuntimeRoot,
      }),
    ).toThrow("still part of the launcher's static bundle");
  });

  it("rejects a dynamic root that aliases an initial JavaScript asset", () => {
    const manifest = createManifest();
    manifest[agentRuntimeRoot].file = manifest["index.html"].file;
    const initialKeys = collectStaticManifestClosure(manifest, ["index.html"]);

    expect(() =>
      requireLazyManifestRoot({
        initialKeys,
        label: "Agent AI runtime",
        manifest,
        root: agentRuntimeRoot,
      }),
    ).toThrow("chunk /assets/index.js is still part of the launcher's static bundle");
  });
});

function createManifest() {
  return {
    "index.html": {
      dynamicImports: [agentRuntimeRoot],
      file: "assets/index.js",
      imports: ["_shared.js"],
      isEntry: true,
      src: "index.html",
    },
    "_shared.js": {
      file: "assets/shared.js",
    },
    [agentRuntimeRoot]: {
      file: "assets/ai-sdk-runtime.js",
      imports: ["_shared.js"],
      isDynamicEntry: true,
      name: "ai-sdk-runtime",
      src: agentRuntimeRoot,
    },
  };
}
