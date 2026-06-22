// @vitest-environment happy-dom

import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { createLiveMdEditor, type LiveMdEditorController } from "../src/core/editor.js";

type SelectionSpec = number | { anchor: number; head: number };

type KeyCommandCase = {
  expected: string;
  init?: () => KeyboardEventInit;
  key: string;
  name: string;
  selection?: SelectionSpec;
  start: string;
};

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

describe("readonly LiveMD edit commands", () => {
  let keyCommandCases: KeyCommandCase[] = [
    {
      expected: "first\n",
      key: "Enter",
      name: "newline",
      start: "first",
    },
    {
      expected: "first\n",
      init: () => ({ shiftKey: true }),
      key: "Enter",
      name: "raw newline",
      start: "first",
    },
    {
      expected: "**text**",
      init: modKey,
      key: "b",
      name: "bold wrapping",
      selection: { anchor: 0, head: 4 },
      start: "text",
    },
    {
      expected: "_text_",
      init: modKey,
      key: "i",
      name: "emphasis wrapping",
      selection: { anchor: 0, head: 4 },
      start: "text",
    },
    {
      expected: "`text`",
      init: modKey,
      key: "e",
      name: "code wrapping",
      selection: { anchor: 0, head: 4 },
      start: "text",
    },
    {
      expected: "~~text~~",
      init: () => modKey({ shiftKey: true }),
      key: "x",
      name: "strikethrough wrapping",
      selection: { anchor: 0, head: 4 },
      start: "text",
    },
    {
      expected: "[label](https://example.com)",
      init: modKey,
      key: "k",
      name: "link insertion",
      selection: { anchor: 0, head: 5 },
      start: "label",
    },
    {
      expected: "- [x] task",
      init: () => modKey({ shiftKey: true }),
      key: "Enter",
      name: "task toggle shortcut",
      start: "- [ ] task",
    },
  ];

  for (let commandCase of keyCommandCases) {
    it(`keeps ${commandCase.name} disabled when readonly`, async () => {
      let editor = await mountEditor(commandCase.start, {
        readOnly: true,
        selection: commandCase.selection,
      });

      pressKey(editor.view, commandCase.key, commandCase.init?.());

      expect(editor.value).toBe(commandCase.start);
    });

    it(`keeps ${commandCase.name} working when writable`, async () => {
      let editor = await mountEditor(commandCase.start, {
        selection: commandCase.selection,
      });

      pressKey(editor.view, commandCase.key, commandCase.init?.());

      expect(editor.value).toBe(commandCase.expected);
    });
  }

  it("does not toggle task checkbox widgets when readonly", async () => {
    let editor = await mountEditor("- [ ] task\n\nnext", { readOnly: true });

    clickTaskCheckbox(editor.view);

    expect(editor.value).toBe("- [ ] task\n\nnext");
  });

  it("toggles task checkbox widgets when writable", async () => {
    let editor = await mountEditor("- [ ] task\n\nnext");

    clickTaskCheckbox(editor.view);

    expect(editor.value).toBe("- [x] task\n\nnext");
  });

  it("toggles task checkbox widgets after earlier edits move the marker", async () => {
    let editor = await mountEditor("intro\n- [ ] task\n\nnext");

    editor.view.dispatch({ changes: { from: 0, insert: "new " } });
    clickTaskCheckbox(editor.view);

    expect(editor.value).toBe("new intro\n- [x] task\n\nnext");
  });

  it("selects the current table source after earlier edits move the preview", async () => {
    let doc = "intro\n\n| Name | Value |\n| --- | ---: |\n| alpha | 1 |\n";
    let editor = await mountEditor(doc);

    editor.view.dispatch({ changes: { from: 0, insert: "new " } });
    clickTablePreview(editor.view);

    expect(editor.view.state.selection.main.head).toBe(editor.value.indexOf("| Name"));
    expect(editor.view.dom.querySelector(".cm-md-table-preview")).toBeNull();
    expect(editor.view.contentDOM.textContent).toContain("| Name | Value |");
  });
});

async function mountEditor(
  doc: string,
  options: { readOnly?: boolean; selection?: SelectionSpec } = {},
): Promise<LiveMdEditorController> {
  let parent = document.createElement("div");
  document.body.append(parent);
  let editor = createLiveMdEditor({
    parent,
    doc,
    focus: false,
    readOnly: options.readOnly,
  });
  await editor.ready;
  let selection = options.selection ?? doc.length;
  editor.view.dispatch({
    selection:
      typeof selection == "number"
        ? { anchor: selection }
        : { anchor: selection.anchor, head: selection.head },
  });
  return editor;
}

function modKey(init: KeyboardEventInit = {}): KeyboardEventInit {
  return {
    ...(/Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true }),
    ...init,
  };
}

function pressKey(view: EditorView, key: string, init: KeyboardEventInit = {}) {
  view.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      code: key.length == 1 ? `Key${key.toUpperCase()}` : key,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
}

function clickTaskCheckbox(view: EditorView) {
  let checkbox = view.dom.querySelector<HTMLButtonElement>(".cm-md-task-toggle");
  expect(checkbox).toBeTruthy();
  checkbox?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function clickTablePreview(view: EditorView) {
  let preview = view.dom.querySelector<HTMLElement>(".cm-md-table-preview");
  expect(preview).toBeTruthy();
  preview?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}
