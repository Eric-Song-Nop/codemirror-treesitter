// @vitest-environment happy-dom

import { StateField, Transaction } from "@codemirror/state";
import { createLiveMdEditor } from "@codemirror-treesitter/live-md";
import { EphemeralStore, LoroDoc, UndoManager } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  createLiveMdLoroTextGetter,
  getLiveMdLoroText,
  liveMdLoroCollaboration,
} from "../src/index.js";

let locationDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: undefined,
  });
});

afterEach(() => {
  document.body.replaceChildren();
  if (locationDescriptor) {
    Object.defineProperty(globalThis, "location", locationDescriptor);
  }
});

describe("liveMdLoroCollaboration", () => {
  it("uses the markdown Loro text by default", () => {
    let doc = new LoroDoc();
    let text = getLiveMdLoroText(doc);

    text.insert(0, "# Shared");
    doc.commit();

    expect(doc.getText("markdown").toString()).toBe("# Shared");
  });

  it("supports custom Loro text sources", () => {
    let doc = new LoroDoc();
    let byName = getLiveMdLoroText(doc, "body");
    let byGetter = getLiveMdLoroText(doc, (sourceDoc) => sourceDoc.getText("body"));

    byName.insert(0, "named");
    doc.commit();

    expect(byGetter.toString()).toBe("named");
  });

  it("accepts optional presence and collaborative undo", () => {
    let doc = new LoroDoc();
    let extension = liveMdLoroCollaboration({
      doc,
      presence: {
        ephemeral: new EphemeralStore(),
        user: { colorClassName: "user-ada", name: "Ada" },
      },
      undoManager: new UndoManager(doc, {}),
    });

    expect(extension).toBeTruthy();
  });

  it("syncs editor edits into the Loro document", async () => {
    let doc = new LoroDoc();
    let text = doc.getText("markdown");
    text.insert(0, "from loro");
    doc.commit();

    let parent = document.createElement("div");
    document.body.append(parent);
    let editor = createLiveMdEditor({
      defaultValue: "from default",
      extensions: [liveMdLoroCollaboration({ doc })],
      parent,
    });

    await flushMicrotasks();
    expect(editor.value).toBe("from loro");

    editor.view.dispatch({
      changes: { from: editor.value.length, insert: "!" },
      userEvent: "input.test",
    });

    expect(text.toString()).toBe("from loro!");
    await editor.ready;
    editor.destroy();
  });

  it("syncs the first editor edit when both documents start empty", async () => {
    let doc = new LoroDoc();
    let text = doc.getText("markdown");

    let parent = document.createElement("div");
    document.body.append(parent);
    let editor = createLiveMdEditor({
      extensions: [liveMdLoroCollaboration({ doc })],
      parent,
    });

    await flushMicrotasks();
    expect(editor.value).toBe("");
    expect(text.toString()).toBe("");

    editor.view.dispatch({
      changes: { from: 0, insert: "first" },
      userEvent: "input.test",
    });

    expect(text.toString()).toBe("first");
    await editor.ready;
    editor.destroy();
  });

  it("marks imported Loro changes as remote CodeMirror transactions", async () => {
    let doc = new LoroDoc();
    let text = doc.getText("markdown");
    text.insert(0, "base");
    doc.commit();

    let remoteFlags: boolean[] = [];
    let remoteRecorder = StateField.define<null>({
      create: () => null,
      update(value, transaction) {
        if (transaction.docChanged) {
          remoteFlags.push(transaction.annotation(Transaction.remote) === true);
        }
        return value;
      },
    });

    let parent = document.createElement("div");
    document.body.append(parent);
    let editor = createLiveMdEditor({
      defaultValue: "base",
      extensions: [liveMdLoroCollaboration({ doc }), remoteRecorder],
      parent,
    });

    await flushMicrotasks();
    remoteFlags = [];

    let remoteDoc = new LoroDoc();
    remoteDoc.import(doc.export({ mode: "snapshot" }));
    let from = doc.oplogVersion();
    remoteDoc.getText("markdown").insert("base".length, " remote");
    remoteDoc.commit();
    doc.import(remoteDoc.export({ from, mode: "update" }));

    await flushMicrotasks();
    expect(editor.value).toBe("base remote");
    expect(remoteFlags).toContain(true);
    await editor.ready;
    editor.destroy();
  });

  it("exposes reusable text getter functions", () => {
    let doc = new LoroDoc();
    let getText = createLiveMdLoroTextGetter("article");
    let text = getText(doc);

    text.insert(0, "article text");
    doc.commit();

    expect(doc.getText("article").toString()).toBe("article text");
  });
});

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}
