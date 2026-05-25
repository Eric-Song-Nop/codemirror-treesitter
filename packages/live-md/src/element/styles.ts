import runtimeStyles from "../style.css?raw";

let runtimeSheet: CSSStyleSheet | null = null;

export function installLiveMdStyles(root: ShadowRoot) {
  if ("adoptedStyleSheets" in root && "replaceSync" in CSSStyleSheet.prototype) {
    runtimeSheet ??= new CSSStyleSheet();
    if (runtimeSheet.cssRules.length == 0) runtimeSheet.replaceSync(runtimeStyles);
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, runtimeSheet];
    return;
  }

  let style = document.createElement("style");
  style.dataset.liveMdRuntime = "";
  style.textContent = runtimeStyles;
  root.append(style);
}
