import { Facet, type Extension } from "@codemirror/state";

export type LiveMdImageSourceResolver = (source: string) => null | string | URL | undefined;

export const liveMdImageSourceResolver = Facet.define<
  LiveMdImageSourceResolver,
  LiveMdImageSourceResolver | null
>({
  combine(values) {
    return values.at(-1) ?? null;
  },
});

export function liveMdImageSource(
  resolver: LiveMdImageSourceResolver | null | undefined,
): Extension {
  return resolver ? liveMdImageSourceResolver.of(resolver) : [];
}

export function resolveLiveMdImageSource(
  source: string,
  resolver: LiveMdImageSourceResolver | null,
) {
  let normalized = normalizeMarkdownImageSource(source);
  if (!normalized) return "";

  let resolved = resolver?.(normalized);
  if (resolved == null) return normalized;
  return resolved instanceof URL ? resolved.href : String(resolved).trim();
}

export function normalizeMarkdownImageSource(source: string) {
  let value = source.trim();
  if (value.length >= 2 && value[0] == "<" && value.at(-1) == ">") {
    value = value.slice(1, -1).trim();
  }
  if (hasControlCharacter(value)) return "";
  return unescapeMarkdownPunctuation(value);
}

function hasControlCharacter(value: string) {
  for (let index = 0; index < value.length; index++) {
    let code = value.charCodeAt(index);
    if (code < 32 || code == 127) return true;
  }
  return false;
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
