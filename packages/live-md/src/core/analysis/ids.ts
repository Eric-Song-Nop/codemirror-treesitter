import type { ChangeDesc, EditorState } from "@codemirror/state";
import type { SyntaxNode } from "@codemirror-treesitter/language";
import { mapLiveMdRange, mapLiveMdRangeWithAssoc } from "./ranges.js";
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
): readonly LiveMdSemanticUnit[] {
  let mapped: LiveMdSemanticUnit[] = [];
  let changed = false;
  for (let unit of units) {
    let next = mapPreviousLiveMdSemanticUnit(unit, changes, state);
    if (!next) {
      changed = true;
      continue;
    }
    if (next !== unit) changed = true;
    mapped.push(next);
  }
  return changed ? mapped : units;
}

export function mapPreviousLiveMdSemanticUnit(
  unit: LiveMdSemanticUnit,
  changes: ChangeDesc,
  state: EditorState,
): LiveMdSemanticUnit | null {
  let mappedRange = mapPreviousLiveMdUnitRange(unit, changes, state);
  let mappedOwnerRange = mapPreviousLiveMdUnitOwnerRange(unit, changes, state);
  if (!mappedRange || !mappedOwnerRange) return null;

  let captures = unit.captures
    .map((capture) => mapLiveMdSemanticCapture(capture, changes, state))
    .filter((capture): capture is LiveMdSemanticCapture => !!capture);
  let changed =
    !sameLiveMdDocRange(unit.range, mappedRange) ||
    !sameLiveMdDocRange(unit.ownerRange, mappedOwnerRange) ||
    !sameLiveMdSemanticCaptures(unit.captures, captures);
  let mapped = {
    ...unit,
    captures,
    ownerRange: mappedOwnerRange,
    previousId: unit.id,
    range: mappedRange,
  } as Record<string, unknown>;

  for (let property of rangeProperties) {
    let value = mapped[property];
    if (!isLiveMdDocRange(value)) continue;
    let next = mapLiveMdRange(value, changes, state);
    if (!sameLiveMdNullableDocRange(value, next)) changed = true;
    mapped[property] = next;
  }
  for (let property of rangeArrayProperties) {
    let value = mapped[property];
    if (!Array.isArray(value)) continue;
    let next = value
      .map((range) => (isLiveMdDocRange(range) ? mapLiveMdRange(range, changes, state) : null))
      .filter((range): range is LiveMdDocRange => !!range);
    if (!sameLiveMdDocRangeArray(value, next)) changed = true;
    mapped[property] = next;
  }

  let signature = mapLiveMdSemanticUnitSignature(unit, mapped);
  if (signature != unit.signature) changed = true;

  if (!changed) return unit;

  mapped.signature = signature;
  mapped.ownerId = liveMdOwnerId(unit.kind, mappedOwnerRange, unit.source.nodeName);
  mapped.id = createLiveMdUnitId([
    "unit",
    unit.kind,
    unit.source.nodeName,
    mappedRange.from,
    mappedRange.to,
    signature,
  ]);

  return mapped as LiveMdSemanticUnit;
}

function mapPreviousLiveMdUnitRange(
  unit: LiveMdSemanticUnit,
  changes: ChangeDesc,
  state: EditorState,
) {
  return liveMdUnitRangeIncludesInsertionAtEnd(unit)
    ? mapLiveMdRangeWithAssoc(unit.range, changes, state, 1, 1)
    : mapLiveMdRange(unit.range, changes, state);
}

function mapPreviousLiveMdUnitOwnerRange(
  unit: LiveMdSemanticUnit,
  changes: ChangeDesc,
  state: EditorState,
) {
  return liveMdUnitRangeIncludesInsertionAtEnd(unit)
    ? mapLiveMdRangeWithAssoc(unit.ownerRange, changes, state, 1, 1)
    : mapLiveMdRange(unit.ownerRange, changes, state);
}

function liveMdUnitRangeIncludesInsertionAtEnd(unit: LiveMdSemanticUnit) {
  return (
    unit.kind == "paragraphContainer" &&
    (unit.containerKind == "document" ||
      (unit.containerKind == "block" && unit.source.nodeName == "section"))
  );
}

function mapLiveMdSemanticCapture(
  capture: LiveMdSemanticCapture,
  changes: ChangeDesc,
  state: EditorState,
): LiveMdSemanticCapture | null {
  let range = mapLiveMdRange(capture.range, changes, state);
  if (!range) return null;
  return sameLiveMdDocRange(capture.range, range) ? capture : { ...capture, range };
}

function sameLiveMdSemanticCaptures(
  left: readonly LiveMdSemanticCapture[],
  right: readonly LiveMdSemanticCapture[],
) {
  if (left.length != right.length) return false;
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function sameLiveMdNullableDocRange(left: LiveMdDocRange | null, right: LiveMdDocRange | null) {
  if (!left || !right) return left == right;
  return sameLiveMdDocRange(left, right);
}

function sameLiveMdDocRangeArray(left: readonly unknown[], right: readonly LiveMdDocRange[]) {
  if (left.length != right.length) return false;
  for (let index = 0; index < left.length; index++) {
    let leftRange = left[index];
    let rightRange = right[index]!;
    if (!isLiveMdDocRange(leftRange) || !sameLiveMdDocRange(leftRange, rightRange)) return false;
  }
  return true;
}

function sameLiveMdDocRange(left: LiveMdDocRange, right: LiveMdDocRange) {
  return left.from == right.from && left.to == right.to;
}

function mapLiveMdSemanticUnitSignature(unit: LiveMdSemanticUnit, mapped: Record<string, unknown>) {
  if (unit.kind != "paragraphContainer") return unit.signature;
  let childRange = mapped.childRange;
  if (!isLiveMdDocRange(childRange)) return unit.signature;
  let childName = liveMdParagraphContainerSignatureChildName(unit.signature);
  if (!childName) return unit.signature;
  return liveMdUnitSignature([
    "paragraphContainer",
    unit.containerKind,
    childName,
    childRange.from,
    childRange.to,
  ]);
}

function liveMdParagraphContainerSignatureChildName(signature: string) {
  let parts = signature.split("|");
  return parts[0] == "paragraphContainer" && parts.length == 5 ? parts[2] : null;
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
