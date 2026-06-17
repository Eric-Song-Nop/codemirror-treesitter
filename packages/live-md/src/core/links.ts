import { Facet, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";

const allowedLinkProtocols = new Set(["http:", "https:", "mailto:", "tel:"]);
const allowedBaseProtocols = new Set(["http:", "https:"]);
const shiftHoverClass = "cm-md-link-shift-hover";
const linkMarkCache = new Map<string, Decoration>();
const plainLinkMark = Decoration.mark({ class: "cm-md-link" });

export type LiveMdLinkBaseUrl = string | URL;
export type LiveMdLinkOpenHandler = (href: string) => void;

export const liveMdLinkBaseUrl = Facet.define<string, string | null>({
  combine(values) {
    return values.at(-1) ?? null;
  },
});

const liveMdLinkOpenHandler = Facet.define<LiveMdLinkOpenHandler, LiveMdLinkOpenHandler>({
  combine(values) {
    return values.at(-1) ?? openLiveMdLinkInNewContext;
  },
});

export function liveMdLinkBase(baseUrl: LiveMdLinkBaseUrl | null | undefined): Extension {
  let normalized = normalizeLiveMdLinkBaseUrl(baseUrl);
  return normalized ? liveMdLinkBaseUrl.of(normalized) : [];
}

export function liveMdLinkOpen(handler: LiveMdLinkOpenHandler | null | undefined): Extension {
  return handler ? liveMdLinkOpenHandler.of(handler) : [];
}

export function liveMdLinkMark(destination: null | string | undefined, baseUrl: null | string) {
  let href = normalizeLiveMdLinkDestination(destination, baseUrl);
  if (!href) return plainLinkMark;

  let cached = linkMarkCache.get(href);
  if (!cached) {
    cached = Decoration.mark({
      attributes: {
        "data-live-md-href": href,
      },
      class: "cm-md-link",
    });
    linkMarkCache.set(href, cached);
  }
  return cached;
}

export function liveMdLinkInteractions(): Extension {
  return [
    liveMdShiftHoverCursor,
    EditorView.domEventHandlers({
      mousedown(event) {
        if (!event.shiftKey || !eventLiveMdLink(event)) return false;
        event.preventDefault();
        return true;
      },
      click(event, view) {
        let link = eventLiveMdLink(event);
        if (!link || !event.shiftKey) return false;

        event.preventDefault();
        view.state.facet(liveMdLinkOpenHandler)(link.dataset.liveMdHref!);
        return true;
      },
    }),
  ];
}

const liveMdShiftHoverCursor = ViewPlugin.fromClass(
  class {
    private hoveredLink: HTMLElement | null = null;
    private shiftPressed = false;

    destroy() {
      this.setHoveredLink(null);
    }

    onMouseMove(event: MouseEvent) {
      this.setHoveredLink(eventLiveMdLink(event));
      this.setShiftPressed(event.shiftKey);
    }

    onMouseLeave() {
      this.setHoveredLink(null);
    }

    onKeyDown(event: KeyboardEvent) {
      if (event.key == "Shift") this.setShiftPressed(true);
    }

    onKeyUp(event: KeyboardEvent) {
      if (event.key == "Shift") this.setShiftPressed(false);
    }

    onBlur() {
      this.setShiftPressed(false);
    }

    private setHoveredLink(link: HTMLElement | null) {
      if (link == this.hoveredLink) return;
      this.hoveredLink?.classList.remove(shiftHoverClass);
      this.hoveredLink = link;
      this.sync();
    }

    private setShiftPressed(pressed: boolean) {
      if (pressed == this.shiftPressed) return;
      this.shiftPressed = pressed;
      this.sync();
    }

    private sync() {
      this.hoveredLink?.classList.toggle(shiftHoverClass, this.shiftPressed);
    }
  },
  {
    eventHandlers: {
      blur() {
        this.onBlur();
      },
      keydown(event) {
        this.onKeyDown(event);
      },
      keyup(event) {
        this.onKeyUp(event);
      },
      mouseleave() {
        this.onMouseLeave();
      },
      mousemove(event) {
        this.onMouseMove(event);
      },
      mouseover(event) {
        this.onMouseMove(event);
      },
    },
  },
);

function normalizeLiveMdLinkDestination(source: null | string | undefined, baseUrl: null | string) {
  let destination = normalizeMarkdownDestination(source);
  if (!destination || hasControlCharacter(destination)) return null;

  let absolute = parseAbsoluteLinkDestination(destination);
  if (absolute !== undefined) return absolute;
  if (!baseUrl) return null;

  try {
    let parsed = new URL(destination, baseUrl);
    return allowedLinkProtocols.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function parseAbsoluteLinkDestination(destination: string) {
  try {
    let parsed = new URL(destination);
    return allowedLinkProtocols.has(parsed.protocol) ? destination : null;
  } catch {
    return undefined;
  }
}

function normalizeLiveMdLinkBaseUrl(baseUrl: LiveMdLinkBaseUrl | null | undefined) {
  let source = baseUrl instanceof URL ? baseUrl.href : baseUrl?.trim();
  if (!source || hasControlCharacter(source)) return null;

  try {
    let parsed = new URL(source);
    return allowedBaseProtocols.has(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

function hasControlCharacter(value: string) {
  for (let index = 0; index < value.length; index++) {
    let code = value.charCodeAt(index);
    if (code < 32 || code == 127) return true;
  }
  return false;
}

function normalizeMarkdownDestination(source: null | string | undefined) {
  let destination = source?.trim() ?? "";
  if (destination.length >= 2 && destination[0] == "<" && destination.at(-1) == ">") {
    destination = destination.slice(1, -1).trim();
  }
  return unescapeMarkdownPunctuation(destination);
}

function unescapeMarkdownPunctuation(value: string) {
  let result = "";
  for (let index = 0; index < value.length; index++) {
    let char = value[index];
    if (char == "\\" && index + 1 < value.length) {
      result += value[++index];
    } else {
      result += char;
    }
  }
  return result;
}

function eventLiveMdLink(event: MouseEvent) {
  let target = event.target;
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(".cm-md-link[data-live-md-href]");
}

function openLiveMdLinkInNewContext(href: string) {
  if (typeof globalThis.open != "function") return;
  globalThis.open(href, "_blank", "noopener,noreferrer");
}
