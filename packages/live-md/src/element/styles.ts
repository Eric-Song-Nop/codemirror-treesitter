import katexStyles from "katex/dist/katex.css?raw";
import runtimeStyles from "../style.css?raw";

const combinedStyles = `${katexStyles}\n${stripKatexImport(runtimeStyles)}`;

export function installLiveMdStyles(root: ShadowRoot) {
  if (root.querySelector("style[data-live-md-runtime]")) return;

  let style = document.createElement("style");
  style.dataset.liveMdRuntime = "";
  style.textContent = combinedStyles;
  root.append(style);
}

function stripKatexImport(css: string) {
  return css.replace(/^\s*@import\s+(?:url\()?["']katex\/dist\/katex\.css["']\)?;\s*/u, "");
}
