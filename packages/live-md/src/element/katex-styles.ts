import katexCss from "katex/dist/katex.css?raw";

const fontFacePattern = /@font-face\s*\{[^}]*\}/gu;

/**
 * KaTeX's `@font-face` rules. Shadow-root stylesheets cannot declare fonts in
 * every browser, so these are installed at document scope.
 */
export const katexFontFaceCss = (katexCss.match(fontFacePattern) ?? []).join("\n");

/** KaTeX's layout rules without font faces, adopted by each editor shadow root. */
export const katexRuleCss = katexCss.replace(fontFacePattern, "").trim();
