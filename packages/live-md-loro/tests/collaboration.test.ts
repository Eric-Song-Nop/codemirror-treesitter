// @vitest-environment happy-dom

import { StateField, Transaction } from "@codemirror/state";
import { createLiveMdEditor } from "@codemirror-treesitter/live-md";
import { loroSyncAnnotation } from "loro-codemirror/sync";
import { EphemeralStore, LoroDoc, UndoManager } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  createLiveMdLoroTextGetter,
  getLiveMdLoroText,
  liveMdLoroCollaboration,
} from "../src/index.js";

let locationDescriptor: PropertyDescriptor | undefined;
let editors = new Set<ReturnType<typeof createLiveMdEditor>>();
let resourceCleanups = new Map<object, () => void>();

beforeEach(() => {
  editors.clear();
  resourceCleanups.clear();
  locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: undefined,
  });
});

afterEach(() => {
  for (let editor of editors) editor.destroy();
  for (let cleanup of Array.from(resourceCleanups.values()).reverse()) cleanup();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  if (locationDescriptor) {
    Object.defineProperty(globalThis, "location", locationDescriptor);
  }
});

describe("liveMdLoroCollaboration", () => {
  it("releases every default text wrapper used by reused collaboration extensions", async () => {
    let doc = ownNative(new LoroDoc());
    let getText = doc.getText.bind(doc);
    let handles: Array<{
      free: ReturnType<typeof vi.spyOn>;
      text: ReturnType<LoroDoc["getText"]>;
    }> = [];
    vi.spyOn(doc, "getText").mockImplementation((key) => {
      let text = getText(key);
      handles.push({ free: vi.spyOn(text, "free"), text });
      return text;
    });

    let extension = liveMdLoroCollaboration({ doc });
    let first = createTestEditor({
      extensions: [extension],
      parent: document.body.appendChild(document.createElement("div")),
    });
    let second = createTestEditor({
      extensions: [extension],
      parent: document.body.appendChild(document.createElement("div")),
    });

    try {
      await flushMicrotasks();

      expect(handles).toHaveLength(4);
      expect(new Set(handles.map(({ text }) => text)).size).toBe(handles.length);
      expect(handles.every(({ free }) => free.mock.calls.length === 1)).toBe(true);

      first.view.dispatch({
        changes: { from: 0, insert: "first" },
        userEvent: "input.test",
      });
      await flushMicrotasks();

      expect(handles).toHaveLength(5);
      expect(handles.every(({ free }) => free.mock.calls.length === 1)).toBe(true);
    } finally {
      destroyTestEditor(first);
      destroyTestEditor(second);
      for (let handle of handles) {
        if (handle.free.mock.calls.length === 0) handle.text.free();
      }
    }
  });

  it("leaves custom getter results under caller ownership", async () => {
    let doc = ownNative(new LoroDoc());
    let text = ownNative(doc.getText("markdown"));
    let free = vi.spyOn(text, "free");
    let editor = createTestEditor({
      extensions: [liveMdLoroCollaboration({ doc, text: () => text })],
      parent: document.body.appendChild(document.createElement("div")),
    });

    await flushMicrotasks();
    editor.view.dispatch({
      changes: { from: 0, insert: "caller owned" },
      userEvent: "input.test",
    });
    await flushMicrotasks();
    destroyTestEditor(editor);

    expect(free).not.toHaveBeenCalled();
  });

  it("uses the markdown Loro text by default", () => {
    let doc = ownNative(new LoroDoc());
    let text = ownNative(getLiveMdLoroText(doc));

    text.insert(0, "# Shared");
    doc.commit();

    let readback = ownNative(doc.getText("markdown"));
    expect(readback.toString()).toBe("# Shared");
  });

  it("supports custom Loro text sources", () => {
    let doc = ownNative(new LoroDoc());
    let byName = ownNative(getLiveMdLoroText(doc, "body"));
    let byGetter = ownNative(getLiveMdLoroText(doc, (sourceDoc) => sourceDoc.getText("body")));

    byName.insert(0, "named");
    doc.commit();

    expect(byGetter.toString()).toBe("named");
  });

  it("accepts optional presence and collaborative undo", () => {
    let doc = ownNative(new LoroDoc());
    let ephemeral = new EphemeralStore();
    ownResource(ephemeral, () => {
      ephemeral.destroy();
      ephemeral.inner.free();
    });
    let undoManager = ownNative(new UndoManager(doc, {}));
    let extension = liveMdLoroCollaboration({
      doc,
      presence: {
        ephemeral,
        user: { colorClassName: "user-ada", name: "Ada" },
      },
      undoManager,
    });

    expect(extension).toBeTruthy();
  });

  it("syncs editor edits into the Loro document", async () => {
    let doc = ownNative(new LoroDoc());
    let text = ownNative(doc.getText("markdown"));
    text.insert(0, "from loro");
    doc.commit();

    let parent = document.createElement("div");
    document.body.append(parent);
    let editor = createTestEditor({
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
    destroyTestEditor(editor);
  });

  it("syncs the first editor edit when both documents start empty", async () => {
    let doc = ownNative(new LoroDoc());
    let text = ownNative(doc.getText("markdown"));

    let parent = document.createElement("div");
    document.body.append(parent);
    let editor = createTestEditor({
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
    destroyTestEditor(editor);
  });

  it("marks imported Loro changes as remote CodeMirror transactions", async () => {
    let doc = ownNative(new LoroDoc());
    let text = ownNative(doc.getText("markdown"));
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
    let editor = createTestEditor({
      defaultValue: "base",
      extensions: [liveMdLoroCollaboration({ doc }), remoteRecorder],
      parent,
    });

    await flushMicrotasks();
    remoteFlags = [];

    let remoteDoc = ownNative(new LoroDoc());
    remoteDoc.import(doc.export({ mode: "snapshot" }));
    let from = ownNative(doc.oplogVersion());
    let remoteText = ownNative(remoteDoc.getText("markdown"));
    remoteText.insert("base".length, " remote");
    remoteDoc.commit();
    doc.import(remoteDoc.export({ from, mode: "update" }));

    await flushMicrotasks();
    expect(editor.value).toBe("base remote");
    expect(remoteFlags).toContain(true);
    await editor.ready;
    destroyTestEditor(editor);
  });

  it("marks direct Loro sync annotations as remote without constructor names", async () => {
    let doc = ownNative(new LoroDoc());
    let text = ownNative(doc.getText("markdown"));
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
    class e {}

    let parent = document.createElement("div");
    document.body.append(parent);
    let editor = createTestEditor({
      defaultValue: "base",
      extensions: [liveMdLoroCollaboration({ doc }), remoteRecorder],
      parent,
    });

    await flushMicrotasks();
    remoteFlags = [];

    editor.view.dispatch({
      annotations: [loroSyncAnnotation.of(new e())],
      changes: { from: "base".length, insert: " remote" },
    });

    expect(editor.value).toBe("base remote");
    expect(remoteFlags).toEqual([true]);
    await editor.ready;
    destroyTestEditor(editor);
  });

  it("exposes reusable text getter functions", () => {
    let doc = ownNative(new LoroDoc());
    let getText = createLiveMdLoroTextGetter("article");
    let text = ownNative(getText(doc));

    text.insert(0, "article text");
    doc.commit();

    let readback = ownNative(doc.getText("article"));
    expect(readback.toString()).toBe("article text");
  });
});

function createTestEditor(options: Parameters<typeof createLiveMdEditor>[0]) {
  let editor = createLiveMdEditor(options);
  editors.add(editor);
  return editor;
}

function destroyTestEditor(editor: ReturnType<typeof createLiveMdEditor>) {
  if (!editors.delete(editor)) return;
  editor.destroy();
}

function ownNative<T extends object & { free(): void }>(resource: T): T {
  return ownResource(resource, () => resource.free());
}

function ownResource<T extends object>(resource: T, cleanup: () => void): T {
  resourceCleanups.set(resource, cleanup);
  return resource;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}
