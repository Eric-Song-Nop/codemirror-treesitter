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
  it("discovers fences in quote and list containers and changed nested info strings", () => {
    for (let prefix of ["> ", "- ", "1. ", "> - ", "    "]) {
      let before = EditorState.create({ doc: `${prefix}\`\`\`ts\n${prefix}body\n${prefix}\`\`\`` });
      expect(codeFenceLanguageNames(before.doc.toString())).toEqual(["ts"]);
      let from = before.doc.toString().indexOf("ts");
      let transaction = before.update({ changes: { from, to: from + 2, insert: "python" } });
      expect(
        changedCodeFenceLanguageNames(before.doc, transaction.state.doc, transaction.changes),
      ).toEqual(["python"]);
    }
  });

  it("ends an unclosed quote fence when its container ends", () => {
    expect(codeFenceLanguageNames("> ```ts\n> body\n\n```python\nprint(1)\n```")).toEqual([
      "ts",
      "python",
    ]);
  });
});
