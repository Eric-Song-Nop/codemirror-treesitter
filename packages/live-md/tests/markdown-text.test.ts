import { describe, expect, it } from "vite-plus/test";
import { normalizeMarkdownImageSource } from "../src/core/images.js";
import { sanitizeLiveMdLinkDestination } from "../src/core/link-destination.js";
import {
  firstToken,
  keyParts,
  normalizeFenceLanguage,
  unescapeMarkdownPunctuation,
} from "../src/core/markdown-text.js";

describe("unescapeMarkdownPunctuation", () => {
  it("unescapes every ASCII punctuation character", () => {
    let punctuation = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
    let escaped = Array.from(punctuation, (char) => `\\${char}`).join("");

    expect(unescapeMarkdownPunctuation(escaped)).toBe(punctuation);
  });

  it("keeps backslashes before non-punctuation characters (CommonMark example 13)", () => {
    expect(unescapeMarkdownPunctuation("\\a\\A\\1\\ \\é\\→")).toBe("\\a\\A\\1\\ \\é\\→");
  });

  it("treats an escaped backslash as one literal backslash", () => {
    expect(unescapeMarkdownPunctuation("\\\\*")).toBe("\\*");
    expect(unescapeMarkdownPunctuation("trailing\\")).toBe("trailing\\");
  });

  it("applies the same rule to link destinations and image sources", () => {
    expect(sanitizeLiveMdLinkDestination("notes/a\\_b\\q.md")).toBe("notes/a_b\\q.md");
    expect(normalizeMarkdownImageSource("img/a\\_b\\q.png")).toBe("img/a_b\\q.png");
  });
});

describe("fence language helpers", () => {
  it("normalizes attribute-style info strings to a lowercase token", () => {
    expect(normalizeFenceLanguage(" {.Mermaid} title")).toBe("mermaid");
    expect(normalizeFenceLanguage("TS\tlinenums")).toBe("ts");
    expect(firstToken("js extra")).toBe("js");
  });

  it("builds unambiguous composite keys", () => {
    expect(keyParts("a|1:b")).not.toBe(keyParts("a", "b"));
    expect(keyParts(null, undefined, true, 2)).toBe("0:|0:|4:true|1:2");
  });
});
