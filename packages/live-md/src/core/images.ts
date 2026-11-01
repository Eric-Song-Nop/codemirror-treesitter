import { Facet, type Extension } from "@codemirror/state";
import { hasControlCharacter, unescapeMarkdownPunctuation } from "./markdown-text.js";

export type LiveMdResolvedImageSource = {
  height?: number;
  src: string;
  width?: number;
};

export type LiveMdImageSourceResolverResult =
  | string
  | URL
  | {
      height?: number;
      src: string | URL;
      width?: number;
    };

export type LiveMdImageSourceResolver = (
  source: string,
) => LiveMdImageSourceResolverResult | null | undefined;

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
): LiveMdResolvedImageSource {
  let normalized = normalizeMarkdownImageSource(source);
  if (!normalized) return { src: "" };

  let resolved = resolver?.(normalized);
  if (resolved == null) return { src: normalized };
  if (resolved instanceof URL) return { src: resolved.href };
  if (typeof resolved == "object") {
    return {
      height: normalizeImageDimension(resolved.height),
      src: resolved.src instanceof URL ? resolved.src.href : String(resolved.src).trim(),
      width: normalizeImageDimension(resolved.width),
    };
  }
  return { src: String(resolved).trim() };
}

export function normalizeMarkdownImageSource(source: string) {
  let value = source.trim();
  if (value.length >= 2 && value[0] == "<" && value.at(-1) == ">") {
    value = value.slice(1, -1).trim();
  }
  if (hasControlCharacter(value)) return "";
  return unescapeMarkdownPunctuation(value);
}

function normalizeImageDimension(value: number | undefined) {
  if (typeof value != "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value);
}
