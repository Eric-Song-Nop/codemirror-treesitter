import { describe, expect, it } from "vite-plus/test";
import { codeFenceLanguageNames, loadCodeFenceLanguages } from "../src/core/languages.js";

describe("LiveMD code-fence language loading", () => {
  it("loads only the language requested by an encountered fence", async () => {
    let languages = await loadCodeFenceLanguages(["ts"]);

    expect(languages.has("ts")).toBe(true);
    expect(languages.has("typescript")).toBe(true);
    expect(languages.has("javascript")).toBe(false);
    expect(languages.has("python")).toBe(false);
  });

  it("discovers and normalizes opening-fence languages without scanning fence contents", () => {
    expect(
      codeFenceLanguageNames(
        ["plain text", "```{.ts}", "```python", "```", "~~~ PY", "body", "~~~~", "```"].join("\n"),
      ),
    ).toEqual(["ts", "py"]);
    expect(codeFenceLanguageNames("no fences here")).toEqual([]);
  });
});
