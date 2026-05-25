import { EditorView } from "@codemirror/view";
import { createTyporaEditor, type TyporaEditorController } from "../core/editor.js";
import { installTyporaStyles } from "./styles.js";

export class TyporaEditorElement extends HTMLElement {
  static observedAttributes = [
    "autofocus",
    "default-value",
    "persist-key",
    "placeholder",
    "readonly",
  ];

  private controller: TyporaEditorController | null = null;
  private dirtySinceChange = false;
  private explicitValue = false;
  private mount: HTMLDivElement;
  private shadow: ShadowRoot;
  private storedDefaultValue: string | null = null;
  private storedValue = "";

  ready: Promise<void> = Promise.resolve();

  constructor() {
    super();
    this.shadow = this.attachShadow({ mode: "open" });
    installTyporaStyles(this.shadow);

    this.mount = document.createElement("div");
    this.mount.className = "typora-editor-root";
    this.mount.setAttribute("part", "editor");
    this.shadow.append(this.mount);
  }

  connectedCallback() {
    if (this.controller) return;

    let initialValue = this.explicitValue ? this.storedValue : this.defaultValue;
    let controller: TyporaEditorController;
    try {
      controller = createTyporaEditor({
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
      });
    } catch (error: unknown) {
      this.ready = Promise.reject(error);
      this.dispatchTyporaError(error);
      return;
    }

    this.controller = controller;
    this.ready = controller.ready
      .then(() => {
        if (this.controller != controller) return;
        this.dispatchEvent(
          new CustomEvent("typora-ready", {
            bubbles: true,
            composed: true,
            detail: { view: this.view },
          }),
        );
      })
      .catch((error: unknown) => {
        if (this.controller == controller) this.dispatchTyporaError(error);
        throw error;
      });
  }

  disconnectedCallback() {
    if (!this.controller) return;
    this.storedValue = this.controller.value;
    this.explicitValue = true;
    this.controller.destroy();
    this.controller = null;
  }

  attributeChangedCallback(name: string, oldValue: string | null, newValue: string | null) {
    if (oldValue == newValue) return;
    switch (name) {
      case "default-value":
        this.storedDefaultValue = newValue;
        if (!this.controller && !this.explicitValue) this.storedValue = this.defaultValue;
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
    if (!this.controller && !this.explicitValue) this.storedValue = this.storedDefaultValue;
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
    this.controller?.setValue(this.storedValue);
  }

  get view(): EditorView | null {
    return this.controller?.view ?? null;
  }

  override focus() {
    this.view?.focus();
  }

  override blur() {
    this.view?.contentDOM.blur();
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

  private dispatchTyporaError(error: unknown) {
    this.dispatchEvent(
      new CustomEvent("typora-error", {
        bubbles: true,
        composed: true,
        detail: { error },
      }),
    );
  }
}

export function defineTyporaEditor(tagName = "typora-editor") {
  if (!globalThis.customElements) {
    throw new Error("Custom elements are not available in this environment");
  }
  if (!customElements.get(tagName)) {
    let constructor =
      tagName == "typora-editor" ? TyporaEditorElement : class extends TyporaEditorElement {};
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
