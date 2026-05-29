import { Facet, type Extension } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";

const allowedLinkProtocols = new Set(["http:", "https:", "mailto:", "tel:"]);
const allowedBaseProtocols = new Set(["http:", "https:"]);
const linkMarkCache = new Map<string, Decoration>();
const plainLinkMark = Decoration.mark({ class: "cm-md-link" });

export type LiveMdLinkBaseUrl = string | URL;

export const liveMdLinkBaseUrl = Facet.define<string, string | null>({
  combine(values) {
    return values.at(-1) ?? null;
  },
});

export function liveMdLinkBase(baseUrl: LiveMdLinkBaseUrl | null | undefined): Extension {
  let normalized = normalizeLiveMdLinkBaseUrl(baseUrl);
  return normalized ? liveMdLinkBaseUrl.of(normalized) : [];
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
  return EditorView.domEventHandlers({
    mousedown(event) {
      if (!event.shiftKey || !eventLiveMdLink(event)) return false;
      event.preventDefault();
      return true;
    },
    click(event) {
      let link = eventLiveMdLink(event);
      if (!link || !event.shiftKey) return false;

      event.preventDefault();
      openLiveMdLink(link.dataset.liveMdHref!);
      return true;
    },
  });
}

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

function openLiveMdLink(href: string) {
  if (typeof globalThis.open != "function") return;
  globalThis.open(href, "_blank", "noopener,noreferrer");
}
