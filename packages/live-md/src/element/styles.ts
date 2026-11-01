import { addKatexLoadDependency } from "../core/latex.js";
import runtimeStyles from "../style.css?raw";

type KatexStyles = typeof import("./katex-styles.js");

const runtimeCss = stripKatexImport(runtimeStyles);

let katexRules = "";
let katexFontFaces = "";
let katexStylesRequested = false;
let sharedSheet: CSSStyleSheet | null | undefined;
const fallbackStyles = new Set<WeakRef<HTMLStyleElement>>();
const fontDocuments = new WeakSet<Document>();

/**
 * Install LiveMD's runtime CSS into a shadow root. Every root adopts one shared
 * constructed stylesheet when supported, with a `<style>` fallback. KaTeX CSS
 * is added to that shared sheet only after KaTeX itself loads, which happens on
 * the first math node.
 */
export function installLiveMdStyles(root: ShadowRoot) {
  requestKatexStylesWhenNeeded();
  installKatexFontFaces(root.ownerDocument);
  if (adoptSharedSheet(root)) return;
  if (root.querySelector("style[data-live-md-runtime]")) return;

  let style = root.ownerDocument.createElement("style");
  style.dataset.liveMdRuntime = "";
  style.textContent = combinedCss();
  root.append(style);
  fallbackStyles.add(new WeakRef(style));
}

function adoptSharedSheet(root: ShadowRoot) {
  let sheet = liveMdSharedSheet();
  if (!sheet || !("adoptedStyleSheets" in root)) return false;
  if (root.adoptedStyleSheets.includes(sheet)) return true;
  try {
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
    return true;
  } catch {
    // Constructed sheets cannot be shared across documents (for example iframes).
    return false;
  }
}

/** The constructed sheet shared by every editor shadow root, or null when unsupported. */
export function liveMdSharedSheet() {
  if (sharedSheet !== undefined) return sharedSheet;
  sharedSheet = null;
  try {
    if (typeof CSSStyleSheet == "function" && "replaceSync" in CSSStyleSheet.prototype) {
      let sheet = new CSSStyleSheet();
      sheet.replaceSync(combinedCss());
      sharedSheet = sheet;
    }
  } catch {
    sharedSheet = null;
  }
  return sharedSheet;
}

function combinedCss() {
  return katexRules ? `${katexRules}\n${runtimeCss}` : runtimeCss;
}

function requestKatexStylesWhenNeeded() {
  if (katexStylesRequested) return;
  katexStylesRequested = true;
  // Fetched together with KaTeX so rendered math never appears unstyled.
  addKatexLoadDependency(() => import("./katex-styles.js").then(applyKatexStyles));
}

function applyKatexStyles(styles: KatexStyles) {
  katexRules = styles.katexRuleCss;
  katexFontFaces = styles.katexFontFaceCss;
  let css = combinedCss();
  try {
    sharedSheet?.replaceSync(css);
  } catch {}
  for (let reference of fallbackStyles) {
    let style = reference.deref();
    if (style) style.textContent = css;
    else fallbackStyles.delete(reference);
  }
  if (typeof document != "undefined") installKatexFontFaces(document);
}

function installKatexFontFaces(ownerDocument: Document) {
  if (!katexFontFaces || fontDocuments.has(ownerDocument)) return;
  fontDocuments.add(ownerDocument);
  try {
    let view = ownerDocument.defaultView as (Window & typeof globalThis) | null;
    if (view && typeof view.CSSStyleSheet == "function" && "adoptedStyleSheets" in ownerDocument) {
      let sheet = new view.CSSStyleSheet();
      sheet.replaceSync(katexFontFaces);
      ownerDocument.adoptedStyleSheets = [...ownerDocument.adoptedStyleSheets, sheet];
      return;
    }
  } catch {}
  let style = ownerDocument.createElement("style");
  style.dataset.liveMdKatexFonts = "";
  style.textContent = katexFontFaces;
  ownerDocument.head?.append(style);
}

function stripKatexImport(css: string) {
  return css.replace(/^\s*@import\s+(?:url\()?["']katex\/dist\/katex\.css["']\)?;\s*/u, "");
}
