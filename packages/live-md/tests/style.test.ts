import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "vite-plus";
import { describe, expect, it } from "vite-plus/test";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));

describe("public LiveMD stylesheet", () => {
  it("bundles KaTeX rules and fonts for programmatic editors", async () => {
    let root = await mkdtemp(join(workspaceRoot, ".tmp-live-md-style-"));

    try {
      await writeFile(
        join(root, "index.ts"),
        'import "@codemirror-treesitter/live-md/style.css";\n',
      );

      let result = await build({
        root,
        publicDir: false,
        logLevel: "silent",
        build: {
          assetsInlineLimit: 0,
          cssCodeSplit: false,
          minify: false,
          rollupOptions: {
            input: join(root, "index.ts"),
          },
          write: false,
        },
      });
      let outputs = collectBuildOutputs(result);
      let css = outputs
        .filter((output) => output.type == "asset" && output.fileName.endsWith(".css"))
        .map((output) => String(output.source))
        .join("\n");
      let fontAssets = outputs.filter(
        (output) => output.type == "asset" && /KaTeX_.*\.woff2$/.test(output.fileName),
      );

      expect(css).toContain(".katex .katex-mathml");
      expect(css).toContain('font-family: "KaTeX_Main"');
      expect(css).toContain(".live-md-codemirror .cm-md-latex-inline .katex");
      expect(css).not.toContain('@import "katex/dist/katex.css"');
      expect(fontAssets.length).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

type BuildOutput = {
  fileName: string;
  source?: unknown;
  type: string;
};

type BuildOutputResult = {
  output: BuildOutput[];
};

function collectBuildOutputs(result: Awaited<ReturnType<typeof build>>): BuildOutput[] {
  let buildResults: BuildOutputResult[];
  if (Array.isArray(result)) {
    buildResults = result as BuildOutputResult[];
  } else if ("output" in result) {
    buildResults = [result as BuildOutputResult];
  } else {
    throw new Error("Expected a Vite build output, got a watcher");
  }

  return buildResults.flatMap((entry) => entry.output);
}
