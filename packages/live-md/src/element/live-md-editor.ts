import { EditorView, type ViewUpdate } from "@codemirror/view";
import { createLiveMdEditor, type LiveMdEditorController } from "../core/editor.js";
import { installLiveMdStyles } from "./styles.js";

export class LiveMdEditorElement extends HTMLElement {
  static observedAttributes = [
    "autofocus",
    "default-value",
    "persist-key",
    "placeholder",
    "readonly",
  ];

  private controller: LiveMdEditorController | null = null;
  private cleanValue: string | null = null;
  private dirtySinceChange = false;
  private explicitValue = false;
  private mount: HTMLDivElement;
  private shadow: ShadowRoot;
  private storedDefaultValue: string | null = null;
  private storedSelectionEnd = 0;
  private storedSelectionStart = 0;
  private storedValue = "";

  ready: Promise<void> = Promise.resolve();

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
    installLiveMdStyles(this.shadow);

    this.mount = document.createElement("div");
    this.mount.className = "live-md-editor-root";
    this.mount.setAttribute("part", "editor");
    this.shadow.append(this.mount);
  }

  connectedCallback() {
    if (this.controller) return;

    let initialValue = this.explicitValue ? this.storedValue : this.defaultValue;
    let controller: LiveMdEditorController;
    try {
      controller = createLiveMdEditor({
        autofocus: this.hasAttribute("autofocus"),
        defaultValue: initialValue,
        onBlur: () => this.dispatchPendingChange(),
        onChange: ({ value }) => this.handleEditorInput(value),
        parent: this.mount,
        persistKey: this.persistKey,
        placeholder: this.placeholder,
        readOnly: this.readOnly,
        root: this.shadow,
        value: this.explicitValue ? this.storedValue : undefined,
        extensions: [EditorView.updateListener.of((update) => this.handleEditorSelection(update))],
      });
    } catch (error: unknown) {
      this.ready = Promise.reject(error);
      this.dispatchLiveMdError(error);
      return;
    }

    installLiveMdStyles(this.shadow);
    this.controller = controller;
    if (this.cleanValue == null) this.cleanValue = controller.value;
    this.applyStoredSelection();
    this.ready = controller.ready
      .then(() => {
        if (this.controller != controller) return;
        this.dispatchEvent(
          new CustomEvent("live-md-ready", {
            bubbles: true,
            composed: true,
            detail: { view: this.view },
          }),
        );
      })
      .catch((error: unknown) => {
        if (this.controller == controller) this.dispatchLiveMdError(error);
        throw error;
      });
  }

  disconnectedCallback() {
    if (!this.controller) return;
    this.storedValue = this.controller.value;
    this.storeCurrentSelection();
    this.explicitValue = true;
    this.controller.destroy();
    this.controller = null;
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
    if (oldValue == newValue) return;
    switch (name) {
      case "default-value":
        this.storedDefaultValue = newValue;
        if (!this.controller && !this.explicitValue) {
          this.storedValue = this.defaultValue;
          this.clampStoredSelection();
        }
        break;
      case "persist-key":
        this.controller?.setPersistKey(this.persistKey);
        break;
      case "placeholder":
        this.controller?.setPlaceholder(this.placeholder);
        break;
      case "readonly":
        this.controller?.setReadOnly(this.readOnly);
        break;
      default:
        break;
    }
  }

  get defaultValue() {
    return (
      this.storedDefaultValue ??
      this.getAttribute("default-value") ??
      normalizeLightDomMarkdown(this.textContent ?? "")
    );
  }

  set defaultValue(value: string) {
    this.storedDefaultValue = String(value);
    this.setAttribute("default-value", this.storedDefaultValue);
    if (!this.controller && !this.explicitValue) {
      this.storedValue = this.storedDefaultValue;
      this.clampStoredSelection();
    }
  }

  get persistKey() {
    return this.getAttribute("persist-key");
  }

  set persistKey(value: null | string) {
    if (value == null || value == "") {
      this.removeAttribute("persist-key");
    } else {
      this.setAttribute("persist-key", value);
    }
  }

  get placeholder() {
    return this.getAttribute("placeholder") ?? "";
  }

  set placeholder(value: string) {
    if (value) {
      this.setAttribute("placeholder", value);
    } else {
      this.removeAttribute("placeholder");
    }
  }

  get readOnly() {
    return this.hasAttribute("readonly");
  }

  set readOnly(value: boolean) {
    this.toggleAttribute("readonly", value);
  }

  get value() {
    return this.controller?.value ?? this.storedValue;
  }

  set value(value: string) {
    this.explicitValue = true;
    this.storedValue = String(value);
    if (this.controller) {
      this.controller.setValue(this.storedValue);
    } else {
      this.clampStoredSelection();
    }
  }

  get view(): EditorView | null {
    return this.controller?.view ?? null;
  }

  get dirty() {
    return this.cleanValue != null && this.value != this.cleanValue;
  }

  get selectionStart() {
    return this.currentSelection().start;
  }

  set selectionStart(value: number) {
    let start = normalizeSelectionPosition(value, this.value.length);
    let end = this.selectionEnd;
    if (start > end) end = start;
    this.setSelectionRange(start, end);
  }

  get selectionEnd() {
    return this.currentSelection().end;
  }

  set selectionEnd(value: number) {
    let end = normalizeSelectionPosition(value, this.value.length);
    let start = this.selectionStart;
    if (end < start) start = end;
    this.setSelectionRange(start, end);
  }

  override focus() {
    this.view?.focus();
  }

  override blur() {
    this.view?.contentDOM.blur();
  }

  markClean() {
    this.cleanValue = this.value;
  }

  setSelectionRange(start: number, end: number) {
    let selection = normalizeSelectionRange(start, end, this.value.length);
    if (!this.controller) {
      this.updateStoredSelection(selection.start, selection.end, true);
      return;
    }

    let main = this.controller.view.state.selection.main;
    if (main.from == selection.start && main.to == selection.end) return;

    this.controller.view.dispatch({
      scrollIntoView: true,
      selection: { anchor: selection.start, head: selection.end },
      userEvent: "select",
    });
  }

  select() {
    this.setSelectionRange(0, this.value.length);
  }

  private handleEditorInput(value: string) {
    this.storedValue = value;
    this.dirtySinceChange = true;
    this.dispatchEvent(createInputEvent());
  }

  private dispatchPendingChange() {
    if (!this.dirtySinceChange) return;
    this.dirtySinceChange = false;
    this.dispatchEvent(
      new Event("change", {
        bubbles: true,
        composed: true,
      }),
    );
  }

  private dispatchLiveMdError(error: unknown) {
    this.dispatchEvent(
      new CustomEvent("live-md-error", {
        bubbles: true,
        composed: true,
        detail: { error },
      }),
    );
  }

  private handleEditorSelection(update: ViewUpdate) {
    if (!update.docChanged && !update.selectionSet) return;
    let main = update.state.selection.main;
    this.updateStoredSelection(main.from, main.to, update.selectionSet && !update.docChanged);
  }

  private applyStoredSelection() {
    if (!this.controller) return;
    let selection = normalizeSelectionRange(
      this.storedSelectionStart,
      this.storedSelectionEnd,
      this.controller.value.length,
    );
    this.storedSelectionStart = selection.start;
    this.storedSelectionEnd = selection.end;

    let main = this.controller.view.state.selection.main;
    if (main.from == selection.start && main.to == selection.end) return;

    this.controller.view.dispatch({
      selection: { anchor: selection.start, head: selection.end },
      userEvent: "select.restore",
    });
  }

  private clampStoredSelection() {
    let selection = normalizeSelectionRange(
      this.storedSelectionStart,
      this.storedSelectionEnd,
      this.storedValue.length,
    );
    this.storedSelectionStart = selection.start;
    this.storedSelectionEnd = selection.end;
  }

  private currentSelection() {
    if (this.controller) {
      let main = this.controller.view.state.selection.main;
      return { end: main.to, start: main.from };
    }
    return normalizeSelectionRange(
      this.storedSelectionStart,
      this.storedSelectionEnd,
      this.storedValue.length,
    );
  }

  private storeCurrentSelection() {
    let main = this.controller?.view.state.selection.main;
    if (!main) return;
    this.storedSelectionStart = main.from;
    this.storedSelectionEnd = main.to;
  }

  private updateStoredSelection(start: number, end: number, emit: boolean) {
    if (this.storedSelectionStart == start && this.storedSelectionEnd == end) return;
    this.storedSelectionStart = start;
    this.storedSelectionEnd = end;
    if (emit) this.dispatchEvent(createSelectEvent());
  }
}

export function defineLiveMdEditor(tagName = "live-md-editor") {
  if (!globalThis.customElements) {
    throw new Error("Custom elements are not available in this environment");
  }
  if (!customElements.get(tagName)) {
    let constructor =
      tagName == "live-md-editor" ? LiveMdEditorElement : class extends LiveMdEditorElement {};
    customElements.define(tagName, constructor);
  }
}

function createInputEvent() {
  if (typeof InputEvent == "function") {
    return new InputEvent("input", {
      bubbles: true,
      composed: true,
    });
  }
  return new Event("input", {
    bubbles: true,
    composed: true,
  });
}

function createSelectEvent() {
  return new Event("select", {
    bubbles: true,
    composed: true,
  });
}

function normalizeSelectionRange(start: number, end: number, length: number) {
  let normalizedStart = normalizeSelectionPosition(start, length);
  let normalizedEnd = normalizeSelectionPosition(end, length);
  if (normalizedEnd < normalizedStart) normalizedStart = normalizedEnd;
  return { end: normalizedEnd, start: normalizedStart };
}

function normalizeSelectionPosition(value: number, length: number) {
  let position = Number(value);
  if (Number.isNaN(position)) return 0;
  if (position == Infinity) return length;
  if (position == -Infinity) return 0;
  position = Math.trunc(position);
  return Math.min(length, Math.max(0, position));
}

function normalizeLightDomMarkdown(text: string) {
  let lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && !lines[0]?.trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1]?.trim()) lines.pop();
  let indent = Math.min(
    ...lines.filter((line) => line.trim()).map((line) => line.match(/^\s*/)?.[0].length ?? 0),
  );
  if (!Number.isFinite(indent)) return "";
  return lines.map((line) => line.slice(indent)).join("\n");
}
