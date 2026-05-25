import runtimeStyles from "../style.css?raw";

let runtimeSheet: CSSStyleSheet | null = null;

export function installTyporaStyles(root: ShadowRoot) {
  if ("adoptedStyleSheets" in root && "replaceSync" in CSSStyleSheet.prototype) {
    runtimeSheet ??= new CSSStyleSheet();
    if (runtimeSheet.cssRules.length == 0) runtimeSheet.replaceSync(runtimeStyles);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, runtimeSheet];
    return;
  }

  let style = document.createElement("style");
  style.dataset.typoraRuntime = "";
  style.textContent = runtimeStyles;
  root.append(style);
}
