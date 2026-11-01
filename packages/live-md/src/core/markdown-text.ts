import { isWhitespace } from "./util.js";

const asciiPunctuationEscape = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g;

/**
 * Remove backslash escapes the way CommonMark does: only ASCII punctuation can
 * be escaped, so `\*` becomes `*` while `\a` keeps its backslash.
 */
export function unescapeMarkdownPunctuation(value: string) {
  return value.replace(asciiPunctuationEscape, "$1");
}

/** True when the value contains a C0 control character or DEL. */
export function hasControlCharacter(value: string) {
  for (let index = 0; index < value.length; index++) {
    let code = value.charCodeAt(index);
    if (code < 32 || code == 127) return true;
  }
  return false;
}

/** Normalize a fence info string to its lowercase language token (`{.mermaid}` -> `mermaid`). */
export function normalizeFenceLanguage(language: string) {
  let token = firstToken(language.trim());
  if (token.startsWith("{")) token = token.slice(1);
  if (token.startsWith(".")) token = token.slice(1);
  if (token.endsWith("}")) token = token.slice(0, -1);
  return token.toLowerCase();
}

export function isMermaidFenceLanguage(language: string) {
  return language == "mermaid" || language == "mmd";
}

/** The leading run of non-whitespace characters (space, tab, CR, LF delimit). */
export function firstToken(value: string) {
  for (let index = 0; index < value.length; index++) {
    if (isWhitespace(value.charCodeAt(index))) return value.slice(0, index);
  }
  return value;
}

/** Join key parts with length prefixes so distinct part lists never collide. */
export function keyParts(...parts: readonly (boolean | number | string | null | undefined)[]) {
  return parts
    .map((part) => {
      let text = part == null ? "" : String(part);
      return `${text.length}:${text}`;
    })
    .join("|");
}
