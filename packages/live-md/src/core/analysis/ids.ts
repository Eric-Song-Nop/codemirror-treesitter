import type { ChangeDesc, EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@codemirror-treesitter/language";
import { mapLiveMdRange } from "./ranges.js";
import type {
  LiveMdDocRange,
  LiveMdSemanticCapture,
  LiveMdSemanticSource,
  LiveMdSemanticUnit,
  LiveMdUnitId,
} from "./types.js";

const rangeProperties = [
  "altRange",
  "childRange",
  "closeRange",
  "contentRange",
  "delimiterRowRange",
  "destinationRange",
  "languageRange",
  "markerRange",
  "openRange",
  "textRange",
] as const;

const rangeArrayProperties = ["breakRanges"] as const;

export function createLiveMdUnitId(parts: readonly unknown[]): LiveMdUnitId {
  return parts.map(liveMdIdPart).join("|") as LiveMdUnitId;
}

export function liveMdUnitSignature(parts: readonly unknown[]) {
  return parts.map(liveMdIdPart).join("|");
}

export function liveMdSyntaxNodeKey(node: SyntaxNode) {
  return `${node.name}:${node.id}:${node.from}:${node.to}`;
}

export function liveMdOwnerId(kind: string, range: LiveMdDocRange, nodeName = "owner") {
  return createLiveMdUnitId(["owner", kind, nodeName, range.from, range.to]);
}

export function liveMdSemanticSource(
  matchKind: string | null,
  node: SyntaxNode,
  patternIndex: number | null,
  captures: readonly LiveMdSemanticCapture[],
  properties: LiveMdSemanticSource["properties"],
): LiveMdSemanticSource {
  return {
    captures,
    matchKind,
    nodeName: node.name,
    patternIndex,
    properties,
  };
}

export function liveMdSemanticCaptures(match: {
  captures: readonly { name: string; node: SyntaxNode; patternIndex: number }[];
}) {
  return match.captures.map((capture) => ({
    name: capture.name,
    nodeName: capture.node.name,
    patternIndex: capture.patternIndex,
    range: { from: capture.node.from, to: capture.node.to },
  }));
}

export function mapPreviousLiveMdSemanticUnits(
  units: readonly LiveMdSemanticUnit[],
  changes: ChangeDesc,
  state: EditorState,
) {
  let mapped: LiveMdSemanticUnit[] = [];
  for (let unit of units) {
    let next = mapPreviousLiveMdSemanticUnit(unit, changes, state);
    if (next) mapped.push(next);
  }
  return mapped;
}

export function mapPreviousLiveMdSemanticUnit(
  unit: LiveMdSemanticUnit,
  changes: ChangeDesc,
  state: EditorState,
): LiveMdSemanticUnit | null {
  let mappedRange = mapLiveMdRange(unit.range, changes, state);
  let mappedOwnerRange = mapLiveMdRange(unit.ownerRange, changes, state);
  if (!mappedRange || !mappedOwnerRange) return null;

  let mapped = {
    ...unit,
    captures: unit.captures
      .map((capture) => mapLiveMdSemanticCapture(capture, changes, state))
      .filter((capture): capture is LiveMdSemanticCapture => !!capture),
    ownerRange: mappedOwnerRange,
    previousId: unit.id,
    range: mappedRange,
  } as Record<string, unknown>;

  for (let property of rangeProperties) {
    let value = mapped[property];
    if (!isLiveMdDocRange(value)) continue;
    mapped[property] = mapLiveMdRange(value, changes, state);
  }
  for (let property of rangeArrayProperties) {
    let value = mapped[property];
    if (!Array.isArray(value)) continue;
    mapped[property] = value
      .map((range) => (isLiveMdDocRange(range) ? mapLiveMdRange(range, changes, state) : null))
      .filter((range): range is LiveMdDocRange => !!range);
  }

  mapped.ownerId = liveMdOwnerId(unit.kind, mappedOwnerRange, unit.source.nodeName);
  mapped.id = createLiveMdUnitId([
    "unit",
    unit.kind,
    unit.source.nodeName,
    mappedRange.from,
    mappedRange.to,
    unit.signature,
  ]);

  return mapped as LiveMdSemanticUnit;
}

function mapLiveMdSemanticCapture(
  capture: LiveMdSemanticCapture,
  changes: ChangeDesc,
  state: EditorState,
): LiveMdSemanticCapture | null {
  let range = mapLiveMdRange(capture.range, changes, state);
  return range ? { ...capture, range } : null;
}

function isLiveMdDocRange(value: unknown): value is LiveMdDocRange {
  return (
    typeof value == "object" &&
    value != null &&
    typeof (value as LiveMdDocRange).from == "number" &&
    typeof (value as LiveMdDocRange).to == "number"
  );
}

function liveMdIdPart(value: unknown): string {
  if (value == null) return "";
  if (typeof value == "string") return value.replace(/[|\\]/gu, "\\$&");
  if (typeof value == "number" || typeof value == "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(liveMdIdPart).join(",")}]`;
  if (typeof value == "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${liveMdIdPart(key)}:${liveMdIdPart(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
