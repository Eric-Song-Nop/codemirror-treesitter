// @vitest-environment happy-dom

import { EditorView } from "@codemirror/view";
import { StateField, Transaction } from "@codemirror/state";
import { createLiveMdEditor } from "@codemirror-treesitter/live-md";
import { loroSyncAnnotation } from "loro-codemirror/sync";
import { EphemeralStore, LoroDoc, UndoManager } from "loro-crdt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  commitLiveMdLoroExternalEdit,
  createLiveMdLoroTextGetter,
  getLiveMdLoroText,
  liveMdLoroCollaboration,
  liveMdLoroUndo,
} from "../src/index.js";

import { ephemeralStateField } from "../../../vendor/loro-codemirror/src/ephemeral.ts";

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

      expect(handles.length).toBeGreaterThan(0);
      expect(new Set(handles.map(({ text }) => text)).size).toBe(handles.length);
      expect(handles.every(({ free }) => free.mock.calls.length === 1)).toBe(true);

      first.view.dispatch({
        changes: { from: 0, insert: "first" },
        userEvent: "input.test",
      });
      await flushMicrotasks();

      expect(second.value).toBe("first");
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

  it("syncs marked local Loro edits into the editor without writing them back", async () => {
    let doc = ownNative(new LoroDoc());
    let text = ownNative(doc.getText("markdown"));
    text.insert(0, "before");
    doc.commit();
    let localUpdates = 0;
    let unsubscribe = doc.subscribeLocalUpdates(() => localUpdates++);
    ownResource(unsubscribe, unsubscribe);

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
    let editor = createTestEditor({
      defaultValue: "before",
      extensions: [liveMdLoroCollaboration({ doc }), remoteRecorder],
      parent: document.body.appendChild(document.createElement("div")),
    });
    await flushMicrotasks();
    localUpdates = 0;
    remoteFlags = [];

    text.delete(0, 6);
    text.insert(0, "after");
    commitLiveMdLoroExternalEdit(doc);
    await flushMicrotasks();

    expect(editor.value).toBe("after");
    expect(text.toString()).toBe("after");
    expect(localUpdates).toBe(1);
    expect(remoteFlags).toEqual([true]);
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

  it("projects mixed-container imports and later edits without echo commits", async () => {
    let doc = ownNative(new LoroDoc());
    let text = ownNative(doc.getText("markdown"));
    text.insert(0, "base");
    doc.commit();
    // Loro does not guarantee cross-container event order. Exercise the legal
    // ordering that used to return before reaching the Markdown diff.
    let subscribe = doc.subscribe.bind(doc);
    vi.spyOn(doc, "subscribe").mockImplementation((listener) =>
      subscribe((event) =>
        listener({
          ...event,
          events: [...event.events].sort(
            (a, b) => Number(a.target === text.id) - Number(b.target === text.id),
          ),
        }),
      ),
    );
    let editor = createTestEditor({
      defaultValue: "base",
      extensions: [liveMdLoroCollaboration({ doc })],
      parent: document.body,
    });
    await flushMicrotasks();
    let remote = ownNative(new LoroDoc());
    remote.import(doc.export({ mode: "snapshot" }));
    let remoteText = ownNative(remote.getText("markdown"));
    let metadata = ownNative(remote.getMap("aaa"));
    let other = ownNative(remote.getText("aab"));
    metadata.set("title", "changed");
    other.insert(0, "unrelated");
    remoteText.insert(0, "new ");
    remote.commit();
    let commits = vi.fn();
    ownResource(commits, doc.subscribeLocalUpdates(commits));
    let eventTargets: string[] = [];
    let unsubscribe = doc.subscribe((event) => {
      eventTargets = event.events.map((item) => item.target);
    });
    ownResource(unsubscribe, unsubscribe);
    doc.import(remote.export({ mode: "snapshot" }));
    expect(eventTargets[0]).not.toBe(text.id);
    expect(eventTargets).toContain(text.id);
    expect(editor.value).toBe("new base");
    expect(commits).not.toHaveBeenCalled();
    editor.view.dispatch({ changes: { from: 8, insert: "!" } });
    expect(text.toString()).toBe("new base!");
  });

  it("keeps two views of one document synchronized through alternating local edits", async () => {
    let doc = ownNative(new LoroDoc());
    let text = ownNative(doc.getText("markdown"));
    let extension = liveMdLoroCollaboration({ doc });
    let first = createTestEditor({ extensions: [extension], parent: document.body });
    let second = createTestEditor({ extensions: [extension], parent: document.body });
    await flushMicrotasks();
    let commits = vi.fn();
    ownResource(commits, doc.subscribeLocalUpdates(commits));
    first.view.dispatch({ changes: { from: 0, insert: "hello" } });
    expect(second.value).toBe("hello");
    second.view.dispatch({ changes: { from: 5, insert: " world" } });
    first.view.dispatch({ changes: { from: 0, to: 6 } });
    expect(first.value).toBe("world");
    expect(second.value).toBe("world");
    expect(text.toString()).toBe("world");
    expect(commits).toHaveBeenCalledTimes(3);
    text.insert(0, "direct ");
    doc.commit();
    expect(first.value).toBe("direct world");
    expect(second.value).toBe("direct world");
    expect(commits).toHaveBeenCalledTimes(4);
    destroyTestEditor(first);
    second.view.dispatch({ changes: { from: 12, insert: "!" } });
    expect(text.toString()).toBe("direct world!");
  });

  it("resolves imported presence after insertion and deletion without stale or invalid offsets", async () => {
    let source = ownNative(new LoroDoc());
    let target = ownNative(new LoroDoc());
    let text = ownNative(source.getText("markdown"));
    text.insert(0, "abcdefghij");
    source.commit();
    target.import(source.export({ mode: "snapshot" }));
    let ephemeral = ownEphemeral();
    let remotePresence = ownEphemeral();
    let anchor = ownNative(text.getCursor(8)!);
    let head = ownNative(text.getCursor(9)!);
    remotePresence.set(`${source.peerIdStr}-cm-cursor`, {
      anchor: anchor.encode(),
      head: head.encode(),
    });
    ephemeral.apply(remotePresence.encodeAll());
    let editor = createTestEditor({
      defaultValue: "abcdefghij",
      autofocus: false,
      extensions: [
        liveMdLoroCollaboration({
          doc: target,
          presence: { ephemeral, user: { name: "local", colorClassName: "local" } },
        }),
      ],
      parent: document.body,
    });
    await flushMicrotasks();
    let cursor = () =>
      editor.view.state.field(ephemeralStateField).remoteCursors.get(source.peerIdStr)!;
    await vi.waitFor(() => expect(cursor()).toEqual({ anchor: 8, head: 9 }));
    let stateBefore = editor.view.state;
    text.insert(0, "ZZ");
    source.commit();
    target.import(source.export({ mode: "snapshot" }));
    expect(cursor()).toEqual({ anchor: 10, head: 11 });
    expect(stateBefore.field(ephemeralStateField).remoteCursors.get(source.peerIdStr)).toEqual({
      anchor: 8,
      head: 9,
    });
    text.delete(2, 10);
    source.commit();
    target.import(source.export({ mode: "snapshot" }));
    expect(cursor()).toEqual({ anchor: 2, head: 2 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(cursor()).toEqual({ anchor: 2, head: 2 });
    expect(editor.value).toBe("ZZ");
    remotePresence.delete(`${source.peerIdStr}-cm-cursor`);
    ephemeral.apply(remotePresence.encodeAll());
    destroyTestEditor(editor);
    let dispatch = vi.spyOn(editor.view, "dispatch");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each(["selection", "destroy", "restore"] as const)(
    "handles deferred undo cursor restoration: %s",
    async (mode) => {
      let doc = ownNative(new LoroDoc());
      let text = ownNative(doc.getText("markdown"));
      text.insert(0, "abcdef");
      doc.commit();
      let undoManager = ownNative(new UndoManager(doc, {}));
      let editor = createTestEditor({
        defaultValue: "abcdef",
        autofocus: false,
        extensions: [liveMdLoroCollaboration({ doc, undoManager })],
        parent: document.body,
      });
      await flushMicrotasks();
      editor.view.dispatch({ selection: { anchor: 3 } });
      editor.view.dispatch({ changes: { from: 3, insert: "X" }, selection: { anchor: 4 } });
      undoManager.undo();
      expect(editor.value).toBe("abcdef");
      if (mode === "selection")
        editor.view.dispatch({ selection: { anchor: 0 }, userEvent: "select.pointer" });
      if (mode === "destroy") destroyTestEditor(editor);
      let dispatch = vi.spyOn(editor.view, "dispatch");
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (mode === "destroy") expect(dispatch).not.toHaveBeenCalled();
      else expect(editor.view.state.selection.main.head).toBe(mode === "selection" ? 0 : 3);
    },
  );

  it("cancels a queued undo command when its editor is destroyed", async () => {
    let doc = ownNative(new LoroDoc());
    let undoManager = ownNative(new UndoManager(doc, {}));
    let editor = createTestEditor({
      extensions: [liveMdLoroCollaboration({ doc, undoManager })],
      parent: document.body,
    });
    await flushMicrotasks();
    editor.view.dispatch({ changes: { from: 0, insert: "keep" } });
    liveMdLoroUndo(editor.view);
    destroyTestEditor(editor);
    await flushMicrotasks();
    let text = ownNative(doc.getText("markdown"));
    expect(text.toString()).toBe("keep");
  });

  it("projects mixed-container undo once and retains shared undo bindings after one view closes", async () => {
    let doc = ownNative(new LoroDoc());
    let text = ownNative(doc.getText("markdown"));
    text.insert(0, "base");
    doc.commit();
    let manager = ownNative(new UndoManager(doc, { mergeInterval: 0 }));
    let extension = liveMdLoroCollaboration({ doc, undoManager: manager });
    let first = createTestEditor({
      defaultValue: "base",
      extensions: [extension],
      parent: document.body,
    });
    let second = createTestEditor({
      defaultValue: "base",
      extensions: [extension],
      parent: document.body,
    });
    await flushMicrotasks();
    let metadata = ownNative(doc.getMap("aaa"));
    metadata.set("label", "new");
    text.insert(0, "new ");
    doc.commit();
    expect(first.value).toBe("new base");
    expect(second.value).toBe("new base");
    manager.undo();
    expect(first.value).toBe("base");
    expect(second.value).toBe("base");
    destroyTestEditor(second);
    manager.redo();
    expect(first.value).toBe("new base");
    await new Promise((resolve) => setTimeout(resolve, 10));
    first.view.dispatch({ selection: { anchor: 2 } });
    first.view.dispatch({ changes: { from: 2, insert: "!" }, selection: { anchor: 3 } });
    liveMdLoroUndo(first.view);
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(first.value).toBe("new base");
    expect(first.view.state.selection.main.head).toBe(2);
  });

  it("captures undo metadata from the source view before a combined edit and selection", async () => {
    let doc = ownNative(new LoroDoc());
    let text = ownNative(doc.getText("markdown"));
    text.insert(0, "abcdef");
    doc.commit();
    let manager = ownNative(new UndoManager(doc, { mergeInterval: 0 }));
    let pushed: number[][] = [];
    let setOnPush = manager.setOnPush.bind(manager);
    vi.spyOn(manager, "setOnPush").mockImplementation((callback) =>
      setOnPush(
        callback &&
          ((...args) => {
            let result = callback(...args);
            pushed.push(result.cursors.map((cursor) => doc.getCursorPos(cursor)!.offset));
            return result;
          }),
      ),
    );
    let extension = liveMdLoroCollaboration({ doc, undoManager: manager });
    let first = new EditorView({ doc: "abcdef", extensions: [extension], parent: document.body });
    ownResource(first, () => first.destroy());
    let second = new EditorView({ doc: "abcdef", extensions: [extension], parent: document.body });
    ownResource(second, () => second.destroy());
    await flushMicrotasks();
    first.dispatch({ selection: { anchor: 2 } });
    second.dispatch({ selection: { anchor: 5 } });
    first.dispatch({ changes: { from: 2, insert: "X" }, selection: { anchor: 3 } });
    expect(pushed).toEqual([[3, 3]]);
    liveMdLoroUndo(first);
    await flushMicrotasks();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(first.state.doc.toString()).toBe("abcdef");
    expect(second.state.doc.toString()).toBe("abcdef");
    expect(first.state.selection.main.head).toBe(2);
  });

  it("keeps local edits when a ViewUpdate also contains a synchronized transaction", async () => {
    let doc = ownNative(new LoroDoc());
    let text = ownNative(doc.getText("markdown"));
    let view = new EditorView({ extensions: liveMdLoroCollaboration({ doc }) });
    ownResource(view, () => view.destroy());
    await flushMicrotasks();
    let synchronized = view.state.update({ annotations: loroSyncAnnotation.of("undo") });
    let local = synchronized.state.update({ changes: { from: 0, insert: "keep" } });
    view.update([synchronized, local]);
    expect(view.state.doc.toString()).toBe("keep");
    expect(text.toString()).toBe("keep");
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

function ownEphemeral() {
  let store = new EphemeralStore();
  return ownResource(store, () => {
    store.destroy();
    store.inner.free();
  });
}
