import { Facet, type Extension } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import { normalizeLiveMdLinkBaseUrl, resolveLiveMdLinkDestination } from "./link-destination.js";

const shiftHoverClass = "cm-md-link-shift-hover";
const interactiveLinkDecorationSpec = Symbol("liveMdInteractiveLinkDecoration");
const linkMarkCacheLimit = 256;
const linkMarkCache = new Map<string, Decoration>();
const plainLinkMark = Decoration.mark({ class: "cm-md-link" });

type InteractiveLinkDecorationSpec = {
  [interactiveLinkDecorationSpec]?: true;
};

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
  let href = resolveLiveMdLinkHref(destination, baseUrl);
  if (!href) return plainLinkMark;

  let cached = linkMarkCache.get(href);
  if (cached) {
    linkMarkCache.delete(href);
    linkMarkCache.set(href, cached);
  } else {
    cached = Decoration.mark({
      attributes: {
        "data-live-md-href": href,
      },
      class: "cm-md-link",
      [interactiveLinkDecorationSpec]: true,
    } as Parameters<typeof Decoration.mark>[0] & InteractiveLinkDecorationSpec);
    linkMarkCache.set(href, cached);
    if (linkMarkCache.size > linkMarkCacheLimit) {
      linkMarkCache.delete(linkMarkCache.keys().next().value!);
    }
  }
  return cached;
}

export function __testLiveMdLinkMarkCacheSize() {
  return linkMarkCache.size;
}

export function __testClearLiveMdLinkMarkCache() {
  linkMarkCache.clear();
}

export function resolveLiveMdLinkHref(
  destination: null | string | undefined,
  baseUrl: null | string,
) {
  return normalizeLiveMdLinkDestination(destination, baseUrl);
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

export function isLiveMdInteractiveLinkDecoration(decoration: Decoration) {
  return (decoration.spec as InteractiveLinkDecorationSpec)[interactiveLinkDecorationSpec] === true;
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
  return resolveLiveMdLinkDestination(source, baseUrl);
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
