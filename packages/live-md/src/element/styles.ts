import katexStyles from "katex/dist/katex.css?raw";
import katexAmsRegular from "katex/dist/fonts/KaTeX_AMS-Regular.woff2?url";
import katexCaligraphicBold from "katex/dist/fonts/KaTeX_Caligraphic-Bold.woff2?url";
import katexCaligraphicRegular from "katex/dist/fonts/KaTeX_Caligraphic-Regular.woff2?url";
import katexFrakturBold from "katex/dist/fonts/KaTeX_Fraktur-Bold.woff2?url";
import katexFrakturRegular from "katex/dist/fonts/KaTeX_Fraktur-Regular.woff2?url";
import katexMainBold from "katex/dist/fonts/KaTeX_Main-Bold.woff2?url";
import katexMainBoldItalic from "katex/dist/fonts/KaTeX_Main-BoldItalic.woff2?url";
import katexMainItalic from "katex/dist/fonts/KaTeX_Main-Italic.woff2?url";
import katexMainRegular from "katex/dist/fonts/KaTeX_Main-Regular.woff2?url";
import katexMathBoldItalic from "katex/dist/fonts/KaTeX_Math-BoldItalic.woff2?url";
import katexMathItalic from "katex/dist/fonts/KaTeX_Math-Italic.woff2?url";
import katexSansSerifBold from "katex/dist/fonts/KaTeX_SansSerif-Bold.woff2?url";
import katexSansSerifItalic from "katex/dist/fonts/KaTeX_SansSerif-Italic.woff2?url";
import katexSansSerifRegular from "katex/dist/fonts/KaTeX_SansSerif-Regular.woff2?url";
import katexScriptRegular from "katex/dist/fonts/KaTeX_Script-Regular.woff2?url";
import katexSize1Regular from "katex/dist/fonts/KaTeX_Size1-Regular.woff2?url";
import katexSize2Regular from "katex/dist/fonts/KaTeX_Size2-Regular.woff2?url";
import katexSize3Regular from "katex/dist/fonts/KaTeX_Size3-Regular.woff2?url";
import katexSize4Regular from "katex/dist/fonts/KaTeX_Size4-Regular.woff2?url";
import katexTypewriterRegular from "katex/dist/fonts/KaTeX_Typewriter-Regular.woff2?url";
import runtimeStyles from "../style.css?raw";

const katexFontUrls: Record<string, string> = {
  "KaTeX_AMS-Regular.woff2": katexAmsRegular,
  "KaTeX_Caligraphic-Bold.woff2": katexCaligraphicBold,
  "KaTeX_Caligraphic-Regular.woff2": katexCaligraphicRegular,
  "KaTeX_Fraktur-Bold.woff2": katexFrakturBold,
  "KaTeX_Fraktur-Regular.woff2": katexFrakturRegular,
  "KaTeX_Main-Bold.woff2": katexMainBold,
  "KaTeX_Main-BoldItalic.woff2": katexMainBoldItalic,
  "KaTeX_Main-Italic.woff2": katexMainItalic,
  "KaTeX_Main-Regular.woff2": katexMainRegular,
  "KaTeX_Math-BoldItalic.woff2": katexMathBoldItalic,
  "KaTeX_Math-Italic.woff2": katexMathItalic,
  "KaTeX_SansSerif-Bold.woff2": katexSansSerifBold,
  "KaTeX_SansSerif-Italic.woff2": katexSansSerifItalic,
  "KaTeX_SansSerif-Regular.woff2": katexSansSerifRegular,
  "KaTeX_Script-Regular.woff2": katexScriptRegular,
  "KaTeX_Size1-Regular.woff2": katexSize1Regular,
  "KaTeX_Size2-Regular.woff2": katexSize2Regular,
  "KaTeX_Size3-Regular.woff2": katexSize3Regular,
  "KaTeX_Size4-Regular.woff2": katexSize4Regular,
  "KaTeX_Typewriter-Regular.woff2": katexTypewriterRegular,
};

const combinedStyles = `${rewriteKatexFontUrls(katexStyles)}\n${runtimeStyles}`;

export function installLiveMdStyles(root: ShadowRoot) {
  if (root.querySelector("style[data-live-md-runtime]")) return;

  let style = document.createElement("style");
  style.dataset.liveMdRuntime = "";
  style.textContent = combinedStyles;
  root.append(style);
}

function rewriteKatexFontUrls(css: string) {
  return css.replace(
    /src: url\(fonts\/([^)]*\.woff2)\) format\("woff2"\), url\(fonts\/[^)]*\.woff\) format\("woff"\), url\(fonts\/[^)]*\.ttf\) format\("truetype"\);/g,
    (_match, fileName: string) => {
      let fontUrl = katexFontUrls[fileName];
      return fontUrl
        ? `src: url(${JSON.stringify(fontUrl)}) format("woff2");`
        : `src: url(fonts/${fileName}) format("woff2");`;
    },
  );
}
