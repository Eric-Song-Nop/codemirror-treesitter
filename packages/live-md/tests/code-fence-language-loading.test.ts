import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import {
  changedCodeFenceLanguageNames,
  codeFenceLanguageNames,
  loadCodeFenceLanguages,
} from "../src/core/languages.js";

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

  it("rescans downstream fences when an upstream delimiter changes their role", () => {
    let before = EditorState.create({
      doc: ["```", "ordinary body", "```ts", "let value = 1", "```"].join("\n"),
    });
    let transaction = before.update({ changes: { from: 0, to: 3 } });

    expect(
      changedCodeFenceLanguageNames(before.doc, transaction.state.doc, transaction.changes),
    ).toEqual(["ts"]);
  });
});
