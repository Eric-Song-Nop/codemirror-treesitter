import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vite-plus/test";
import { basicSetup, minimalSetup } from "../src/index.js";

describe("basic setup", () => {
  it("can be installed as editor state extensions", () => {
    let basic = EditorState.create({ doc: "hello", extensions: [basicSetup] });
    let minimal = EditorState.create({ doc: "hello", extensions: [minimalSetup] });

    expect(basic.doc.toString()).toBe("hello");
    expect(minimal.doc.toString()).toBe("hello");
  });
});
