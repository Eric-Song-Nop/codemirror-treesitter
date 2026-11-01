// Allowlist sanitizer shared by the editor widget and HTML export Mermaid paths.

export type SanitizedMermaidSvg =
  | {
      ok: true;
      svg: string;
    }
  | {
      message: string;
      ok: false;
    };

const svgNamespace = "http://www.w3.org/2000/svg";

const safeMermaidSvgElements = new Set([
  "a",
  "circle",
  "clippath",
  "defs",
  "desc",
  "ellipse",
  "feblend",
  "fecolormatrix",
  "fecomposite",
  "fedropshadow",
  "feflood",
  "fegaussianblur",
  "femerge",
  "femergenode",
  "feoffset",
  "filter",
  "g",
  "line",
  "lineargradient",
  "marker",
  "mask",
  "path",
  "pattern",
  "polygon",
  "polyline",
  "radialgradient",
  "rect",
  "stop",
  "style",
  "svg",
  "symbol",
  "text",
  "textpath",
  "title",
  "tspan",
  "use",
]);

const safeMermaidSvgAttributes = new Set([
  "accent-height",
  "alignment-baseline",
  "baseline-shift",
  "clip-path",
  "clip-rule",
  "color",
  "color-interpolation",
  "color-interpolation-filters",
  "cx",
  "cy",
  "d",
  "direction",
  "display",
  "dominant-baseline",
  "dx",
  "dy",
  "fill",
  "fill-opacity",
  "fill-rule",
  "filter",
  "flood-color",
  "flood-opacity",
  "font-family",
  "font-size",
  "font-stretch",
  "font-style",
  "font-variant",
  "font-weight",
  "height",
  "href",
  "id",
  "letter-spacing",
  "marker-end",
  "marker-mid",
  "marker-start",
  "markerheight",
  "markerunits",
  "markerwidth",
  "mask",
  "offset",
  "opacity",
  "orient",
  "overflow",
  "paint-order",
  "pathlength",
  "patterncontentunits",
  "patternunits",
  "points",
  "preserveaspectratio",
  "r",
  "refx",
  "refy",
  "rx",
  "ry",
  "shape-rendering",
  "spreadmethod",
  "stop-color",
  "stop-opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "style",
  "tabindex",
  "target",
  "text-anchor",
  "text-decoration",
  "text-rendering",
  "transform",
  "vector-effect",
  "viewbox",
  "visibility",
  "width",
  "x",
  "x1",
  "x2",
  "xlink:href",
  "xmlns",
  "xmlns:xlink",
  "y",
  "y1",
  "y2",
]);

const safeMermaidSvgStyleProperties = new Set([
  "alignment-baseline",
  "baseline-shift",
  "clip-path",
  "clip-rule",
  "color",
  "display",
  "dominant-baseline",
  "fill",
  "fill-opacity",
  "fill-rule",
  "filter",
  "flood-color",
  "flood-opacity",
  "font-family",
  "font-size",
  "font-stretch",
  "font-style",
  "font-variant",
  "font-weight",
  "letter-spacing",
  "marker-end",
  "marker-mid",
  "marker-start",
  "mask",
  "opacity",
  "overflow",
  "paint-order",
  "shape-rendering",
  "stop-color",
  "stop-opacity",
  "stroke",
  "stroke-dasharray",
  "stroke-dashoffset",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-miterlimit",
  "stroke-opacity",
  "stroke-width",
  "text-anchor",
  "text-decoration",
  "text-rendering",
  "transform",
  "vector-effect",
  "visibility",
]);

/**
 * Sanitize Mermaid SVG markup for the HTML export path, returning serialized
 * markup built only from allowlisted elements, attributes, and CSS.
 */
export function sanitizeMermaidSvg(svg: string): SanitizedMermaidSvg {
  if (typeof XMLSerializer == "undefined") {
    return { message: "SVG sanitizer is unavailable", ok: false };
  }
  let parsed = parseMermaidSvgDocument(svg);
  if (!parsed.ok) return parsed;
  let sanitized = sanitizeSvgElement(parsed.document, parsed.document.documentElement);
  if (!sanitized) return { message: "Unable to sanitize Mermaid SVG", ok: false };
  return {
    ok: true,
    svg: new XMLSerializer().serializeToString(sanitized),
  };
}

export type SanitizedMermaidSvgElement =
  | {
      element: Element;
      ok: true;
    }
  | {
      message: string;
      ok: false;
    };

/**
 * Sanitize Mermaid SVG markup for the live editor, rebuilding the allowlisted
 * tree directly in `target` so no unsanitized node is ever imported into it.
 */
export function sanitizeMermaidSvgElement(
  svg: string,
  target: Document,
): SanitizedMermaidSvgElement {
  let parsed = parseMermaidSvgDocument(svg);
  if (!parsed.ok) return parsed;
  let element = sanitizeSvgElement(target, parsed.document.documentElement);
  if (!element) return { message: "Unable to sanitize Mermaid SVG", ok: false };
  return { element, ok: true };
}

function parseMermaidSvgDocument(
  svg: string,
): { document: Document; ok: true } | { message: string; ok: false } {
  if (typeof DOMParser == "undefined") {
    return { message: "SVG sanitizer is unavailable", ok: false };
  }
  let parsed = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (parsed.querySelector("parsererror")) {
    return { message: "Unable to parse Mermaid SVG", ok: false };
  }
  if (parsed.documentElement.localName.toLowerCase() != "svg") {
    return { message: "Mermaid renderer returned non-SVG output", ok: false };
  }
  return { document: parsed, ok: true };
}

function sanitizeSvgElement(owner: Document, element: Element): Element | null {
  let elementName = element.localName.toLowerCase();
  if (!safeMermaidSvgElements.has(elementName)) return null;

  let sanitized = owner.createElementNS(svgNamespace, element.localName);
  for (let attribute of Array.from(element.attributes)) {
    let safeAttribute = sanitizeSvgAttribute(attribute, elementName);
    if (!safeAttribute) continue;
    if (attribute.namespaceURI) {
      sanitized.setAttributeNS(attribute.namespaceURI, attribute.name, safeAttribute.value);
    } else {
      sanitized.setAttribute(attribute.name, safeAttribute.value);
    }
  }

  if (elementName == "style") {
    let styleText = sanitizeSvgStyleText(element.textContent ?? "");
    if (!styleText) return null;
    sanitized.textContent = styleText;
    return sanitized;
  }

  for (let child of Array.from(element.childNodes)) {
    let sanitizedChild = sanitizeSvgNode(owner, child);
    if (sanitizedChild) sanitized.append(sanitizedChild);
  }
  return sanitized;
}

function sanitizeSvgNode(owner: Document, node: ChildNode) {
  if (node.nodeType == 1 && node instanceof Element) return sanitizeSvgElement(owner, node);
  if (node.nodeType == 3 || node.nodeType == 4) {
    return owner.createTextNode(node.textContent ?? "");
  }
  return null;
}

function sanitizeSvgAttribute(attribute: Attr, elementName: string) {
  let name = attribute.name;
  let lowerName = name.toLowerCase();
  if (lowerName.startsWith("on")) return null;
  if (lowerName.startsWith("aria-") || lowerName.startsWith("data-")) {
    return isSafeSvgAttributeValue(attribute.value) ? { name, value: attribute.value } : null;
  }
  if (!safeMermaidSvgAttributes.has(lowerName)) return null;

  if (lowerName == "style") {
    let value = sanitizeSvgStyleAttribute(attribute.value);
    return value ? { name, value } : null;
  }
  if (lowerName == "href" || lowerName == "xlink:href") {
    return isSafeSvgHref(attribute.value, elementName) ? { name, value: attribute.value } : null;
  }
  return isSafeSvgAttributeValue(attribute.value) ? { name, value: attribute.value } : null;
}

function sanitizeSvgStyleAttribute(style: string) {
  let declarations: string[] = [];
  for (let declaration of style.split(";")) {
    let separator = declaration.indexOf(":");
    if (separator <= 0) continue;
    let property = declaration.slice(0, separator).trim();
    let value = declaration.slice(separator + 1).trim();
    if (!isSafeSvgStyleProperty(property) || !isSafeSvgCssValue(value)) continue;
    declarations.push(`${property}: ${value}`);
  }
  return declarations.join("; ");
}

function sanitizeSvgStyleText(css: string) {
  let sanitized = css.replace(/@import[^;]+;?/giu, "");
  if (containsUnsafeSvgCss(sanitized)) return null;
  return sanitized.trim();
}

function isSafeSvgStyleProperty(property: string) {
  let normalized = property.toLowerCase();
  return /^--[a-z0-9_-]+$/u.test(normalized) || safeMermaidSvgStyleProperties.has(normalized);
}

function isSafeSvgAttributeValue(value: string) {
  return !containsUnsafeSvgCss(value);
}

function isSafeSvgCssValue(value: string) {
  return value.length > 0 && !containsUnsafeSvgCss(value);
}

function containsUnsafeSvgCss(value: string) {
  let compact = compactSvgSecurityValue(value);
  if (
    compact.includes("javascript:") ||
    compact.includes("vbscript:") ||
    compact.includes("data:text/html") ||
    compact.includes("expression(") ||
    compact.includes("<")
  ) {
    return true;
  }
  if (/@(?!supports\b)[a-z-]+/iu.test(value)) return true;
  return !svgCssUrlsAreSafe(value);
}

function svgCssUrlsAreSafe(value: string) {
  for (let match of value.matchAll(/url\(\s*(["']?)(.*?)\1\s*\)/giu)) {
    let url = match[2]?.trim() ?? "";
    if (!url.startsWith("#")) return false;
  }
  return true;
}

function isSafeSvgHref(value: string, elementName: string) {
  let trimmed = value.trim();
  let compact = compactSvgSecurityValue(trimmed);
  if (!compact) return true;
  if (compact.startsWith("#")) return true;
  return (
    elementName == "a" &&
    (compact.startsWith("https://") ||
      compact.startsWith("http://") ||
      compact.startsWith("mailto:") ||
      compact.startsWith("tel:"))
  );
}

function compactSvgSecurityValue(value: string) {
  let compact = "";
  for (let index = 0; index < value.length; index++) {
    let code = value.charCodeAt(index);
    if (code <= 0x20 || code == 0x7f) continue;
    compact += value[index]!.toLowerCase();
  }
  return compact;
}
